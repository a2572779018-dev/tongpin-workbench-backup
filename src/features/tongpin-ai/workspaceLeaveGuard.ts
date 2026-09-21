// This registry contains save callbacks only, never account credentials or stored messages.
const guards = new Map<string, Set<() => Promise<boolean>>>();
const activityListeners = new Map<string, Set<() => void>>();

/** Account-scoped wake signal only. No workspace body or credentials are
 * copied into this process-local registry. */
export function registerAiWorkspaceActivityListener(accountId: string, listener: () => void) {
  const listeners = activityListeners.get(accountId) ?? new Set<() => void>();
  listeners.add(listener); activityListeners.set(accountId, listeners);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    if (!listeners.size && activityListeners.get(accountId) === listeners) activityListeners.delete(accountId);
  };
}

export function notifyAiWorkspaceSaved(accountId: string): void {
  for (const listener of [...(activityListeners.get(accountId) ?? [])]) listener();
}

export function registerAiLeaveGuard(accountId: string, save: () => Promise<boolean>) {
  const entries = guards.get(accountId) ?? new Set<() => Promise<boolean>>();
  // Each registration owns one entry, even if two views happen to share a callback.
  const registered = () => save();
  let active = true;
  entries.add(registered); guards.set(accountId, entries);
  return () => {
    if (!active) return;
    active = false;
    entries.delete(registered);
    if (!entries.size && guards.get(accountId) === entries) guards.delete(accountId);
  };
}

export async function flushAiBeforeLeave(accountId: string): Promise<boolean> {
  try {
    const results = await Promise.all([...(guards.get(accountId) ?? [])].map(save => Promise.resolve().then(save)));
    return results.every(result => result === true);
  } catch { return false; }
}
