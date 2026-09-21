import { afterEach, describe, expect, it, vi } from "vitest";
import { flushAiBeforeLeave, notifyAiWorkspaceSaved, registerAiLeaveGuard, registerAiWorkspaceActivityListener } from "./workspaceLeaveGuard";

describe("account-scoped AI navigation guards", () => {
  const cleanups: Array<() => void> = [];
  function register(accountId: string, save: () => Promise<boolean>) {
    const unregister = registerAiLeaveGuard(accountId, save); cleanups.push(unregister); return unregister;
  }
  afterEach(() => { cleanups.splice(0).forEach(unregister => unregister()); });
  it("allows navigation when that account has no AI workspace registered", async () => {
    expect(await flushAiBeforeLeave("no-workspace")).toBe(true);
  });
  it("only flushes the requested account and never another member or administrator", async () => {
    const memberA = vi.fn(async () => true), memberB = vi.fn(async () => false), admin = vi.fn(async () => false);
    register("member-a", memberA); register("member-b", memberB); register("admin", admin);
    expect(await flushAiBeforeLeave("member-a")).toBe(true);
    expect(memberA).toHaveBeenCalledTimes(1); expect(memberB).not.toHaveBeenCalled(); expect(admin).not.toHaveBeenCalled();
  });
  it("blocks leaving until every registered view has successfully saved", async () => {
    const first = vi.fn(async () => true), second = vi.fn(async () => false);
    register("member-a", first); register("member-a", second);
    expect(await flushAiBeforeLeave("member-a")).toBe(false);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
  });
  it("turns rejected or synchronous-throwing saves into false without skipping other guards", async () => {
    const other = vi.fn(async () => true);
    register("member-a", () => { throw new Error("save failed"); }); register("member-a", other);
    expect(await flushAiBeforeLeave("member-a")).toBe(false); expect(other).toHaveBeenCalledTimes(1);
  });
  it("waits for saves instead of allowing navigation while one remains in flight", async () => {
    let resolve!: (saved: boolean) => void; const pending = new Promise<boolean>(done => { resolve = done; });
    register("member-a", () => pending);
    let returned = false; const flushing = flushAiBeforeLeave("member-a").then(result => { returned = true; return result; });
    await Promise.resolve(); expect(returned).toBe(false);
    resolve(true); expect(await flushing).toBe(true);
  });
  it("unregisters only its own guard and is safe to call repeatedly", async () => {
    const oldSave = vi.fn(async () => false), newSave = vi.fn(async () => true), otherSave = vi.fn(async () => false);
    const oldCleanup = register("member-a", oldSave); oldCleanup();
    register("member-a", newSave); register("member-b", otherSave);
    oldCleanup();
    expect(await flushAiBeforeLeave("member-a")).toBe(true);
    expect(newSave).toHaveBeenCalledTimes(1); expect(oldSave).not.toHaveBeenCalled(); expect(otherSave).not.toHaveBeenCalled();
    expect(await flushAiBeforeLeave("member-b")).toBe(false); expect(otherSave).toHaveBeenCalledTimes(1);
  });
  it("independently unregisters duplicate callback registrations", async () => {
    const shared = vi.fn(async () => false);
    const firstCleanup = register("member-a", shared); register("member-a", shared);
    firstCleanup();
    expect(await flushAiBeforeLeave("member-a")).toBe(false); expect(shared).toHaveBeenCalledTimes(1);
  });
  it("does not treat an unconfirmed truthy result as a successful save", async () => {
    register("member-a", (async () => "pending") as unknown as () => Promise<boolean>);
    expect(await flushAiBeforeLeave("member-a")).toBe(false);
  });
  it("waits for asset deletion and the post-delete save before permitting an account switch", async () => {
    let deleted!: () => void, saved!: (value: boolean) => void;
    const assetDeletion = new Promise<void>(resolve => { deleted = resolve; });
    const snapshotSave = new Promise<boolean>(resolve => { saved = resolve; });
    const deletion = assetDeletion.then(() => snapshotSave);
    register("member-a", async () => true); // The pre-deletion snapshot was already saved.
    register("member-a", async () => (await Promise.all([deletion])).every(result => result === true));
    let left = false;
    const leaving = flushAiBeforeLeave("member-a").then(result => { left = result; return result; });
    await Promise.resolve(); expect(left).toBe(false);
    deleted(); await Promise.resolve(); expect(left).toBe(false);
    saved(false); expect(await leaving).toBe(false);
  });
  it("wakes only the saved account and unregisters the listener", () => {
    const first = vi.fn(), second = vi.fn();
    const unregister = registerAiWorkspaceActivityListener("member-a", first);
    const unregisterSecond = registerAiWorkspaceActivityListener("member-b", second);
    notifyAiWorkspaceSaved("member-b");
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledTimes(1);
    notifyAiWorkspaceSaved("member-a"); expect(first).toHaveBeenCalledTimes(1);
    unregister(); unregisterSecond(); notifyAiWorkspaceSaved("member-a"); expect(first).toHaveBeenCalledTimes(1);
  });
});
