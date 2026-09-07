import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { conversationsForPersistence, typewriterDuration, typewriterOffset, TYPEWRITER_FRAME_MS } from "./chatPerformance";
import type { TongpinAIConversation } from "./types";

describe("bounded response playback", () => {
  it("finishes long cosmetic replies in at most 44 local frames", () => {
    expect(typewriterDuration("文".repeat(64_000))).toBe(2_200);
    expect(typewriterDuration("文".repeat(64_000)) / TYPEWRITER_FRAME_MS).toBe(44);
    expect(typewriterDuration("")).toBe(0);
    expect(typewriterDuration("好")).toBe(320);
  });
  it("catches up from elapsed time without splitting supplementary characters", () => {
    const text = "A😀中文";
    expect(text.slice(0, typewriterOffset(text, 0.4))).toBe("A");
    expect(text.slice(0, typewriterOffset(text, 0.6))).toBe("A😀");
    expect(typewriterOffset(text, 1)).toBe(text.length);
    expect(typewriterOffset(text, 2)).toBe(text.length);
    expect(typewriterOffset(text, -1)).toBe(0);
  });
  it("saves the whole received answer immediately, keeping unrelated message references stable", () => {
    const history: TongpinAIConversation[] = [{ id: "one", title: "合成对话", timeLabel: "刚刚", messages: [
      { id: "old", role: "user", content: "你好", time: "12:00" },
      { id: "new", role: "assistant", content: "完整的服务端回复", time: "12:01", status: "typing" },
    ] }, { id: "other", title: "不相关对话", timeLabel: "刚刚", messages: [] }];
    const saved = conversationsForPersistence(history);
    expect(saved[0].messages[1]).toMatchObject({ content: "完整的服务端回复", status: "ready" });
    expect(saved[0].messages[0]).toBe(history[0].messages[0]);
    expect(saved[1]).toBe(history[1]);
    expect(history[0].messages[1].status).toBe("typing");
  });
  it("never schedules a parent workspace update for each displayed character", () => {
    const page = readFileSync(new URL("../../pages/TongpinAIPage.tsx", import.meta.url), "utf8");
    const persistence = readFileSync(new URL("./useWorkspacePersistence.ts", import.meta.url), "utf8");
    expect(page).not.toContain("window.setTimeout(tick, 24)");
    expect(page).toContain("const persistentState = useMemo(");
    expect(persistence).not.toContain("JSON.stringify(state)");
  });
});
