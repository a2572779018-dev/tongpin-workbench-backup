import { mediaTaskIsSettled, parseMediaTaskResponse, type MediaTaskRun } from "./mediaTaskClient";
import { ApiRequestError } from "../../lib/api";

type ExpectedTask = Parameters<typeof parseMediaTaskResponse>[1];
interface Entry { task: MediaTaskRun; checkedAt: number }

export function mediaTaskReadInvalidatesSnapshot(error: unknown): boolean {
  return error instanceof ApiRequestError && [401, 403, 404, 409].includes(error.status)
    || error instanceof Error && error.message.includes("任务响应与当前对话或账号不匹配");
}

/** A bounded, same-login presentation snapshot. It does not authorize actions
 * or replace the read of the original server task on every mount. */
export class MediaTaskSnapshotCache {
  private entries = new Map<string, Entry>();

  constructor(private readonly ttlMs = 10 * 60_000, private readonly maxEntries = 200) {}

  private key(scope: string, expected: ExpectedTask): string {
    return JSON.stringify([scope, expected.intent, expected.requestId]);
  }

  snapshot(scope: string, expected: ExpectedTask): MediaTaskRun | null {
    if (!scope || !expected.accountId) return null;
    const key = this.key(scope, expected), entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.checkedAt > this.ttlMs) { this.entries.delete(key); return null; }
    try {
      const task = parseMediaTaskResponse({ task: entry.task }, expected);
      if (!mediaTaskIsSettled(task.status) || task.status === "unknown") return null;
      this.entries.delete(key); this.entries.set(key, entry);
      return task;
    } catch { return null; }
  }

  put(scope: string, expected: ExpectedTask, task: MediaTaskRun): void {
    if (!scope || !expected.accountId) return;
    const key = this.key(scope, expected);
    let verified: MediaTaskRun;
    try { verified = parseMediaTaskResponse({ task }, expected); }
    catch { this.entries.delete(key); return; }
    // An active or uncertain task can change and must always come from a GET.
    if (!mediaTaskIsSettled(verified.status) || verified.status === "unknown") { this.entries.delete(key); return; }
    const prior = this.entries.get(key);
    if (prior && verified.version < prior.task.version) return;
    this.entries.delete(key);
    this.entries.set(key, { task: verified, checkedAt: Date.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  remove(scope: string, expected: ExpectedTask): void {
    if (scope) this.entries.delete(this.key(scope, expected));
  }

  clear(): void { this.entries.clear(); }
}

export const mediaTaskSnapshotCache = new MediaTaskSnapshotCache();
