import { describe, expect, it } from "vitest";
import type { AiChatRequest } from "../../shared/ai";
import { chatInstructions, parseChatCapabilities, RICH_BLOCKS, VOICE_CALL_STYLE } from "./capabilities";
import { multiAgentSettingsFor } from "./multiAgentRun";
import { tierReasoningEffort } from "./provider";

const base: AiChatRequest = { requestId: "voice-call-request-0001", mode: "standard", messages: [{ role: "user", content: "明天要带伞吗" }] };

describe("语音通话 turns", () => {
  it("accepts only a literal true flag on ordinary answers", () => {
    expect(parseChatCapabilities({ voiceCall: true })).toEqual({ voiceCall: true });
    expect(parseChatCapabilities({ voiceCall: true, outputFormat: "dispatch" })).toMatchObject({ voiceCall: true, outputFormat: "dispatch" });
    expect(parseChatCapabilities({})).not.toHaveProperty("voiceCall");
    for (const voiceCall of [false, "true", 1, null]) expect(() => parseChatCapabilities({ voiceCall })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseChatCapabilities({ voiceCall: true, outputFormat: "image_plan" })).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("asks for short spoken replies instead of Markdown and rich blocks", () => {
    const spoken = chatInstructions({ ...base, voiceCall: true });
    expect(spoken).toContain(VOICE_CALL_STYLE);
    expect(spoken).not.toContain(RICH_BLOCKS);
    expect(spoken).not.toContain("标准 Markdown");
    const typed = chatInstructions(base);
    expect(typed).toContain(RICH_BLOCKS);
    expect(typed).not.toContain(VOICE_CALL_STYLE);
  });

  it("keeps tool dispatch for spoken requests, asking for spoken text instead of Markdown", () => {
    const spoken = chatInstructions({ ...base, voiceCall: true, outputFormat: "dispatch" });
    expect(spoken).toContain("<tool_request>");
    expect(spoken).toContain("直接用口语回答");
    expect(spoken).not.toContain("可在必要时使用 Markdown");
    expect(chatInstructions({ ...base, outputFormat: "dispatch" })).toContain("可在必要时使用 Markdown");
  });

  it("thinks briefly on a deep/Pro tier during a call, as configured otherwise", () => {
    expect(tierReasoningEffort({ voiceCall: true }, "high")).toBe("low");
    expect(tierReasoningEffort({}, "high")).toBe("high");
  });

  it("keeps a voice turn on the single-agent path even on a 多 Agent tier", () => {
    const route = { legacy: false, multiAgent: { maxAgents: 3 } } as unknown as Parameters<typeof multiAgentSettingsFor>[0];
    expect(multiAgentSettingsFor(route, base)).toBeDefined();
    expect(multiAgentSettingsFor(route, { ...base, voiceCall: true })).toBeUndefined();
  });
});
