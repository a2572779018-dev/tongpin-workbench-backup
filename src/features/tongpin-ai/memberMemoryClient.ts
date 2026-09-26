import type { AiMemoryEntryOperation, AiMemoryReviewStatus, AiMemoryState } from "../../../shared/aiMemory";
import { AI_MEMORY_LIMITS } from "../../../shared/aiMemory";

export type MemberMemoryApi = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;

/** Opens the「AI 对你的了解」panel from anywhere in the AI page (e.g. a reply badge). */
export const MEMBER_MEMORY_OPEN_EVENT = "tongpin-ai:open-member-memory";
export function openMemberMemoryPanel(): void {
  window.dispatchEvent(new CustomEvent(MEMBER_MEMORY_OPEN_EVENT));
}

/** Every call is bound to the signed-in account; the server never trusts a body-selected owner. */
export function memberMemoryApi(api: MemberMemoryApi, accountId: string) {
  const headers = { "X-Tongpin-Account": accountId };
  return {
    read: () => api<AiMemoryState>("/api/ai/memory", { headers }),
    update: (expectedRevision: number, operation: AiMemoryEntryOperation) =>
      api<AiMemoryState>("/api/ai/memory/entries", { method: "POST", headers, body: JSON.stringify({ expectedRevision, operation }) }),
    setLearning: (learningEnabled: boolean) =>
      api<AiMemoryState>("/api/ai/memory/settings", { method: "PUT", headers, body: JSON.stringify({ learningEnabled }) }),
    clear: () => api<AiMemoryState>("/api/ai/memory", { method: "DELETE", headers }),
    reviews: (requestIds: readonly string[]) =>
      api<{ reviews: AiMemoryReviewStatus[] }>(`/api/ai/memory/reviews?requestIds=${encodeURIComponent(requestIds.join(","))}`, { headers }).then(result => result.reviews),
  };
}

export const MEMORY_REVIEW_REQUEST_ID = /^[a-zA-Z0-9_-]{16,100}$/;
/** A review usually finishes within seconds; stop asking after ~80 s. */
export const MEMORY_REVIEW_POLL_DELAYS_MS: readonly number[] = [1500, 3000, 5000, 8000, 13000, 20000, 30000];

type Listener = (status: AiMemoryReviewStatus) => void;
export interface MemoryReviewWatcher {
  watch(requestId: string, listener: Listener): () => void;
  setFetcher(fetcher: (requestIds: readonly string[]) => Promise<AiMemoryReviewStatus[]>): void;
}

/**
 * One batched poller per account: every rendered reply registers its request
 * id, lookups are coalesced into ≤50-id requests, settled results are cached
 * for the session, and a reply whose review is still running is re-checked on
 * a short backoff until it settles or the schedule runs out.
 */
