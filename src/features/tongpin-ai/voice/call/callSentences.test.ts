import { describe, expect, it } from "vitest";
import { extractSentences, extractSentencesForAudio, getMessageContentParts, newSpeechParts } from "./callSentences";

describe("语音通话 sentence parts (Open WebUI split rule with Chinese ends)", () => {
  it("splits Chinese at sentence ends and keeps closing quotes and runs", () => {
    expect(extractSentences("今天会下雨。记得带伞！“好吗？”还有呢……对")).toEqual(["今天会下雨。", "记得带伞！", "“好吗？”", "还有呢……", "对"]);
  });

  it("splits English only before a space, never inside numbers", () => {
    expect(extractSentences("It costs 3.5 dollars. Buy it now! ok")).toEqual(["It costs 3.5 dollars.", "Buy it now!", "ok"]);
  });

  it("joins very short Chinese parts with the next one", () => {
    expect(extractSentencesForAudio("好的。明天上午十点有雨，下午转晴。")).toEqual(["好的。明天上午十点有雨，下午转晴。"]);
    expect(extractSentencesForAudio("好的。明天上午十点有雨。下午转晴。")).toEqual(["好的。明天上午十点有雨。", "下午转晴。"]);
  });

  it("cleans Markdown and drops code and follow-up blocks before speaking", () => {
    const parts = getMessageContentParts("**结论**：会下雨。\n\n```followups\n[\"要带伞吗\"]\n```");
    expect(parts).toEqual(["结论：会下雨。"]);
  });

  it("holds back the growing tail while streaming and never skips a finished part", () => {
    const start = { queued: 0, clause: "" };
    expect(newSpeechParts("明天上午有", start, false).parts).toEqual([]);
    // One chunk finishing two sentences queues both (Open WebUI queued only the newest).
    expect(newSpeechParts("明天上午有雨。下午转晴，气温回升。晚", start, false)).toEqual({ parts: ["明天上午有雨。", "下午转晴，气温回升。"], progress: { queued: 2, clause: "" } });
    expect(newSpeechParts("明天上午有雨。下午转晴，气温回升。晚上有风。", { queued: 2, clause: "" }, false).parts).toEqual([]);
    expect(newSpeechParts("明天上午有雨。下午转晴，气温回升。晚上有风。", { queued: 2, clause: "" }, true).parts).toEqual(["晚上有风。"]);
  });

  it("starts the first sentence at its first comma, then says only the rest of it", () => {
    const first = newSpeechParts("明天上午有小雨，下午", { queued: 0, clause: "" }, false);
    expect(first).toEqual({ parts: ["明天上午有小雨，"], progress: { queued: 0, clause: "明天上午有小雨，" } });
    const second = newSpeechParts("明天上午有小雨，下午转晴。记得", first.progress, false);
    expect(second).toEqual({ parts: ["下午转晴。"], progress: { queued: 1, clause: "" } });
    // A short opening clause waits for the whole sentence.
    expect(newSpeechParts("好的，下", { queued: 0, clause: "" }, false).parts).toEqual([]);
    // Only the very first part starts early.
    expect(newSpeechParts("第一句说完了。第二句还在说，没", { queued: 1, clause: "" }, false).parts).toEqual([]);
  });
});
