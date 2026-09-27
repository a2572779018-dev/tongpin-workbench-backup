import { AI_BUSINESS_TIERS, type AiChatRequest, type AiChatResponse, type AiMode } from "../../shared/ai";
import { isTongpinQuickAgent } from "../../shared/aiAuto";
import type { AiPersonaProfile } from "../../shared/aiPersona";
import {
  AI_MEMORY_LIMITS, AI_MEMORY_PRICE_MAX, AI_MEMORY_TARGETS, type AiMemoryAdminSettings, type AiMemoryAdminStats, type AiMemoryEntryOperation,
  type AiMemoryReviewStatus, type AiMemoryState, type AiMemoryTarget,
} from "../../shared/aiMemory";
import { routeChatProvider } from "./autoRouting";
import type { AiHarness } from "./harness";
import { buildMemberMemoryReviewPayload, MEMBER_MEMORY_REVIEW_INSTRUCTIONS, memberMemoryNonce, renderMemberMemoryPrompt, withMemberLearningPrompt, withMemberMemoryPrompt, type MemberMemoryReviewTurn } from "./memberMemoryPrompt";
import { AiMemberHistoryIndex, historySourceFromState, MEMBER_HISTORY_LIMITS, memberHistoryEligible } from "./memberHistoryIndex";
import { AiMemberLearning, memberTurnText, recallTenants, registerMemberHistoryObserver, type MemberReviewContext } from "./memberLearning";
import { AiWorkspaceRepository, validateAiWorkspaceConversationEntity } from "./workspace";
import { currentWorkspaceVersion } from "./workspaceCurrentReads";
import { AiWorkspaceV2Store } from "./workspaceV2Store";
import type { AiMemoryRecallEvent } from "../../shared/aiMemoryLearning";
import { detectMemoryCue, isTrivialMemoryTurn, memoryReviewChanged, parseMemberMemoryReview, planMemberMemoryReview, type MemberMemoryReviewOperation } from "./memberMemoryReview";
import { rejectMemoryContent } from "./memberMemorySafety";
import {
  AiMemberMemoryRepository, applyMemoryBatch, MEMBER_MEMORY_TARGET_NAMES, memoryCharLength, memoryLimit, memoryUsage, normalizeMemoryEntry,
  parseMemoryAdminSettings, type MemberMemoryReviewRow, type StoredMemberMemory,
} from "./memberMemoryStore";
import { verifiedBaiAgentModels } from "./modelVerification";
import { AiPersonaRepository } from "./persona";
import { parseProviderResult, readProviderHttpError, readProviderResponse, type AiTransport } from "./provider";
import { AiError, type SecretBox } from "./security";
import type { AiBackgroundPrincipalCheck } from "./service";
import type { AiStore, StoredProvider } from "./storage";
import { tenantStorageValue } from "./tenant";

/** Implicit (non-explicit) reviews per member are spaced out; explicit cues are not. */
export const MEMBER_MEMORY_MIN_REVIEW_INTERVAL_MS = 30_000;
/** Hard ceiling on background reviews per member per rolling 24 hours. */
export const MEMBER_MEMORY_DAILY_REVIEW_LIMIT = 40;
/** A captured prompt block stays frozen for this long within one conversation. */
export const MEMBER_MEMORY_SNAPSHOT_TTL_MS = 6 * 60 * 60_000;
const REVIEW_LEASE_MS = 3 * 60_000;
const REVIEW_TIMEOUT_MS = 45_000;
const REVIEW_MAX_ATTEMPTS = 2;
const REVIEW_RETRY_DELAY_MS = 60_000;
const REVIEW_OUTPUT_TOKENS = 1024;
/** A review that may also propose a skill needs room for its instructions. */
const REVIEW_WITH_SKILL_OUTPUT_TOKENS = 1536;
/** Reconcile workspace revisions with the history index at most this often (per database handle). */
const HISTORY_RECONCILE_MS = 60 * 60_000;
const historyReconciledAt = new WeakMap<object, number>();
const DAY_MS = 24 * 60 * 60_000;
const REQUEST_ID = /^[a-zA-Z0-9_-]{16,100}$/;

export interface AiBackgroundMemoryCycle { scanned: number; processed: number; failed: number; history?: { synced: number; purged: number } }

/**
 * In-process start of accepted reviews. The journal row is the source of
 * truth: if this early start is lost (restart, eviction), the scheduled
 * background cycle picks the row up. Tests can await `idle()`.
 */
const inFlight = new Set<Promise<void>>();
export const memberMemoryRuntime = {
  /** Set false to leave accepted reviews to the background cycle only. */
  startImmediately: true,
  schedule(task: () => Promise<void>): void {
    if (!memberMemoryRuntime.startImmediately) return;
    // A macrotask: the reply is fully returned before any review work starts.
    const promise = new Promise<void>(resolve => setTimeout(resolve, 0)).then(task).catch(() => undefined).finally(() => { inFlight.delete(promise); });
    inFlight.add(promise);
  },
  async idle(): Promise<void> {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
  },
};

