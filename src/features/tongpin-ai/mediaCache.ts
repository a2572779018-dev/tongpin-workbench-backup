import type { AiVideoJob } from "../../../shared/aiVideo";
import type { Session } from "../../types";

const sessionScopes = new WeakMap<Session, string>();
/** Cache entries belong to one authenticated login chain, not merely the
 * public user ID. The same user ID can be valid in a different tenant. */
export function mediaCacheScope(session: Session | null): string {
  if (!session?.user.id) return "";
  let scope = sessionScopes.get(session);
  if (!scope) { scope = `${session.user.id}:${crypto.randomUUID()}`; sessionScopes.set(session, scope); }
  return scope;
}

function principalIdentity(session: Session | null): string | null {
  if (!session?.user.id) return null;
  const user = session.user as unknown as Record<string, unknown>;
  const tenantValues = [user.tenantId, user.tenant_id, user.orgId, user.org_id]
    .filter(value => value !== undefined && value !== null && value !== "");
  // A user ID alone cannot prove that a token refresh stayed in the same
  // tenant. Older/public sessions omit tenant metadata, so fail closed.
  if (!tenantValues.length || tenantValues.some(value => typeof value !== "string" || value !== tenantValues[0])) return null;
  return JSON.stringify([session.user.id, tenantValues[0]]);
}

/** Only call for an authenticated continuation of the *same* login (token
 * rotation or profile update). A fresh login must use a new scope even when
 * the public user ID happens to match. */
export function transferMediaCacheScope(previous: Session | null, next: Session | null): boolean {
  const previousIdentity = principalIdentity(previous);
  if (!previous || !next || !previousIdentity || previousIdentity !== principalIdentity(next)) return false;
  const scope = mediaCacheScope(previous);
  if (!scope) return false;
  sessionScopes.set(next, scope);
  return true;
}

interface InFlight<T> { controller: AbortController; promise: Promise<T> }
interface MediaCacheEntry {
  job?: AiVideoJob;
  jobCheckedAt?: number;
  blob?: Blob;
  objectUrl?: string;
  duration?: number;
  currentTime?: number;
  jobInFlight?: InFlight<AiVideoJob>;
  blobInFlight?: InFlight<Blob>;
  retained: number;
}

export interface VideoPlaybackSnapshot {
  job?: AiVideoJob;
  blob?: Blob;
  url?: string;
  duration?: number;
  currentTime?: number;
}

const cacheKey = (account: string, id: string) => JSON.stringify([account, id]);
const abortError = (signal: AbortSignal) => signal.reason ?? new DOMException("Aborted", "AbortError");

function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    // Clean up in both handled branches. Chaining a detached .finally here
    // creates an unhandled rejection when a media GET fails.
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** Session-memory only: private video bytes and object URLs are never persisted to disk. */
export class MediaBlobCache {
  private entries = new Map<string, MediaCacheEntry>();
  private bytes = 0;
  constructor(private readonly limit = 96 * 1024 * 1024, private readonly maxEntries = 200) {}

  private find(account: string, id: string, create = false): [string, MediaCacheEntry] | undefined {
    if (!account || !id) return undefined;
    const key = cacheKey(account, id);
    let entry = this.entries.get(key);
    if (!entry && create) { entry = { retained: 0 }; this.entries.set(key, entry); }
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return [key, entry];
  }

