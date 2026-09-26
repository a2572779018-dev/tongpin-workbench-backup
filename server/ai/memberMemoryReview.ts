import { AI_MEMORY_LIMITS, AI_MEMORY_TARGETS, type AiMemoryReviewChanges, type AiMemoryTarget } from "../../shared/aiMemory";
import { rejectMemoryContent } from "./memberMemorySafety";
import { applyMemoryBatch, MEMBER_MEMORY_TARGET_NAMES, memoryCharLength, memoryLimit, normalizeMemoryEntry, type MemoryBatchOperation } from "./memberMemoryStore";

export interface MemberMemoryReviewOperation {
  target: AiMemoryTarget;
  action: "add" | "replace" | "remove";
  content?: string;
  oldText?: string;
}

export type ParsedMemberMemoryReview =
  | { ok: true; operations: MemberMemoryReviewOperation[]; invalid: number }
  | { ok: false; error: "empty" | "not_json" | "shape" | "too_many" };

const NOTHING_TO_SAVE = /^(?:nothing to save\.?|无需保存。?|没有需要保存的内容。?|无。?)$/i;

/**
 * Strict JSON contract `{"operations":[...]}`. A Markdown fence around the
 * object is tolerated; prose, arrays, extra top-level shapes or grossly
 * oversized batches are rejected. Individually malformed operations are
 * dropped and counted, never guessed.
 */
export function parseMemberMemoryReview(content: string): ParsedMemberMemoryReview {
  const trimmed = content.trim();
  if (!trimmed) return { ok: false, error: "empty" };
  if (NOTHING_TO_SAVE.test(trimmed)) return { ok: true, operations: [], invalid: 0 };
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1] : trimmed;
  if (!body.startsWith("{") || !body.endsWith("}")) return { ok: false, error: "not_json" };
  let root: unknown;
  try { root = JSON.parse(body); } catch { return { ok: false, error: "not_json" }; }
  if (!root || typeof root !== "object" || Array.isArray(root) || !Array.isArray((root as { operations?: unknown }).operations)) return { ok: false, error: "shape" };
  const raw = (root as { operations: unknown[] }).operations;
  if (raw.length > AI_MEMORY_LIMITS.reviewOperations * 2) return { ok: false, error: "too_many" };
  const operations: MemberMemoryReviewOperation[] = [];
  let invalid = Math.max(0, raw.length - AI_MEMORY_LIMITS.reviewOperations);
  for (const item of raw.slice(0, AI_MEMORY_LIMITS.reviewOperations)) {
    const op = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
    const target = op?.target, action = op?.action;
    // Hermes accepts `new_text` as an alias of `content`; `content` wins.
    const rawContent = typeof op?.content === "string" ? op.content : typeof op?.new_text === "string" ? op.new_text : undefined;
    const rawOld = typeof op?.old_text === "string" ? op.old_text : undefined;
    if (!op || !AI_MEMORY_TARGETS.includes(target as AiMemoryTarget) || (action !== "add" && action !== "replace" && action !== "remove")) { invalid += 1; continue; }
    const contentText = rawContent === undefined ? undefined : normalizeMemoryEntry(rawContent.slice(0, AI_MEMORY_LIMITS.entryCharacters * 4));
    const oldText = rawOld === undefined ? undefined : normalizeMemoryEntry(rawOld.slice(0, AI_MEMORY_LIMITS.entryCharacters * 4));
    const needsContent = action !== "remove", needsOld = action !== "add";
    if ((needsContent && (!contentText || memoryCharLength(contentText) > AI_MEMORY_LIMITS.entryCharacters))
      || (needsOld && (!oldText || memoryCharLength(oldText) > AI_MEMORY_LIMITS.entryCharacters))) { invalid += 1; continue; }
    operations.push({ target: target as AiMemoryTarget, action, ...(needsContent ? { content: contentText } : {}), ...(needsOld ? { oldText } : {}) });
  }
  return { ok: true, operations, invalid };
}

