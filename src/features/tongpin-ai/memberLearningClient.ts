import { useSyncExternalStore } from "react";
import type { AiMemoryReviewStatus, AiMemoryState } from "../../../shared/aiMemory";
import { AI_MEMORY_SKILL_ID, AI_MEMORY_SKILL_LIMITS, type AiMemoryRecallEvent, type AiMemorySkill, type AiMemorySkillInput, type AiMemorySkillOperation } from "../../../shared/aiMemoryLearning";
import type { MemberMemoryApi } from "./memberMemoryClient";

/*
 * Client side of history recall and personal skills (「AI 对你的了解」).
 * Every call is bound to the signed-in account; the server re-checks all of it.
 */

export type PersonalSkillMention = { id: string; name: string; whenToUse: string };

export function memberLearningApi(api: MemberMemoryApi, accountId: string) {
  const headers = { "X-Tongpin-Account": accountId };
  return {
    recall: (requestId: string) => api<{ recall: AiMemoryRecallEvent | null }>(`/api/ai/memory/recalls/${encodeURIComponent(requestId)}`, { headers }).then(result => result.recall),
    skills: () => api<{ enabled: boolean; skills: PersonalSkillMention[] }>("/api/ai/memory/skills", { headers }),
    updateSkill: (operation: AiMemorySkillOperation) => api<AiMemoryState>("/api/ai/memory/skills", { method: "POST", headers, body: JSON.stringify(operation) }),
  };
}

/** Member-facing reply lines: history recalled, skills used, skill proposed. Counts and names only. */
export function replyActivityLines(status: AiMemoryReviewStatus | undefined): { recall: string | null; skills: string | null; skillProposed: boolean } {
  const activity = status?.activity;
  const recall = activity?.trigger ? activity.recalled > 0 ? `回忆：找到 ${activity.recalled} 段相关历史对话` : "回忆：没有找到相关的历史对话" : null;
  const names = activity?.skills.map(skill => skill.name) ?? [];
  return { recall, skills: names.length ? `使用技能：${names.join("、")}` : null, skillProposed: status?.skillProposed === true };
}

// ---------------------------------------------------------------------------
// Account-bound source (registered by the sidebar entry inside the auth provider)
// ---------------------------------------------------------------------------

export interface MemberLearningSource {
  accountId: string;
  recall(requestId: string): Promise<AiMemoryRecallEvent | null>;
  skills(): Promise<{ enabled: boolean; skills: PersonalSkillMention[] }>;
}

let source: MemberLearningSource | null = null;
let personal: { accountId: string; skills: PersonalSkillMention[] } = { accountId: "", skills: [] };
const recallCache = new Map<string, AiMemoryRecallEvent | null>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

/** Set on sign-in (null on sign-out); loads the member's adopted skills for the @ list. */
export function setMemberLearningSource(next: MemberLearningSource | null): void {
  if (next?.accountId === source?.accountId && next?.recall === source?.recall) return;
  source = next;
  recallCache.clear();
  personal = { accountId: next?.accountId ?? "", skills: [] };
  emit();
  void refreshPersonalSkills();
}
export function subscribeMemberLearning(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function currentMemberLearningSource(): MemberLearningSource | null { return source; }

/** Re-read adopted skills (after the panel adopts, edits or deletes one). Never throws. */
export async function refreshPersonalSkills(): Promise<void> {
  const current = source;
  if (!current) return;
  try {
    const result = await current.skills();
    if (source !== current) return;
    personal = { accountId: current.accountId, skills: result.enabled ? result.skills.filter(skill => AI_MEMORY_SKILL_ID.test(skill.id)).slice(0, AI_MEMORY_SKILL_LIMITS.adopted) : [] };
    emit();
  } catch { /* Offline, signed out or an older server: the @ list simply has no personal skills. */ }
}

const noSkills: PersonalSkillMention[] = [];
/** Snapshot for the signed-in account (tests and non-React callers). */
export function currentPersonalSkills(): PersonalSkillMention[] {
  return personal.accountId && personal.accountId === source?.accountId ? personal.skills : noSkills;
}
/** Adopted personal skills of the signed-in member, for the @ mention list. */
export function usePersonalSkillMentions(): PersonalSkillMention[] {
  return useSyncExternalStore(subscribeMemberLearning, currentPersonalSkills, () => noSkills);
}

/** Excerpts one reply used (cached per session; the source is the member's own account). */
export async function loadRecallDetail(requestId: string): Promise<AiMemoryRecallEvent | null> {
  const current = source;
  if (!current) return null;
  const key = `${current.accountId}\u0000${requestId}`;
  if (recallCache.has(key)) return recallCache.get(key)!;
  const detail = await current.recall(requestId);
  if (source === current) recallCache.set(key, detail);
  return detail;
}

// ---------------------------------------------------------------------------
// Panel helpers
// ---------------------------------------------------------------------------

/** "周报, 每周汇报" / "周报、每周汇报" → ["周报", "每周汇报"] (the server re-validates). */
export function parseSkillTriggers(value: string): string[] {
  return [...new Set(value.split(/[,，、;；\n]/).map(item => item.trim()).filter(Boolean))].slice(0, AI_MEMORY_SKILL_LIMITS.triggers + 2);
}
export function skillDraft(skill?: Pick<AiMemorySkill, "name" | "whenToUse" | "instructions" | "triggers">): { name: string; whenToUse: string; instructions: string; triggers: string } {
  return { name: skill?.name ?? "", whenToUse: skill?.whenToUse ?? "", instructions: skill?.instructions ?? "", triggers: skill?.triggers.join("、") ?? "" };
}
export function skillInput(draft: ReturnType<typeof skillDraft>): AiMemorySkillInput {
  return { name: draft.name.trim(), whenToUse: draft.whenToUse.trim(), instructions: draft.instructions.trim(), triggers: parseSkillTriggers(draft.triggers) };
}

/** "9月12日" in China Standard Time; "日期未知" when absent. */
export function recallDateLabel(date: string | null): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "日期未知";
  const [year, month, day] = date.split("-").map(Number);
  const thisYear = new Date(Date.now() + 8 * 60 * 60_000).getUTCFullYear();
  return year === thisYear ? `${month}月${day}日` : `${year}年${month}月${day}日`;
}

/** Usage line for an adopted skill. */
export function skillUsageLabel(skill: Pick<AiMemorySkill, "useCount" | "lastUsedAt" | "stale">): string {
  if (skill.stale) return skill.useCount ? `已 ${AI_MEMORY_SKILL_LIMITS.staleDays} 天以上未使用，可以考虑删除` : `采纳后 ${AI_MEMORY_SKILL_LIMITS.staleDays} 天未用过，可以考虑删除`;
  if (!skill.useCount) return "还没有用过";
  const last = skill.lastUsedAt ? recallDateLabel(new Date(Date.parse(skill.lastUsedAt) + 8 * 60 * 60_000).toISOString().slice(0, 10)) : "";
  return `用过 ${skill.useCount} 次${last ? ` · 最近 ${last}` : ""}`;
}
