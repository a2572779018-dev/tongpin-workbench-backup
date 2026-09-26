import type { AiMode } from "./ai";

/**
 * Member-private curated memory ("AI 对你的了解"), adapted from NousResearch
 * Hermes Agent's bounded MEMORY.md / USER.md stores (MIT, see
 * THIRD_PARTY_NOTICES.md). Two stores with separate character budgets:
 *  - `memory`: the AI's working notes about the member's work context,
 *    projects, conventions and lessons learned (Hermes MEMORY.md);
 *  - `user`: the member profile — role, preferences, communication style and
 *    expectations (Hermes USER.md).
 */
export const AI_MEMORY_TARGETS = ["memory", "user"] as const;
export type AiMemoryTarget = typeof AI_MEMORY_TARGETS[number];

/** Hermes' entry delimiter. It is counted in the budget exactly as rendered. */
export const AI_MEMORY_ENTRY_DELIMITER = "\n§\n";

/**
 * Character budgets (Unicode code points, delimiters included).
 *
 * Hermes: MEMORY.md 2,200 chars (~800 tokens) and USER.md 1,375 chars
 * (~500 tokens) of English. The same information in Chinese needs roughly
 * 0.35–0.45× the characters (1 汉字 ≈ 2.5–3 English characters), i.e. about
 * 800–1,000 and 500–600 characters. Current tokenizers spend 0.6–1.1 tokens per
 * 汉字 (DeepSeek/Qwen/GLM ≈ 0.6–0.7, o200k ≈ 1.0–1.1), so 1,000 + 600 characters
 * cost ≈ 1,000–1,750 tokens per request — the same order as Hermes' ~1,300
 * tokens. English identifiers, numbers and paths in mixed text cost only
 * ~0.25–0.3 tokens per character, so mixed entries stay under that ceiling.
 */
export const AI_MEMORY_LIMITS = {
  memoryCharacters: 1000,
  userCharacters: 600,
  /** One compact fact; long pasted material is not memory. */
  entryCharacters: 240,
  /** Operations accepted from one background review response. */
  reviewOperations: 6,
  /** Request ids accepted by one review-status lookup. */
  reviewStatusBatch: 50,
  requestBytes: 16 * 1024,
} as const;

export const AI_MEMORY_TARGET_LIMITS: Readonly<Record<AiMemoryTarget, number>> = {
  memory: AI_MEMORY_LIMITS.memoryCharacters,
  user: AI_MEMORY_LIMITS.userCharacters,
};

/** Member-facing names. The system prompt uses its own, longer headers. */
export const AI_MEMORY_TARGET_LABELS: Readonly<Record<AiMemoryTarget, string>> = {
  user: "关于你",
  memory: "工作笔记",
};

export interface AiMemoryStoreView {
  target: AiMemoryTarget;
  entries: string[];
  usedCharacters: number;
  limitCharacters: number;
}

export interface AiMemoryState {
  /** Optimistic-concurrency token for every member write. */
  revision: number;
  /** Administrator switch for the member's organization. */
  available: boolean;
  /** Member switch: 允许同频 AI 记住我. Off = no learning and no prompt use. */
  learningEnabled: boolean;
  /** Administrator-set points charged per completed background review (0 = free). */
  pricePoints: number;
  stores: Record<AiMemoryTarget, AiMemoryStoreView>;
  updatedAt: string | null;
  updatedBy: "member" | "review" | null;
}

export type AiMemoryEntryOperation =
  | { action: "add"; target: AiMemoryTarget; content: string }
  | { action: "replace"; target: AiMemoryTarget; index: number; expectedEntry: string; content: string }
  | { action: "remove"; target: AiMemoryTarget; index: number; expectedEntry: string };

export interface AiMemoryEntryRequest {
  expectedRevision: number;
  operation: AiMemoryEntryOperation;
}

export interface AiMemoryReviewChanges {
  added: number;
  updated: number;
  removed: number;
}

/** Only counts: the reply indicator never carries memory text. */
export interface AiMemoryReviewStatus {
  requestId: string;
  status: "none" | "pending" | "applied" | "unchanged" | "skipped" | "failed";
  changes?: AiMemoryReviewChanges;
}

export interface AiMemoryAdminSettings {
  enabled: boolean;
  /** Business tier whose text route runs the background reviewer. */
  reviewTier: AiMode;
  pricePoints: number;
}

/** Organization aggregates only. Administrators can never read memory text. */
export interface AiMemoryAdminStats {
  membersWithMemory: number;
  membersLearningOff: number;
  totalEntries: number;
  reviews7d: { applied: number; unchanged: number; skipped: number; failed: number };
  points7d: number;
  /** Provider-reported reviewer tokens (organization cost, not member points). */
  tokens7d: { input: number; output: number };
}

export const AI_MEMORY_DEFAULT_SETTINGS: Readonly<AiMemoryAdminSettings> = Object.freeze({
  enabled: false,
  reviewTier: "quick",
  pricePoints: 100,
});

export const AI_MEMORY_PRICE_MAX = 100_000;