/** Explicit member requests. `forget` wins: it is the only cue that unlocks removals. */
const FORGET_CUE = /(?:忘掉|忘了(?:它|这|吧|这件事|这条)|(?:请|帮我)?忘记(?:我|关于|这|掉|刚才|之前|那)|别(?:再)?记(?!错|混|反|漏|得)|不要(?:再)?记(?!错|混|反|漏|得)|不用记|不必记|删(?:除|掉)[^。！？!?\n]{0,20}(?:记忆|记住的|记下的)|清(?:除|空)[^。！？!?\n]{0,20}记忆|\bforget\s+(?:that|this|about|it|my|what|everything)\b)/i;
const REMEMBER_CUE = /(?:记住|记下|记一下|记着|帮我记|请记得|要记得|别忘了|不要忘了|(?:以后|今后|往后)(?!再说|再议|再看|再聊|有空|有机会|有时间)|从现在(?:起|开始)|下次(?:请|记得|要|别|不要|开始)|别再|不要再|不用再|每次都|一律|\bremember\b|\bfrom now on\b|\bgoing forward\b|\bnext time\b|\bnever again\b|\bdon'?t ever\b)/i;

export function detectMemoryCue(text: string): "none" | "remember" | "forget" {
  if (FORGET_CUE.test(text)) return "forget";
  if (REMEMBER_CUE.test(text)) return "remember";
  return "none";
}

const TRIVIAL_TURN = /^(?:你好|您好|哈喽|嗨|hi|hello|hey|早上好|中午好|下午好|晚上好|早安|晚安|谢谢|多谢|感谢|谢了|谢谢你|thanks?|thank you|thx|好的|好|好滴|好嘞|行|可以|收到|明白|了解|知道了|ok|okay|嗯+|哦+|噢+|对|对的|是的|没问题|继续|接着说|go on|再见|拜拜|bye)[\s!！。.,，~～?？]*$/i;

/** Greetings, acknowledgements and very short exchanges never reach a paid reviewer. */
export function isTrivialMemoryTurn(memberText: string, reply: string): boolean {
  const member = memberText.trim();
  if (TRIVIAL_TURN.test(member)) return true;
  const memberLength = memoryCharLength(member);
  return memberLength < 6 || memberLength + memoryCharLength(reply.trim()) < 30;
}

export type MemberMemoryDropReason = "secret" | "unsafe" | "remove_blocked" | "invalid" | "no_match" | "ambiguous" | "stale" | "empty_store" | "overflow";

export interface MemberMemoryReviewPlan {
  stores: Record<AiMemoryTarget, string[]>;
  changes: AiMemoryReviewChanges;
  /** Targets whose batch did not fit; their entries were left untouched. */
  overflow: Array<{ target: AiMemoryTarget; message: string }>;
  dropped: Partial<Record<MemberMemoryDropReason, number>>;
}

/**
 * Validate, filter and apply one review against the current stores.
 *
 * Every add/replace passes the deterministic secret and threat filters. As in
 * Hermes' unattended-review delete gate, a background review may not delete
 * entries on its own initiative: `remove` is kept only when the member
 * explicitly asked to forget, or when the batch would not fit without it
 * (consolidation to make room). Each target is applied independently and
 * atomically against its final budget; an overflowing target is reported for
 * the single consolidation retry instead of silently dropping entries.
 */
export function planMemberMemoryReview(
  current: Readonly<Record<AiMemoryTarget, readonly string[]>>,
  operations: readonly MemberMemoryReviewOperation[],
  options: { cue: "none" | "remember" | "forget"; targets?: readonly AiMemoryTarget[] },
): MemberMemoryReviewPlan {
  const plan: MemberMemoryReviewPlan = { stores: { memory: [...current.memory], user: [...current.user] }, changes: { added: 0, updated: 0, removed: 0 }, overflow: [], dropped: {} };
  const drop = (reason: MemberMemoryDropReason, count = 1) => { if (count > 0) plan.dropped[reason] = (plan.dropped[reason] ?? 0) + count; };
  for (const target of options.targets ?? AI_MEMORY_TARGETS) {
    let ops: MemoryBatchOperation[] = [];
    for (const operation of operations.filter(item => item.target === target)) {
      if (operation.content !== undefined) {
        const rejection = rejectMemoryContent(operation.content);
        if (rejection) { drop(rejection.code === "AI_MEMORY_SECRET" ? "secret" : "unsafe"); continue; }
      }
      ops.push({ action: operation.action, content: operation.content, oldText: operation.oldText });
    }
    if (!ops.length) continue;
    const label = MEMBER_MEMORY_TARGET_NAMES[target];
    const limit = memoryLimit(target);
    if (options.cue !== "forget" && ops.some(op => op.action === "remove")) {
      const withoutRemovals = ops.filter(op => op.action !== "remove");
      const probe = withoutRemovals.length ? applyMemoryBatch(current[target], withoutRemovals, limit, { label, mode: "skipInvalid" }) : undefined;
      if (!probe || probe.ok) {
        drop("remove_blocked", ops.length - withoutRemovals.length);
        ops = withoutRemovals;
        if (!ops.length) continue;
      }
    }
    const result = applyMemoryBatch(current[target], ops, limit, { label, mode: "skipInvalid", allowEmptying: options.cue === "forget" });
    if (!result.ok) {
      if (result.code === "overflow") plan.overflow.push({ target, message: result.message });
      else drop(result.code === "empty_store" ? "empty_store" : "invalid");
      continue;
    }
    for (const skipped of result.skipped) drop(skipped.code === "no_match" || skipped.code === "ambiguous" || skipped.code === "stale" ? skipped.code : "invalid");
    plan.stores[target] = result.entries;
    plan.changes.added += result.added;
    plan.changes.updated += result.updated;
    plan.changes.removed += result.removed;
  }
  return plan;
}

export function memoryReviewChanged(changes: AiMemoryReviewChanges): boolean {
  return changes.added + changes.updated + changes.removed > 0;
}