function record(value: unknown, keys: readonly string[], message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AiError(400, "AI_MEMORY_INVALID", message);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) throw new AiError(400, "AI_MEMORY_INVALID", "提交内容包含不支持的字段，请更新客户端");
  return result;
}
function target(value: unknown): AiMemoryTarget {
  if (!AI_MEMORY_TARGETS.includes(value as AiMemoryTarget)) throw new AiError(400, "AI_MEMORY_INVALID", "请选择要修改的记忆分类");
  return value as AiMemoryTarget;
}
function memberContent(value: unknown): string {
  if (typeof value !== "string" || value.length > AI_MEMORY_LIMITS.entryCharacters * 8) throw new AiError(400, "AI_MEMORY_INVALID", "记忆内容格式不正确");
  const content = normalizeMemoryEntry(value);
  if (!content) throw new AiError(400, "AI_MEMORY_INVALID", "记忆内容不能为空");
  if (memoryCharLength(content) > AI_MEMORY_LIMITS.entryCharacters) throw new AiError(400, "AI_MEMORY_ENTRY_TOO_LONG", `单条记忆最多 ${AI_MEMORY_LIMITS.entryCharacters} 个字，请精简后再保存`);
  const rejection = rejectMemoryContent(content);
  if (rejection?.code === "AI_MEMORY_SECRET") throw new AiError(400, "AI_MEMORY_SECRET", "为保护账号安全，记忆里不能保存密码、密钥、验证码或证件、银行卡、账号号码等敏感信息");
  if (rejection) throw new AiError(400, "AI_MEMORY_UNSAFE", "这段内容像是给 AI 的指令或可疑文字，不能保存为记忆；请改成描述你自己的事实或偏好");
  return content;
}

/** `requestIds=a,b,c` → bounded list; each id is validated by `reviewStatuses`. */
export function memoryReviewIds(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  if (value.length > AI_MEMORY_LIMITS.reviewStatusBatch * 101) throw new AiError(400, "AI_MEMORY_INVALID", "请求编号过多");
  return value.split(",").filter(Boolean);
}

/** Only these requests read member memory; tool continuations and local computer
 * plans never do — neither the legacy per-action plan nor the unified executor's
 * task spec, which must come from the member's instruction alone. */
function readsMemory(request: AiChatRequest): boolean {
  return !request.skillIds?.includes("agent-continuation-v1") && request.outputFormat !== "computer_plan" && request.outputFormat !== "computer_task";
}

type ReviewTarget = { provider: StoredProvider; model: string; encryptedKey: string; maxOutputTokens: number; skillOutputTokens: number };
type ReviewCall = { content: string; inputTokens: number; outputTokens: number };

async function idempotencyKey(...parts: Array<string | number>): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["memory-review-v1", ...parts])));
  return `tongpin-memory-${Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("")}`;
}

export interface AiMemberMemoryDeps {
  store: AiStore;
  harness: AiHarness;
  box: () => Promise<SecretBox>;
  transport: AiTransport;
  isPrincipalActive: AiBackgroundPrincipalCheck;
}

/**
 * Hermes-style learning loop for 同频 AI (NousResearch Hermes Agent
 * `agent/background_review.py`, adapted): after a completed, non-trivial reply
 * a journaled review runs off the reply path, asks a cheap model whether any
 * memory should be saved or updated, validates and filters the structured
 * operations, and applies them to the member's bounded stores. Hermes forks
 * its Python agent with a memory tool loop; Tongpin runs in a Worker/Express
 * pair, so the review is one strict-JSON call plus at most one consolidation
 * retry on overflow.
 */
export class AiMemberMemoryService {
  readonly repository: AiMemberMemoryRepository;
  /** History recall and personal skills (Hermes session_search / skills, adapted). */
  readonly learning: AiMemberLearning;
  constructor(private readonly deps: AiMemberMemoryDeps) {
    this.repository = new AiMemberMemoryRepository(deps.store.sql, deps.store.tenantId);
    this.learning = new AiMemberLearning(deps.store.sql, deps.store.tenantId);
    // Index each committed workspace save (once per database handle).
    registerMemberHistoryObserver(deps.store.sql);
  }