export function createMemoryReviewWatcher(
  fetcher: (requestIds: readonly string[]) => Promise<AiMemoryReviewStatus[]>,
  timers: { now: () => number; setTimeout: (callback: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void } = {
    now: () => Date.now(), setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms), clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): MemoryReviewWatcher {
  let fetchStatuses = fetcher;
  const settled = new Map<string, AiMemoryReviewStatus>();
  const listeners = new Map<string, Set<Listener>>();
  const due = new Map<string, number>();
  const attempts = new Map<string, number>();
  let timer: unknown;
  let running = false;

  const arm = () => {
    if (timer !== undefined) { timers.clearTimeout(timer); timer = undefined; }
    if (!due.size || running) return;
    const next = Math.min(...due.values());
    timer = timers.setTimeout(() => { timer = undefined; void flush(); }, Math.max(0, next - timers.now()));
  };
  const notify = (status: AiMemoryReviewStatus) => { for (const listener of listeners.get(status.requestId) ?? []) listener(status); };
  const reschedule = (requestId: string) => {
    const attempt = (attempts.get(requestId) ?? 0) + 1;
    attempts.set(requestId, attempt);
    if (attempt < MEMORY_REVIEW_POLL_DELAYS_MS.length && listeners.get(requestId)?.size) due.set(requestId, timers.now() + MEMORY_REVIEW_POLL_DELAYS_MS[attempt]);
  };
  async function flush() {
    const now = timers.now();
    const batch = [...due.entries()].filter(([, at]) => at <= now).map(([id]) => id).slice(0, AI_MEMORY_LIMITS.reviewStatusBatch);
    if (!batch.length) { arm(); return; }
    for (const id of batch) due.delete(id);
    running = true;
    try {
      const results = await fetchStatuses(batch);
      const byId = new Map(results.map(item => [item.requestId, item]));
      for (const id of batch) {
        const status = byId.get(id);
        if (!status || status.status === "pending") { if (status) notify(status); reschedule(id); continue; }
        settled.set(id, status);
        notify(status);
      }
    } catch {
      // Offline or signed out: retry on the normal schedule, never surface an error.
      for (const id of batch) reschedule(id);
    } finally {
      running = false;
      arm();
    }
  }

  return {
    watch(requestId, listener) {
      if (!MEMORY_REVIEW_REQUEST_ID.test(requestId)) return () => undefined;
      const cached = settled.get(requestId);
      if (cached) { queueMicrotask(() => listener(cached)); return () => undefined; }
      const set = listeners.get(requestId) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(requestId, set);
      if (!due.has(requestId)) { attempts.set(requestId, 0); due.set(requestId, timers.now() + MEMORY_REVIEW_POLL_DELAYS_MS[0]); arm(); }
      return () => {
        set.delete(listener);
        if (!set.size) { listeners.delete(requestId); due.delete(requestId); }
      };
    },
    setFetcher(next) { fetchStatuses = next; },
  };
}

const watchers = new Map<string, MemoryReviewWatcher>();
/** Per-account singleton so a signed-in account never sees another account's cache. */
export function memoryReviewWatcherFor(accountId: string, fetcher: (requestIds: readonly string[]) => Promise<AiMemoryReviewStatus[]>): MemoryReviewWatcher {
  let watcher = watchers.get(accountId);
  if (!watcher) { watcher = createMemoryReviewWatcher(fetcher); watchers.set(accountId, watcher); }
  else watcher.setFetcher(fetcher);
  return watcher;
}

/**
 * The signed-in workspace registers its review source (from the sidebar entry,
 * which lives inside the auth provider). Reply badges subscribe to it, so a
 * chat row rendered on its own — or before sign-in — simply shows nothing.
 */
export type MemoryReviewSource = { accountId: string; watcher: MemoryReviewWatcher };
let activeSource: MemoryReviewSource | null = null;
const sourceListeners = new Set<() => void>();
export function setMemoryReviewSource(accountId: string | null, fetcher?: (requestIds: readonly string[]) => Promise<AiMemoryReviewStatus[]>): void {
  const next = accountId && fetcher ? { accountId, watcher: memoryReviewWatcherFor(accountId, fetcher) } : null;
  if (next?.accountId === activeSource?.accountId && next?.watcher === activeSource?.watcher) return;
  activeSource = next;
  for (const listener of sourceListeners) listener();
}
export function subscribeMemoryReviewSource(listener: () => void): () => void {
  sourceListeners.add(listener);
  return () => sourceListeners.delete(listener);
}
export function currentMemoryReviewSource(): MemoryReviewSource | null { return activeSource; }

/** Member-facing wording for a settled review; counts only, never memory text. */
export function memoryReviewSummary(status: AiMemoryReviewStatus | undefined): string | null {
  if (status?.status !== "applied" || !status.changes) return null;
  const { added, updated, removed } = status.changes;
  const parts = [added ? `新增 ${added} 条` : "", updated ? `更新 ${updated} 条` : "", removed ? `删除 ${removed} 条` : ""].filter(Boolean);
  return parts.length ? parts.join("，") : null;
}

export function memoryUsagePercent(used: number, limit: number): number {
  return limit > 0 ? Math.min(100, Math.floor((used / limit) * 100)) : 0;
}

/** Client-side mirror of the server's entry normalization (the server re-validates). */
export function memoryEntryLength(value: string): number {
  return Array.from(value.replace(/\s+/g, " ").trim()).length;
}