  private dropBlob(entry: MediaCacheEntry) {
    if (entry.objectUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(entry.objectUrl);
    if (entry.blob) this.bytes -= entry.blob.size;
    entry.blob = undefined; entry.objectUrl = undefined; entry.duration = undefined; entry.currentTime = undefined;
  }

  private disposable(entry: MediaCacheEntry) {
    return entry.retained === 0 && !entry.jobInFlight && !entry.blobInFlight;
  }

  private trim() {
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.limit) break;
      if (!entry.blob || !this.disposable(entry)) continue;
      this.dropBlob(entry);
      if (!entry.job) this.entries.delete(key);
    }
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (!this.disposable(entry)) continue;
      this.dropBlob(entry); this.entries.delete(key);
    }
  }

  snapshot(account: string, id: string): VideoPlaybackSnapshot | undefined {
    if (!account || !id) return undefined;
    const entry = this.entries.get(cacheKey(account, id));
    if (!entry) return undefined;
    return { ...(entry.job ? { job: entry.job } : {}), ...(entry.blob ? { blob: entry.blob } : {}), ...(entry.objectUrl ? { url: entry.objectUrl } : {}), ...(entry.duration ? { duration: entry.duration } : {}), ...(entry.currentTime ? { currentTime: entry.currentTime } : {}) };
  }

  get(account: string, id: string): Blob | undefined { return this.find(account, id)?.[1].blob; }

  put(account: string, id: string, blob: Blob) {
    const found = this.find(account, id, true);
    if (!found) return;
    const [key, entry] = found;
    if (entry.blob === blob) return;
    if (entry.blob) this.dropBlob(entry);
    if (blob.size > this.limit) {
      if (!entry.job && !entry.jobInFlight && !entry.blobInFlight && !entry.retained) this.entries.delete(key);
      return;
    }
    entry.blob = blob; this.bytes += blob.size; this.trim();
  }

  putJob(account: string, id: string, job: AiVideoJob) {
    const found = this.find(account, id, true);
    if (!found) return;
    found[1].job = job; found[1].jobCheckedAt = Date.now(); this.trim();
  }

  putDuration(account: string, id: string, duration: number) {
    if (!Number.isFinite(duration) || duration <= 0) return;
    const found = this.find(account, id, true);
    if (!found) return;
    found[1].duration = duration;
  }

  putCurrentTime(account: string, id: string, currentTime: number) {
    if (!Number.isFinite(currentTime) || currentTime < 0) return;
    const found = this.find(account, id, true);
    if (!found) return;
    found[1].currentTime = currentTime;
  }

  objectUrl(account: string, id: string): string | undefined {
    const found = this.find(account, id);
    if (!found?.[1].blob || typeof URL.createObjectURL !== "function") return undefined;
    found[1].objectUrl ||= URL.createObjectURL(found[1].blob);
    return found[1].objectUrl;
  }

  remove(account: string, id: string) {
    const key = cacheKey(account, id);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.jobInFlight?.controller.abort();
    entry.blobInFlight?.controller.abort();
    this.dropBlob(entry);
    this.entries.delete(key);
  }

  /** Keep an on-screen player out of LRU eviction; the warm entry remains after release for later remounts. */
  retain(account: string, id: string): () => void {
    const found = this.find(account, id, true);
    if (!found) return () => undefined;
    const entry = found[1]; entry.retained += 1;
    let released = false;
    return () => { if (released) return; released = true; entry.retained = Math.max(0, entry.retained - 1); this.trim(); };
  }

  async loadBlob(account: string, id: string, loader: (signal: AbortSignal) => Promise<Blob>, callerSignal?: AbortSignal): Promise<Blob> {
    if (callerSignal?.aborted) throw abortError(callerSignal);
    const found = this.find(account, id, true);
    if (!found) throw new Error("视频缓存缺少账号或任务编号");
    const [key, entry] = found;
    if (entry.blob) return entry.blob;
    if (!entry.blobInFlight) {
      const controller = new AbortController();
      const request = {} as InFlight<Blob>;
      request.controller = controller;
      request.promise = Promise.resolve().then(() => loader(controller.signal)).then(blob => {
        const current = this.entries.get(key);
        if (current !== entry || current.blobInFlight !== request || controller.signal.aborted) throw abortError(controller.signal);
        this.put(account, id, blob);
        return blob;
      }).finally(() => {
        const current = this.entries.get(key);
        if (current === entry && current.blobInFlight === request) current.blobInFlight = undefined;
      });
      entry.blobInFlight = request;
    }
    return waitForCaller(entry.blobInFlight.promise, callerSignal);
  }

  async loadJob(account: string, id: string, loader: (signal: AbortSignal) => Promise<AiVideoJob>, callerSignal?: AbortSignal, freshForMs = 0): Promise<AiVideoJob> {
    if (callerSignal?.aborted) throw abortError(callerSignal);
    const found = this.find(account, id, true);
    if (!found) throw new Error("视频缓存缺少账号或任务编号");
    const [key, entry] = found;
    if (entry.job && freshForMs > 0 && Date.now() - (entry.jobCheckedAt ?? 0) < freshForMs) return entry.job;
    if (!entry.jobInFlight) {
      const controller = new AbortController();
      const request = {} as InFlight<AiVideoJob>;
      request.controller = controller;
      request.promise = Promise.resolve().then(() => loader(controller.signal)).then(job => {
        const current = this.entries.get(key);
        if (current !== entry || current.jobInFlight !== request || controller.signal.aborted) throw abortError(controller.signal);
        this.putJob(account, id, job);
        return job;
      }).finally(() => {
        const current = this.entries.get(key);
        if (current === entry && current.jobInFlight === request) current.jobInFlight = undefined;
      });
      entry.jobInFlight = request;
    }
    return waitForCaller(entry.jobInFlight.promise, callerSignal);
  }

  clear() {
    for (const entry of this.entries.values()) {
      entry.jobInFlight?.controller.abort(); entry.blobInFlight?.controller.abort(); this.dropBlob(entry);
    }
    this.entries.clear(); this.bytes = 0;
  }
}

export const videoBlobCache = new MediaBlobCache();