  // ---------------------------------------------------------------- member API
  private view(stored: StoredMemberMemory, settings: AiMemoryAdminSettings, userId?: string): AiMemoryState {
    const store = (target: AiMemoryTarget) => ({ target, entries: [...stored[target]], usedCharacters: memoryUsage(stored[target]), limitCharacters: memoryLimit(target) });
    let learning: ReturnType<AiMemberLearning["view"]> | undefined;
    if (userId) { try { learning = this.learning.view(userId, settings); } catch { learning = undefined; } }
    return {
      revision: stored.revision, available: settings.enabled, learningEnabled: stored.learningEnabled, pricePoints: settings.pricePoints,
      stores: { memory: store("memory"), user: store("user") }, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy,
      ...(learning ? { recall: learning.recall, skills: learning.skills } : {}),
    };
  }
  state(userId: string): AiMemoryState {
    this.deps.store.assertAccess(userId);
    return this.view(this.repository.read(userId), this.repository.settings(), userId);
  }
  updateEntry(userId: string, body: unknown): AiMemoryState {
    this.deps.store.assertAccess(userId);
    const p = record(body, ["expectedRevision", "operation"], "请提交完整的记忆修改");
    if (!Number.isSafeInteger(p.expectedRevision) || Number(p.expectedRevision) < 0) throw new AiError(400, "AI_MEMORY_INVALID", "记忆版本无效，请刷新后重试");
    const raw = record(p.operation, ["action", "target", "content", "index", "expectedEntry"], "请提交有效的记忆操作");
    const settings = this.repository.settings();
    const operation = ((): AiMemoryEntryOperation => {
      const storeTarget = target(raw.target);
      if (raw.action === "add") return { action: "add", target: storeTarget, content: memberContent(raw.content) };
      if (raw.action !== "replace" && raw.action !== "remove") throw new AiError(400, "AI_MEMORY_INVALID", "记忆操作类型不正确");
      if (!Number.isSafeInteger(raw.index) || Number(raw.index) < 0 || typeof raw.expectedEntry !== "string") throw new AiError(400, "AI_MEMORY_INVALID", "请选择要修改的记忆条目");
      return raw.action === "replace"
        ? { action: "replace", target: storeTarget, index: Number(raw.index), expectedEntry: raw.expectedEntry, content: memberContent(raw.content) }
        : { action: "remove", target: storeTarget, index: Number(raw.index), expectedEntry: raw.expectedEntry };
    })();
    // A disabled organization keeps read/delete so members can always remove their data.
    if (!settings.enabled && operation.action !== "remove") throw new AiError(403, "AI_MEMORY_DISABLED", "管理员已关闭记忆功能；你仍可查看和删除已有记忆");
    const stored = this.deps.store.sql.transaction(() => {
      const current = this.repository.read(userId);
      if (current.revision !== p.expectedRevision) throw new AiError(409, "AI_MEMORY_CONFLICT", "记忆刚刚已在其他地方更新，本次未覆盖；已为你刷新，请再试一次");
      const entries = current[operation.target];
      if (operation.action !== "add" && entries[operation.index] !== operation.expectedEntry) throw new AiError(409, "AI_MEMORY_CONFLICT", "这条记忆已经变化，本次未修改；请刷新后再试");
      const result = applyMemoryBatch(entries, [operation.action === "add"
        ? { action: "add", content: operation.content }
        : { action: operation.action, oldText: operation.expectedEntry, matchedEntry: operation.expectedEntry, ...(operation.action === "replace" ? { content: operation.content } : {}) }],
      memoryLimit(operation.target), { label: MEMBER_MEMORY_TARGET_NAMES[operation.target], allowEmptying: true });
      if (!result.ok) {
        if (result.code === "overflow") throw new AiError(409, "AI_MEMORY_FULL", `「${MEMBER_MEMORY_TARGET_NAMES[operation.target]}」已写满（${result.usage} 字），请先删除或精简几条再保存`);
        throw new AiError(409, "AI_MEMORY_CONFLICT", "这条记忆已经变化，本次未修改；请刷新后再试");
      }
      const next = this.repository.write(userId, current.revision, { ...current, [operation.target]: result.entries }, "member");
      // Member edits take effect immediately, including in open conversations.
      this.repository.deleteSnapshots(userId);
      return next;
    });
    return this.view(stored, settings, userId);
  }
  setLearning(userId: string, body: unknown): AiMemoryState {
    this.deps.store.assertAccess(userId);
    const p = record(body, ["learningEnabled"], "请提交有效的记忆开关");
    if (typeof p.learningEnabled !== "boolean") throw new AiError(400, "AI_MEMORY_INVALID", "记忆开关格式不正确");
    const now = Date.now();
    let changed = false;
    const stored = this.deps.store.sql.transaction(() => {
      const current = this.repository.read(userId);
      if (current.learningEnabled === p.learningEnabled) return current;
      changed = true;
      // The revision bump also cancels any in-flight review at its compare-and-set.
      const next = this.repository.write(userId, current.revision, { ...current, learningEnabled: p.learningEnabled as boolean }, "member");
      this.repository.deleteSnapshots(userId);
      if (!p.learningEnabled) this.deps.store.sql.exec("UPDATE ai_member_memory_reviews SET status='skipped',reason='learning_off',updated_at=? WHERE tenant_id=? AND user_id=? AND status='queued'", now, this.repository.tenantId, this.repository.userKey(userId));
      return next;
    });
    if (changed) {
      try {
        // Off: history stops matching at once and is deleted in the background.
        // On: the member's existing conversations are indexed again (unless a
        // clear-all asked for them to stay forgotten).
        if (!p.learningEnabled) this.learning.history.reset(userId, this.learning.history.mode(userId) === "baseline" ? "baseline" : "sync");
        else if (this.repository.settings().enabled) this.learning.history.enqueue(userId, "backfill");
      } catch { /* The index is derived data; the switch itself has been saved. */ }
    }
    return this.view(stored, this.repository.settings(), userId);
  }
  /**
   * Clear-all: memory, prompt snapshots, the review journal, personal skills
   * and recall activity. Conversations stay where they are, but what existed
   * at this moment is no longer searchable by recall (only later messages are).
   */
  clear(userId: string): AiMemoryState {
    this.deps.store.assertAccess(userId);
    const stored = this.deps.store.sql.transaction(() => {
      const next = this.repository.clear(userId, Date.now());
      this.learning.skills.clear(userId);
      this.learning.activity.clear(userId);
      return next;
    });
    try {
      this.learning.history.reset(userId, "baseline");
      this.recordHistoryBaseline(userId);
    } catch { /* A failed baseline is retried by the background queue. */ }
    return this.view(stored, this.repository.settings(), userId);
  }
  /** After a clear-all: record the existing V1 messages as seen (not indexed). V2 accounts go through the queue. */
  private recordHistoryBaseline(userId: string): void {
    if (!memberHistoryEligible(this.deps.store.sql, this.repository.tenantId, userId)) return;
    if (currentWorkspaceVersion(this.deps.store, userId) !== 1) { this.learning.history.enqueue(userId, "baseline"); return; }
    const snapshot = new AiWorkspaceRepository(this.deps.store.sql).read(userId, this.repository.tenantId);
    this.learning.history.sync(userId, { conversations: historySourceFromState(snapshot.state), full: true, version: 1, revision: snapshot.revision, live: false, budget: { messages: Number.MAX_SAFE_INTEGER, characters: Number.MAX_SAFE_INTEGER } });
  }
  reviewStatuses(userId: string, requestIds: unknown): AiMemoryReviewStatus[] {
    this.deps.store.assertAccess(userId);
    if (!Array.isArray(requestIds) || requestIds.length > AI_MEMORY_LIMITS.reviewStatusBatch || requestIds.some(id => typeof id !== "string" || !REQUEST_ID.test(id))) {
      throw new AiError(400, "AI_MEMORY_INVALID", "请求编号格式不正确");
    }
    const ids = [...new Set(requestIds as string[])];
    const statuses = this.repository.reviewStatuses(userId, ids);
    let activities = new Map<string, NonNullable<AiMemoryReviewStatus["activity"]>>();
    try { activities = this.learning.activity.activities(userId, ids); } catch { /* counts only; optional */ }
    return statuses.map(status => {
      const activity = activities.get(status.requestId);
      return activity && (activity.recalled > 0 || activity.trigger || activity.skills.length) ? { ...status, activity } : status;
    });
  }

