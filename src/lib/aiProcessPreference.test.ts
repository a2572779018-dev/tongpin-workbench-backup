import { describe, expect, it } from "vitest";
import { aiProcessDetailsStorage, aiProcessDetailsStorageKey, readAiProcessDetailsExpanded, saveAiProcessDetailsExpanded } from "./aiProcessPreference";

function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("AI process details preference", () => {
  it("defaults to collapsed and round-trips per viewer", () => {
    const storage = memoryStorage();
    expect(readAiProcessDetailsExpanded("member-a", storage)).toBe(false);
    saveAiProcessDetailsExpanded("member-a", true, storage);
    expect(readAiProcessDetailsExpanded("member-a", storage)).toBe(true);
    expect(readAiProcessDetailsExpanded("member-b", storage)).toBe(false);
    saveAiProcessDetailsExpanded("member-a", false, storage);
    expect(readAiProcessDetailsExpanded("member-a", storage)).toBe(false);
    expect([...storage.values.values()]).toEqual(["collapsed"]);
  });

  it("stores only a fixed word under an account-scoped key", () => {
    const storage = memoryStorage();
    saveAiProcessDetailsExpanded("member-a", true, storage);
    expect([...storage.values.entries()]).toEqual([["tongpin.ai.process-details.v1:member-a", "expanded"]]);
    expect(aiProcessDetailsStorageKey("../other")).toBeNull();
    saveAiProcessDetailsExpanded("bad id", true, storage);
    expect(storage.values.size).toBe(1);
    storage.values.set("tongpin.ai.process-details.v1:member-b", "{\"expanded\":true}");
    expect(readAiProcessDetailsExpanded("member-b", storage)).toBe(false);
  });

  it("falls back safely when storage is missing or throws", () => {
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } };
    expect(readAiProcessDetailsExpanded("member-a", throwing)).toBe(false);
    expect(() => saveAiProcessDetailsExpanded("member-a", true, throwing)).not.toThrow();
    expect(readAiProcessDetailsExpanded("member-a", null)).toBe(false);
    expect(() => saveAiProcessDetailsExpanded("member-a", true, null)).not.toThrow();
    // Node test runs have no window: the accessor itself must not throw.
    expect(aiProcessDetailsStorage()).toBeNull();
  });
});
