// This registry contains save callbacks only, never account credentials or stored messages.
const guards = new Map<string, Set<() => Promise<boolean>>>();

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