  // ----------------------------------------------------- recall and skills API
  /** Excerpts one reply used, for the member who owns it only. */
  recallDetail(userId: string, requestId: unknown): AiMemoryRecallEvent | null {
    this.deps.store.assertAccess(userId);
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw new AiError(400, "AI_MEMORY_INVALID", "请求编号格式不正确");
    return this.learning.activity.detail(userId, requestId);
  }
  /** Adopted personal skills for the @ mention list (names only). */
  personalSkills(userId: string): { enabled: boolean; skills: Array<{ id: string; name: string; whenToUse: string }> } {
    this.deps.store.assertAccess(userId);
    const settings = this.repository.settings();
    const enabled = settings.enabled && settings.skillsEnabled;
    return { enabled, skills: enabled ? this.learning.skills.adopted(userId).map(({ id, name, whenToUse }) => ({ id, name, whenToUse })) : [] };
  }
  /** 采纳 / 编辑 / 忽略 / 删除 / 自建. Deleting stays possible while the feature is off. */
  updateSkill(userId: string, body: unknown): AiMemoryState {
    this.deps.store.assertAccess(userId);
    const settings = this.repository.settings();
    const action = body && typeof body === "object" && !Array.isArray(body) ? (body as { action?: unknown }).action : undefined;
    if (!(settings.enabled && settings.skillsEnabled) && action !== "delete" && action !== "dismiss") throw new AiError(403, "AI_MEMORY_SKILLS_DISABLED", "管理员已关闭技能学习；你仍可查看和删除已有技能");
    this.deps.store.sql.transaction(() => this.learning.skills.apply(userId, body));
    return this.view(this.repository.read(userId), settings, userId);
  }

  // ----------------------------------------------------------------- admin API
  adminView(): { settings: AiMemoryAdminSettings; stats: AiMemoryAdminStats } {
    const now = Date.now();
    const stats = this.repository.stats(now);
    try {
      const activity = this.learning.activity.stats(now - 7 * DAY_MS);
      stats.recall = { ...this.learning.history.stats(), recalls7d: activity.recalls };
      stats.skills = { ...this.learning.skills.stats(), applied7d: activity.skillUses };
    } catch { /* aggregates are optional */ }
    return { settings: this.repository.settings(), stats };
  }
  saveAdminSettings(body: unknown): { settings: AiMemoryAdminSettings; stats: AiMemoryAdminStats } {
    const p = record(body, ["enabled", "reviewTier", "pricePoints", "recallEnabled", "skillsEnabled"], "请提交完整的记忆设置");
    if (typeof p.enabled !== "boolean") throw new AiError(400, "AI_MEMORY_INVALID", "请选择是否启用记忆");
    if (!AI_BUSINESS_TIERS.includes(p.reviewTier as AiMode)) throw new AiError(400, "AI_MEMORY_INVALID", "请选择记忆整理使用的档位");
    if (!Number.isSafeInteger(p.pricePoints) || Number(p.pricePoints) < 0 || Number(p.pricePoints) > AI_MEMORY_PRICE_MAX) throw new AiError(400, "AI_MEMORY_INVALID", `每次记忆整理的折算需为 0 到 ${AI_MEMORY_PRICE_MAX.toLocaleString("en-US")} 的整数`);
    for (const key of ["recallEnabled", "skillsEnabled"] as const) if (p[key] !== undefined && typeof p[key] !== "boolean") throw new AiError(400, "AI_MEMORY_INVALID", "请选择是否启用历史回忆与技能学习");
    const before = this.repository.settings();
    // Older admin clients omit the two switches: keep what is saved.
    const settings = parseMemoryAdminSettings(p, before);
    if (settings.enabled) {
      try { this.reviewTarget(settings.reviewTier); }
      catch (error) { throw new AiError(400, "AI_MEMORY_TIER_UNAVAILABLE", `所选档位暂不能用于记忆整理：${error instanceof AiError ? error.message : "请先完成该档位的文字模型配置"}`); }
    }
    this.repository.saveSettings(settings);
    const recallBefore = before.enabled && before.recallEnabled, recallAfter = settings.enabled && settings.recallEnabled;
    try {
      // Off: every member's history index stops matching and is deleted in the background.
      if (recallBefore && !recallAfter) this.learning.history.resetTenant();
      // On: members' existing conversations are indexed by the background queue.
      if (!recallBefore && recallAfter) this.learning.history.enqueueDrift();
    } catch { /* Settings are saved; the background reconcile repairs the index. */ }
    return this.adminView();
  }

