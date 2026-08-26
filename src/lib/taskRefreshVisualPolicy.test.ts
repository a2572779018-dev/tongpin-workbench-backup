import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../pages/MemberHome.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

describe("member task refresh visual policy", () => {
  it("uses skeletons only for the initial date load", () => {
    expect(source).toContain("async ({ showLoading = true } = {})");
    expect(source).toContain("if (showLoading) setLoading(true)");
    expect(source).toContain("if (showLoading) setLoading(false)");
  });

  it("keeps existing cards visible during realtime task synchronization", () => {
    const syncListener = source.slice(
      source.indexOf("const refreshTasks = () =>"),
      source.indexOf('window.removeEventListener("tongpin:task-sync"'),
    );
    expect(syncListener).toContain("loadTasks({ showLoading: false })");
    expect(syncListener).not.toContain("loadTasks();");
  });
});
