/**
 * Per-viewer display preference for AI reply process details ("过程详情").
 * Only one of two fixed words is stored under an account-scoped key; no
 * conversation text, ids or process content ever enters this storage.
 * Private windows or blocked storage fall back to the collapsed default.
 */
export type AiProcessDetailsStorage = Pick<Storage, "getItem" | "setItem">;

const KEY_PREFIX = "tongpin.ai.process-details.v1:";
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function aiProcessDetailsStorageKey(accountId: string): string | null {
  return ACCOUNT_ID.test(accountId) ? `${KEY_PREFIX}${accountId}` : null;
}

/** Null when storage is unavailable (private mode, blocked site data, tests). */
export function aiProcessDetailsStorage(): AiProcessDetailsStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readAiProcessDetailsExpanded(accountId: string, storage: Pick<Storage, "getItem"> | null = aiProcessDetailsStorage()): boolean {
  const key = aiProcessDetailsStorageKey(accountId);
  if (!key || !storage) return false;
  try {
    return storage.getItem(key) === "expanded";
  } catch {
    return false;
  }
}

export function saveAiProcessDetailsExpanded(accountId: string, expanded: boolean, storage: Pick<Storage, "setItem"> | null = aiProcessDetailsStorage()): void {
  const key = aiProcessDetailsStorageKey(accountId);
  if (!key || !storage) return;
  try {
    storage.setItem(key, expanded ? "expanded" : "collapsed");
  } catch {
    // A display preference must never block chatting.
  }
}
