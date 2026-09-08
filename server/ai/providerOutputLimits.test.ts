import { describe, expect, it } from "vitest";
import { AI_WORKSPACE_LIMITS } from "../../shared/aiWorkspace";
import { parseProviderResult } from "./provider";

describe("Provider content fits the workspace message contract", () => {
  const limit = AI_WORKSPACE_LIMITS.messageCharacters;
  it.each(["responses", "chat_completions"] as const)("preserves exactly the maximum %s text instead of silently truncating it", protocol => {
    const content = "字".repeat(limit);
    const value = protocol === "responses" ? { output_text: content } : { choices: [{ message: { content } }] };
    expect(parseProviderResult(value, protocol).content).toBe(content);
  });
  it("bounds the combined Responses output across text parts, not just each individual part", () => {
    const content = [{ type: "output_text", text: "a".repeat(limit) }, { type: "output_text", text: "b" }];
    expect(() => parseProviderResult({ output: [{ type: "message", content }] }, "responses")).toThrow(expect.objectContaining({ code: "AI_RESPONSE_TOO_LONG" }));
  });
  it("rejects null characters that the workspace contract cannot persist, without silently changing content", () => {
    expect(() => parseProviderResult({ output_text: "before\u0000after" }, "responses")).toThrow(expect.objectContaining({ code: "AI_PROVIDER_RESPONSE" }));
  });
});