  // --------------------------------------------------------- chat integration
  /**
   * Attach the member's frozen memory block to the persona used for this
   * request. Captured once per conversation (Hermes' session-start snapshot)
   * and reused for up to six hours so the system prompt — and the provider's
   * prefix cache — stays stable while background reviews update the live
   * store. `capture=false` (preflight) never writes. Any failure means "no
   * memory", never a failed reply.
   */
  withMemory<T extends AiPersonaProfile>(persona: T, userId: string, request: AiChatRequest, capture: boolean): T {
    let settings: AiMemoryAdminSettings, stored: StoredMemberMemory;
    try {
      if (!readsMemory(request)) return persona;
      settings = this.repository.settings();
      if (!settings.enabled) return persona;
      stored = this.repository.read(userId);
    } catch {
      return persona;
    }
    let result = persona;
    try { if (stored.learningEnabled) result = withMemberMemoryPrompt(persona, this.frozenMemoryBlock(userId, request, stored, capture)); }
    catch { result = persona; }
    try {
      // Personal skills and recalled history for this request only (never frozen).
      const learning = this.learning.prepare(userId, request, { settings, learningEnabled: stored.learningEnabled, memoryText: [...stored.user, ...stored.memory].join("\n"), capture });
      return withMemberLearningPrompt(result, learning);
    } catch {
      return result;
    }
  }
  private frozenMemoryBlock(userId: string, request: AiChatRequest, stored: StoredMemberMemory, capture: boolean): string {
    const conversationId = request.conversationId ?? "legacy";
    const now = Date.now();
    // Old clients share one "legacy" scope; they get a live (unfrozen) block.
    if (conversationId !== "legacy") {
      const snapshot = this.repository.snapshot(userId, conversationId);
      if (snapshot && now - snapshot.capturedAt < MEMBER_MEMORY_SNAPSHOT_TTL_MS) return snapshot.block;
    }
    const block = renderMemberMemoryPrompt(stored, memberMemoryNonce(this.repository.tenantId, userId, conversationId, capture ? now : stored.revision));
    if (capture && conversationId !== "legacy") this.deps.store.sql.transaction(() => this.repository.saveSnapshot(userId, conversationId, block, now));
    return block;
  }

  /** Called once a reply has been settled and returned. Never throws, never awaits. */
  afterReply(userId: string, request: AiChatRequest, response: Pick<AiChatResponse, "content" | "completion" | "dispatch">): void {
    try { this.learning.commit(userId, request.requestId, response); } catch { /* informational */ }
    try {
      if (this.enqueue(userId, request, response)) memberMemoryRuntime.schedule(() => this.processReview(userId, request.requestId, { background: false }));
    } catch { /* A memory side effect must never affect the member's reply. */ }
  }
  private enqueue(userId: string, request: AiChatRequest, response: Pick<AiChatResponse, "content" | "completion" | "dispatch">): boolean {
    if (!this.repository.settings().enabled) return false;
    if (request.skillIds?.includes("agent-continuation-v1") || request.retryMode === "continue") return false;
    if (request.outputFormat && request.outputFormat !== "text" && request.outputFormat !== "dispatch") return false;
    if ((response.dispatch && response.dispatch.kind !== "text") || response.completion?.state === "partial") return false;
    const status = this.deps.store.request(userId, request.requestId)?.status;
    if (status !== "completed" && status !== "uncertain") return false;
    if (!this.repository.read(userId).learningEnabled) return false;
    const memberText = request.messages.filter(message => message.role === "user").at(-1)?.content ?? "";
    const cue = detectMemoryCue(memberText);
    if (cue === "none" && isTrivialMemoryTurn(memberText, response.content)) return false;
    const now = Date.now();
    return this.deps.store.sql.transaction(() => {
      const recent = this.repository.reviewsSince(userId, now - DAY_MS);
      if (recent.count >= MEMBER_MEMORY_DAILY_REVIEW_LIMIT) return false;
      if (cue === "none" && recent.lastCreatedAt !== null && now - recent.lastCreatedAt < MEMBER_MEMORY_MIN_REVIEW_INTERVAL_MS) return false;
      return this.repository.insertReview(userId, request.requestId, request.conversationId ?? "legacy", cue, now);
    });
  }

