import { describe, expect, it } from "vitest";
import { AI_PERSONA_EXPRESSIONS } from "../../../../shared/aiPersona";
import { CHARACTER_EXPRESSIONS, didCharacterReplyComplete, resolveCharacterExpression } from "./characterExpression";

describe("Fleur expression selection", () => {
  it("offers every exported impression plus automatic task feedback", () => {
    expect(CHARACTER_EXPRESSIONS.map(option => option.id)).toEqual([...AI_PERSONA_EXPRESSIONS]);
    expect(new Set(CHARACTER_EXPRESSIONS.map(option => option.id)).size).toBe(14);
  });
  it("keeps manual expressions for idle without falsely indicating task success", () => {
    expect(resolveCharacterExpression("smitten")).toEqual({ mood: "happy", says: "smitten" });
    expect(resolveCharacterExpression("yes", "error")).toEqual({ mood: "confused", says: "question" });
    expect(resolveCharacterExpression("zzz", "waiting")).toEqual({ mood: "thinking", says: "hmm" });
    expect(resolveCharacterExpression("nope", "completed")).toEqual({ mood: "happy", says: "yes" });
    expect(resolveCharacterExpression("auto", "typing")).toEqual({ mood: "listening", says: "none" });
    expect(resolveCharacterExpression()).toEqual({ mood: "idle", says: "none" });
  });
  it("celebrates only the same current reply completing, not a request in another conversation", () => {
    const pending = { conversationId: "a", messageId: "reply", role: "assistant" as const, status: "thinking" as const };
    expect(didCharacterReplyComplete(pending, { ...pending, status: "ready" })).toBe(true);
    expect(didCharacterReplyComplete(pending, { ...pending, conversationId: "b", status: "ready" })).toBe(false);
    expect(didCharacterReplyComplete(pending, { ...pending, messageId: "older-reply", status: "ready" })).toBe(false);
    expect(didCharacterReplyComplete(pending, { ...pending, status: "error" })).toBe(false);
    expect(didCharacterReplyComplete(pending, { ...pending, status: "stopped" })).toBe(false);
    expect(didCharacterReplyComplete({ ...pending, status: "ready" }, { ...pending, status: "ready" })).toBe(false);
  });
});
