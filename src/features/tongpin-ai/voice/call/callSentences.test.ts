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
    expect(newSpeechParts("明天上午有雨，", 0, false)).toEqual([]);
    // One chunk finishing two sentences queues both (Open WebUI queued only the newest).
    expect(newSpeechParts("明天上午有雨。下午转晴，气温回升。晚", 0, false)).toEqual(["明天上午有雨。", "下午转晴，气温回升。"]);
    expect(newSpeechParts("明天上午有雨。下午转晴，气温回升。晚上有风。", 2, false)).toEqual([]);
    expect(newSpeechParts("明天上午有雨。下午转晴，气温回升。晚上有风。", 2, true)).toEqual(["晚上有风。"]);
  });
});