  // ------------------------------------------------------------ review engine
  private reviewTarget(tier: AiMode): ReviewTarget {
    const saved = this.deps.store.provider();
    const route = this.deps.harness.resolve(tier, saved, "chat");
    let provider = this.deps.harness.asProvider(route, saved);
    let model = route.modelId;
    if (route.legacy) {
      if (!saved?.enabled) throw new AiError(503, "AI_NOT_CONFIGURED", "管理员尚未启用 AI 服务");
      const probe: AiChatRequest = { requestId: "memory-review-route", mode: tier, messages: [{ role: "user", content: "整理记忆" }] };
      provider = routeChatProvider(saved, probe, isTongpinQuickAgent(saved.quickModel) ? verifiedBaiAgentModels(saved) : null);
      model = tier === "deep" || tier === "pro" ? provider.deepModel : provider.quickModel;
    }
    return { provider, model, encryptedKey: route.encryptedKey, maxOutputTokens: Math.max(256, Math.min(route.maxOutputTokens, REVIEW_OUTPUT_TOKENS)),
      skillOutputTokens: Math.max(256, Math.min(route.maxOutputTokens, REVIEW_WITH_SKILL_OUTPUT_TOKENS)) };
  }
  private async callReviewer(target: ReviewTarget, payload: string, key: string): Promise<ReviewCall> {
    const { provider, model } = target;
    const apiKey = await (await this.deps.box()).decrypt(target.encryptedKey);
    const responses = provider.protocol === "responses";
    const body = responses
      ? { model, instructions: MEMBER_MEMORY_REVIEW_INSTRUCTIONS, input: [{ role: "user", content: payload }], max_output_tokens: target.maxOutputTokens, stream: true, store: false }
      : { model, messages: [{ role: "system", content: MEMBER_MEMORY_REVIEW_INSTRUCTIONS }, { role: "user", content: payload }],
        ...(new URL(provider.baseUrl).hostname === "api.b.ai" ? { max_tokens: target.maxOutputTokens } : { max_completion_tokens: target.maxOutputTokens }), stream: false };
    const response = await this.deps.transport(`${provider.baseUrl}/${responses ? "responses" : "chat/completions"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: responses ? "text/event-stream, application/json" : "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS), maxResponseBytes: 512 * 1024,
    });
    if (!response.ok) throw await readProviderHttpError(response, "chat");
    const result = parseProviderResult(await readProviderResponse(response), provider.protocol);
    return { content: result.content, inputTokens: result.usage?.inputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0 };
  }
  private reviewTurns(userId: string, requestId: string, reply: string): MemberMemoryReviewTurn[] | null {
    const snapshot = this.deps.store.requestSnapshot(userId, requestId) as { messages?: unknown } | undefined;
    if (!snapshot || !Array.isArray(snapshot.messages)) return null;
    const messages = snapshot.messages.flatMap((item): MemberMemoryReviewTurn[] => {
      const message = item as { role?: unknown; content?: unknown };
      return (message.role === "user" || message.role === "assistant") && typeof message.content === "string" ? [{ role: message.role, content: message.content }] : [];
    });
    if (messages.at(-1)?.role !== "user") return null;
    // The latest exchange plus the previous one for context; attachments and
    // project documents are never part of a review.
    return [...messages.slice(-3), { role: "assistant", content: reply }];
  }
  /** Release a job's quota reservation; charge it only when `charge` (memory actually changed). */
  private settleReservation(userId: string, row: Pick<MemberMemoryReviewRow, "requestId" | "reservedPoints">, charge: boolean, tier: AiMode): number {
    if (!row.reservedPoints) return 0;
    const quota = this.deps.store.quota(userId);
    quota.reservedTokens = Math.max(0, quota.reservedTokens - row.reservedPoints);
    if (charge) quota.usedTokens += row.reservedPoints;
    this.deps.store.saveQuota(userId, quota);
    if (!charge) return 0;
    this.deps.store.addUsage({
      id: crypto.randomUUID(), userId, actorId: null, requestId: row.requestId, kind: "memory", status: "completed", model: "记忆整理", mode: tier,
      createdAt: new Date().toISOString(), reason: "记忆整理：记忆有更新时按管理员设定的每次折算扣除", limitTokens: null,
      inputTokens: 0, outputTokens: 0, totalTokens: row.reservedPoints, convertedTokens: row.reservedPoints, billingKind: "memory_conversion", estimated: false,
    });
    return row.reservedPoints;
  }
  private finish(userId: string, row: MemberMemoryReviewRow, status: MemberMemoryReviewRow["status"], reason: string | null, tier: AiMode, extra: Partial<MemberMemoryReviewRow> = {}): void {
    const now = Date.now();
    this.deps.store.sql.transaction(() => {
      const current = this.repository.review(userId, row.requestId);
      if (!current || current.status !== "running") return;
      const charged = this.settleReservation(userId, current, status === "applied", tier);
      this.repository.updateReview(userId, row.requestId, { ...extra, status, reason, leaseUntil: 0, reservedPoints: 0, chargedPoints: charged }, now);
    });
  }

  /** Claim and run one journaled review. Safe to call repeatedly; only one caller wins the lease. */
  async processReview(userId: string, requestId: string, options: { background: boolean }): Promise<void> {
    const now = Date.now();
    const settings = this.repository.settings();
    const claimed = this.deps.store.sql.transaction((): MemberMemoryReviewRow | null => {
      const row = this.repository.review(userId, requestId);
      if (!row || (row.status !== "queued" && row.status !== "running")) return null;
      if (row.status === "running" && row.leaseUntil > now) return null;
      if (row.status === "queued" && row.dueAt > now) return null;
      if (row.status === "running") {
        // The previous worker vanished mid-review: return its reservation first.
        this.settleReservation(userId, row, false, settings.reviewTier);
        this.repository.updateReview(userId, requestId, { reservedPoints: 0 }, now);
      }
      if (row.attempts >= REVIEW_MAX_ATTEMPTS) {
        this.repository.updateReview(userId, requestId, { status: "failed", reason: "attempts_exhausted", leaseUntil: 0 }, now);
        return null;
      }
      if (this.repository.hasRunningReview(userId, requestId, now)) {
        this.repository.updateReview(userId, requestId, { status: "queued", dueAt: now + 15_000, leaseUntil: 0 }, now);
        return null;
      }
      this.repository.updateReview(userId, requestId, { status: "running", attempts: row.attempts + 1, leaseUntil: now + REVIEW_LEASE_MS, reservedPoints: 0 }, now);
      return { ...row, status: "running", attempts: row.attempts + 1, reservedPoints: 0 };
    });
    if (!claimed) return;
    const tier = settings.reviewTier;
    try {
      if (!settings.enabled) return this.finish(userId, claimed, "skipped", "disabled", tier);
      if (options.background && !await this.deps.isPrincipalActive(this.repository.tenantId, userId)) return this.finish(userId, claimed, "skipped", "inactive", tier);
      if (!this.deps.store.hasAccess(userId)) return this.finish(userId, claimed, "skipped", "no_access", tier);
      const before = this.repository.read(userId);
      if (!before.learningEnabled) return this.finish(userId, claimed, "skipped", "learning_off", tier);
      const reply = this.deps.store.request(userId, requestId)?.result?.content;
      const turns = reply ? this.reviewTurns(userId, requestId, reply) : null;
      if (!turns) return this.finish(userId, claimed, "skipped", "missing_turn", tier);
      let persona: AiPersonaProfile | undefined;
      try { persona = new AiPersonaRepository(this.deps.store.sql).read(userId, this.repository.tenantId).profile; } catch { persona = undefined; }
      const target = this.reviewTarget(tier);
      // Reserve the administrator-set price before any provider call.
      const reserved = this.deps.store.sql.transaction(() => {
        if (!settings.pricePoints) return true;
        const quota = this.deps.store.quota(userId);
        if (quota.remainingTokens < settings.pricePoints) return false;
        quota.reservedTokens += settings.pricePoints;
        this.deps.store.saveQuota(userId, quota);
        this.repository.updateReview(userId, requestId, { reservedPoints: settings.pricePoints }, Date.now());
        return true;
      });
      if (!reserved) return this.finish(userId, claimed, "skipped", "quota", tier);
      const cue = claimed.cue;
      let inputTokens = 0, outputTokens = 0;
      const call = async (payload: string, phase: string, callTarget: ReviewTarget = target) => {
        const result = await this.callReviewer(callTarget, payload, await idempotencyKey(this.repository.tenantId, userId, requestId, claimed.attempts, phase));
        inputTokens += result.inputTokens; outputTokens += result.outputTokens;
        return result.content;
      };
      const stores = { memory: before.memory, user: before.user };
      // Recall context (avoid duplicate or contradicting memory) and, for a
      // reusable way of working, a skill evaluation. Local reads only.
      let context: MemberReviewContext = { history: [], skills: null };
      try {
        const memberText = turns.filter(turn => turn.role === "user").at(-1)?.content ?? "";
        const stored = this.deps.store.request(userId, requestId);
        context = this.learning.reviewContext(userId, { settings, memberText, conversationId: claimed.conversationId, cue, reply: reply ?? "", result: stored?.result });
      } catch { context = { history: [], skills: null }; }
      const firstTarget = context.skills ? { ...target, maxOutputTokens: target.skillOutputTokens } : target;
      const first = parseMemberMemoryReview(await call(buildMemberMemoryReviewPayload({ stores, turns, cue, persona, history: context.history, skills: context.skills }), "review", firstTarget));
      if (!first.ok) return this.finish(userId, claimed, "failed", `parse_${first.error}`, tier, { inputTokens, outputTokens });
      const proposal = context.skills && first.skill ? { action: first.skill.action, ...(first.skill.skillId ? { skillId: first.skill.skillId } : {}), skill: first.skill.skill, reason: context.skills.reason, evidence: context.skills.evidence } : null;
      let plan = planMemberMemoryReview(stores, first.operations, { cue });
      if (plan.overflow.length) {
        // Hermes: an overflowing write returns the current entries and asks
        // the model to consolidate in the same turn. One retry, then give up.
        const overflowTargets = plan.overflow.map(item => item.target);
        const previous: MemberMemoryReviewOperation[] = first.operations.filter(op => overflowTargets.includes(op.target));
        const retry = parseMemberMemoryReview(await call(buildMemberMemoryReviewPayload({
          stores: plan.stores, turns, cue, persona, history: context.history,
          consolidation: { error: plan.overflow.map(item => item.message).join(" "), previousOperations: previous.map(op => ({ target: op.target, action: op.action, ...(op.oldText ? { old_text: op.oldText } : {}), ...(op.content ? { content: op.content } : {}) })) },
        }), "consolidate"));
        if (retry.ok) {
          const second = planMemberMemoryReview(plan.stores, retry.operations, { cue, targets: overflowTargets });
          plan = {
            stores: second.stores,
            changes: { added: plan.changes.added + second.changes.added, updated: plan.changes.updated + second.changes.updated, removed: plan.changes.removed + second.changes.removed },
            overflow: second.overflow,
            dropped: { ...plan.dropped, ...second.dropped },
          };
        }
      }
      const changed = memoryReviewChanged(plan.changes);
      const finishedAt = Date.now();
      this.deps.store.sql.transaction(() => {
        const current = this.repository.review(userId, requestId);
        if (!current || current.status !== "running") return;
        const latest = this.repository.read(userId);
        // Optimistic concurrency: a member edit, clear or opt-out during the
        // provider call wins; the review is discarded and nothing is charged.
        const stale = latest.revision !== before.revision || !latest.learningEnabled;
        // A skill is only ever proposed; the member adopts it (or not) later.
        let skillId: string | null = null;
        if (!stale && proposal && this.repository.settings().skillsEnabled) {
          try { skillId = this.learning.skills.propose(userId, proposal, requestId, finishedAt); } catch { skillId = null; }
        }
        const status = stale ? "skipped" : changed || skillId ? "applied" : "unchanged";
        if (status === "applied" && changed) {
          this.repository.write(userId, before.revision, { memory: plan.stores.memory, user: plan.stores.user, learningEnabled: true }, "review");
          // Forgetting takes effect immediately; other updates wait for the
          // next conversation (frozen snapshot, prefix cache intact).
          if (cue === "forget" && plan.changes.removed > 0) this.repository.deleteSnapshots(userId);
        }
        // The administrator's review price applies when memory changed or a skill was proposed.
        const charged = this.settleReservation(userId, current, status === "applied", tier);
        const reason = stale ? "memory_changed" : plan.overflow.length ? "overflow" : Object.keys(plan.dropped).length ? `dropped:${Object.entries(plan.dropped).map(([key, count]) => `${key}=${count}`).join(",")}` : first.skillInvalid ? "skill_invalid" : null;
        this.repository.updateReview(userId, requestId, {
          status, reason, leaseUntil: 0, reservedPoints: 0, chargedPoints: charged, inputTokens, outputTokens,
          ...(status === "applied" ? { added: plan.changes.added, updated: plan.changes.updated, removed: plan.changes.removed } : {}),
          ...(skillId ? { skillId } : {}),
        }, finishedAt);
      });
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError(502, "AI_MEMORY_REVIEW_FAILED", "记忆整理失败");
      // Transient network/provider failures get one delayed retry through the
      // background cycle; an explicit provider rejection (4xx) does not.
      const retryable = claimed.attempts < REVIEW_MAX_ATTEMPTS && safe.status >= 500 && safe.diagnostic?.billing !== "rejected";
      const now = Date.now();
      this.deps.store.sql.transaction(() => {
        const current = this.repository.review(userId, requestId);
        if (!current || current.status !== "running") return;
        this.settleReservation(userId, current, false, tier);
        this.repository.updateReview(userId, requestId, retryable
          ? { status: "queued", dueAt: now + REVIEW_RETRY_DELAY_MS, leaseUntil: 0, reservedPoints: 0, reason: safe.code }
          : { status: "failed", leaseUntil: 0, reservedPoints: 0, reason: safe.code }, now);
      });
    }
  }

  /** Scheduled fallback (Cloudflare cron tick / Express interval). Bounded per tick. */
  async runBackgroundCycle(limit: number, forTenant: (tenantId: string) => AiMemberMemoryService): Promise<AiBackgroundMemoryCycle> {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(8, limit)) : 4;
    const result: AiBackgroundMemoryCycle = { scanned: 0, processed: 0, failed: 0 };
    let due: Array<{ tenantId: string; storedUserId: string; requestId: string }> = [];
    try { due = AiMemberMemoryRepository.dueReviews(this.repository.sql, Date.now(), bounded * 4); }
    catch { due = []; }
    for (const row of due) {
      if (result.processed >= bounded) break;
      result.scanned += 1;
      try {
        await forTenant(row.tenantId).processReview(tenantStorageValue(row.tenantId, row.storedUserId), row.requestId, { background: true });
        result.processed += 1;
      } catch {
        result.failed += 1;
      }
    }
    try { result.history = await this.runHistoryMaintenance(forTenant); } catch { /* next tick */ }
    return result;
  }

  /**
   * History index upkeep, bounded per tick: delete superseded rows, reconcile
   * workspace revisions hourly, and backfill up to two members.
   */
  private async runHistoryMaintenance(forTenant: (tenantId: string) => AiMemberMemoryService): Promise<{ synced: number; purged: number }> {
    const sql = this.deps.store.sql;
    const now = Date.now();
    const purged = AiMemberHistoryIndex.runPurges(sql, 2);
    if (now - (historyReconciledAt.get(sql) ?? 0) >= HISTORY_RECONCILE_MS) {
      historyReconciledAt.set(sql, now);
      for (const tenantId of recallTenants(sql)) new AiMemberHistoryIndex(sql, tenantId).enqueueDrift(now);
    }
    let synced = 0;
    for (const job of AiMemberHistoryIndex.dueQueue(sql, now, 2)) {
      if (await forTenant(job.tenantId).processHistoryJob(job.userId, job.attempts)) synced += 1;
    }
    return { synced, purged };
  }

  /** One bounded backfill step for one member (V1 snapshot or V2 conversations). */
  async processHistoryJob(userId: string, attempts: number): Promise<boolean> {
    const index = this.learning.history;
    const sql = this.deps.store.sql;
    try {
      if (!memberHistoryEligible(sql, this.repository.tenantId, userId) || !this.deps.store.hasAccess(userId) || !await this.deps.isPrincipalActive(this.repository.tenantId, userId)) {
        index.finishQueued(userId, true);
        return false;
      }
      if (currentWorkspaceVersion(this.deps.store, userId) === 1) {
        const snapshot = new AiWorkspaceRepository(sql).read(userId, this.repository.tenantId);
        const result = index.sync(userId, { conversations: historySourceFromState(snapshot.state), full: true, version: 1, revision: snapshot.revision, live: false, budget: MEMBER_HISTORY_LIMITS.backfillBudget });
        index.finishQueued(userId, result.complete);
        return true;
      }
      const v2 = new AiWorkspaceV2Store(sql, new AiWorkspaceRepository(sql));
      const directory = v2.listActiveConversations(userId, this.repository.tenantId);
      index.dropMissingConversations(userId, new Set(directory.conversations.map(item => item.entityId)));
      const known = index.conversationRevisions(userId);
      const changed = directory.conversations.filter(item => known.get(item.entityId) !== item.revision);
      const batch = changed.slice(0, 4);
      let complete = true;
      if (batch.length) {
        const entities = (await v2.readActiveEntities(userId, batch.map(item => ({ kind: "conversation" as const, entityId: item.entityId })), this.repository.tenantId)).entities;
        const conversations = entities.flatMap(entity => {
          if (!entity || entity.deleted) return [];
          const conversation = validateAiWorkspaceConversationEntity(entity.value);
          return [{ id: conversation.id, title: conversation.title, messages: conversation.messages, revision: entity.revision }];
        });
        const result = index.sync(userId, { conversations, full: false, version: 2, revision: null, live: false, budget: MEMBER_HISTORY_LIMITS.backfillBudget });
        complete = result.complete && changed.length <= batch.length;
      }
      if (complete) index.markComplete(userId, 2);
      index.finishQueued(userId, complete);
      return true;
    } catch {
      try { index.failQueued(userId, attempts); } catch { /* retried by reconcile */ }
      return false;
    }
  }
}
