import { describe, expect, it, vi } from "vitest";
import { defaultAiPersonaProfile } from "../../../shared/aiPersona";
import { loadAiEntry } from "./loadAiEntry";

function fixture(granted: boolean | undefined, complete = false) {
  const calls: string[] = [];
  const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    expect(new Headers(init?.headers).get("X-Tongpin-Account")).toBe("member-a");
    calls.push(path);
    const result = path.endsWith("status") ? { accessGranted: granted, quota: { remainingTokens: 0 } }
      : path.endsWith("persona") ? { revision: 1, profile: { ...defaultAiPersonaProfile(), onboardingComplete: complete } }
      : path.endsWith("bootstrap") ? { schemaVersion: 1 } : { revision: 1, state: {} };
    return result as T;
  };
  return { api, calls };
}

describe("AI entry permission and onboarding order", () => {
  it.each([false, undefined])("never requests personal data without explicit access (%s)", async granted => {
    const { api, calls } = fixture(granted);
    expect((await loadAiEntry(api, "member-a", new AbortController().signal)).kind).toBe("locked");
    expect(calls).toEqual(["/api/ai/status"]);
  });
  it("does not hydrate a hidden workspace before setup is completed", async () => {
    const { api, calls } = fixture(true);
    expect((await loadAiEntry(api, "member-a", new AbortController().signal)).kind).toBe("onboarding");
    expect(calls).toEqual(["/api/ai/status", "/api/ai/persona"]);
  });
  it("keeps existing history accessible for a previously granted but exhausted member", async () => {
    const { api, calls } = fixture(true, true);
    expect((await loadAiEntry(api, "member-a", new AbortController().signal)).kind).toBe("ready");
    expect(calls).toEqual(["/api/ai/status", "/api/ai/persona", "/api/ai/workspace-v2/bootstrap", "/api/ai/workspace"]);
  });
  it("opens active V2 without reading the whole V1 workspace", async () => {
    const { api: original, calls } = fixture(true, true);
    const api = async <T,>(path: string, init?: RequestInit): Promise<T> => path.endsWith("bootstrap")
      ? (calls.push(path), { schemaVersion: 2, epoch: 1, manifest: { base: { mode: "standard" }, hasDraftAttachments: false, hasVideoDraftSettings: false }, conversations: [], projects: [] } as T)
      : original<T>(path, init);
    expect((await loadAiEntry(api, "member-a", new AbortController().signal)).kind).toBe("ready-v2");
    expect(calls).toEqual(["/api/ai/status", "/api/ai/persona", "/api/ai/workspace-v2/bootstrap"]);
  });
  it("does not continue to private endpoints after account switch or unmount", async () => {
    const controller = new AbortController();
    const called = vi.fn();
    const api = async <T,>(): Promise<T> => { called(); controller.abort(); return { accessGranted: true } as T; };
    await expect(loadAiEntry(api, "member-a", controller.signal)).rejects.toThrow();
    expect(called).toHaveBeenCalledTimes(1);
  });
  it("fails without fetching persona when status is unavailable", async () => {
    const api = vi.fn(async () => { throw new Error("offline"); });
    await expect(loadAiEntry(api, "member-a", new AbortController().signal)).rejects.toThrow("offline");
    expect(api).toHaveBeenCalledTimes(1);
  });
});
