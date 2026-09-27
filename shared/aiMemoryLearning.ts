/**
 * History recall and personal skills for member memory ("AI 对你的了解").
 *
 * Adapted from NousResearch Hermes Agent (MIT, see THIRD_PARTY_NOTICES.md):
 *  - recall ≈ Hermes `session_search` (FTS5 over the member's own past
 *    conversations, returning real stored excerpts, never an LLM summary);
 *  - personal skills ≈ Hermes' skills learned from experience
 *    (`skill_manage` + the background review's "should a skill be saved or
 *    updated?" pass), except that Tongpin only ever PROPOSES a skill: the
 *    member adopts, edits or dismisses it before it can affect a reply.
 */

export const AI_MEMORY_RECALL_LIMITS = {
  /** Excerpts injected into one reply. */
  snippets: 4,
  snippetsPerConversation: 2,
  /** Total excerpt characters injected into one reply (titles and labels excluded). */
  totalCharacters: 1500,
  snippetCharacters: 420,
  /** Recall events kept per member for the reply line and the panel. */
  logEntries: 40,
  logDays: 30,
  /** Recent events returned with the member's memory state. */
  recentEvents: 5,
} as const;

export const AI_MEMORY_SKILL_LIMITS = {
  nameCharacters: 24,
  whenToUseCharacters: 120,
  instructionsCharacters: 800,
  triggers: 6,
  triggerCharacters: 16,
  /** Proposals waiting for the member's decision. */
  proposed: 5,
  /** Adopted (active) personal skills per member. */
  adopted: 12,
  /** Background-review proposals per member per rolling 24 hours. */
  proposalsPerDay: 3,
  /** Personal skills applied automatically to one message. */
  autoApplied: 2,
  /** Personal skills explicitly @-mentioned in one message. */
  mentioned: 3,
  /** An adopted skill unused this long is suggested for cleanup. */
  staleDays: 30,
} as const;

/** `@my-xxxxxx`: lowercase so the existing `@([a-z0-9-]+)` mention grammar applies. */
export const AI_MEMORY_SKILL_ID = /^my-[a-z0-9]{6}$/;

export type AiMemorySkillStatus = "proposed" | "adopted";

export interface AiMemorySkillInput {
  name: string;
  /** When the skill applies, in the member's words (shown and matched). */
  whenToUse: string;
  /** Format, steps and preferences for this kind of task. */
  instructions: string;
  /** Short phrases the member uses when asking for this kind of task. */
  triggers: string[];
}

export interface AiMemorySkill extends AiMemorySkillInput {
  id: string;
  status: AiMemorySkillStatus;
  /** A proposal that would update this adopted skill when adopted. */
  replacesId?: string;
  origin: "review" | "member";
  /** Why the background review proposed it. */
  reason?: "repeated" | "multi_step" | "explicit";
  /** Similar earlier requests the review saw (repetition evidence). */
  evidence?: number;
  createdAt: string;
  updatedAt: string;
  adoptedAt?: string;
  useCount: number;
  lastUsedAt?: string;
  /** Adopted but unused for `staleDays`: suggested for cleanup. */
  stale?: boolean;
  /** Optimistic-concurrency token for every member write of this skill. */
  revision: number;
}

export type AiMemorySkillOperation =
  | { action: "create"; skill: AiMemorySkillInput }
  | { action: "adopt"; id: string; expectedRevision: number; skill?: AiMemorySkillInput }
  | { action: "update"; id: string; expectedRevision: number; skill: AiMemorySkillInput }
  | { action: "dismiss"; id: string; expectedRevision: number }
  | { action: "delete"; id: string; expectedRevision: number };

export interface AiMemorySkillsView {
  /** Organization switch for skill learning (and personal skills). */
  enabled: boolean;
  items: AiMemorySkill[];
}

/** One excerpt shown to the model and, on request, to the member. */
export interface AiMemoryRecallSnippet {
  conversationTitle: string;
  /** `YYYY-MM-DD` (Asia/Shanghai) or null when the date is unknown. */
  date: string | null;
  role: "user" | "assistant";
  excerpt: string;
}

export type AiMemoryRecallTrigger = "explicit" | "reference" | "entity";

export interface AiMemoryRecallEvent {
  requestId: string;
  conversationId: string;
  at: string;
  trigger: AiMemoryRecallTrigger;
  /** Excerpts injected into the reply (0 for an explicit search that found nothing). */
  count: number;
  snippets: AiMemoryRecallSnippet[];
  skills: Array<{ id: string; name: string; via: "mention" | "auto" }>;
}

export interface AiMemoryRecallOverview {
  /** Organization switch for history recall. */
  enabled: boolean;
  /** Conversations and messages currently searchable for this member. */
  indexedConversations: number;
  indexedMessages: number;
  /** The index is still catching up with older conversations. */
  pending: boolean;
  recent: AiMemoryRecallEvent[];
}

/** What a reply used from the member's history and skills (for the reply line). */
export interface AiMemoryReplyActivity {
  recalled: number;
  trigger?: AiMemoryRecallTrigger;
  skills: Array<{ id: string; name: string; via: "mention" | "auto" }>;
}
