import { describe, expect, it, vi } from "vitest";
import type { AiChatRequest } from "../../../../shared/ai";
import type { AiOpenSquillaRouteDecision } from "../../../../shared/aiOpenSquilla";
import { attachOpenSquillaRoute, openSquillaRouteInput, requestOpenSquillaRoute, type OpenSquillaDesktopBridge, type OpenSquillaTranscriptMessage } from "./desktopBridge";

const decision: AiOpenSquillaRouteDecision = {
  router: "opensquilla", version: "v4.2-phase3", bundle: "90afd16eaf9a", routeClass: "R1", tier: "c1",
  probabilities: [0.3, 0.6, 0.05, 0.05], confidence: 0.6, margin: 0.3, difficulty: 0.85,
  thinkingMode: "T2", promptPolicy: "P1", flags: [], gates: [], latencyMs: 41,
};
const bridge = (route: OpenSquillaDesktopBridge["route"]): OpenSquillaDesktopBridge => ({ route, warmup: async () => ({ ok: true }) });
const request = (extra: Partial<AiChatRequest> = {}): AiChatRequest => ({ requestId: "request-0123456789ab", mode: "quick", outputFormat: "dispatch", messages: [{ role: "user", content: "帮我写周报" }], ...extra });
const turn = (role: "user" | "assistant", content: string, extra: Partial<OpenSquillaTranscriptMessage> = {}): OpenSquillaTranscriptMessage => ({ role, content, ...extra });

describe("OpenSquilla router input from a conversation", () => {
  it("mirrors OpenSquilla's transcript context: four stripped user turns, last assistant reply and its output tokens", () => {
    const earlier = [
      turn("user", "one"), turn("assistant", "a1", { usage: { outputTokens: 10, estimated: false } }),
      turn("user", "  two  "), turn("user", "   "), turn("user", "three"), turn("user", "four"),
      turn("user", "five"), turn("assistant", "  final answer \n", { usage: { outputTokens: 321, estimated: false } }),
      turn("assistant", "网络中断", { status: "error" }), turn("assistant", "", { status: "thinking" }),
    ];
    expect(openSquillaRouteInput("conversation-a", earlier, "继续")).toEqual({
      conversationId: "conversation-a", message: "继续",
      historyUserTexts: ["two", "three", "four", "five"],
      prevAssistantText: "final answer", prevAssistantOutputTokens: 321,
    });
  });

  it("keeps the last 8000 code points of long context and ignores estimated usage", () => {
    const long = `${"前".repeat(100)}${"\u{1f600}".repeat(8000)}`;
    const routed = openSquillaRouteInput("c", [turn("user", long), turn("assistant", long, { usage: { outputTokens: 900, estimated: true } })], "x");
    expect([...routed.historyUserTexts[0]]).toHaveLength(8000);
    expect(routed.historyUserTexts[0].startsWith("\u{1f600}")).toBe(true);
    expect(routed.prevAssistantOutputTokens).toBeNull();
  });
});

describe("attaching the desktop decision to a chat request", () => {
  it("adds a validated decision to quick-tier conversational turns only", async () => {
    const route = vi.fn(async () => ({ ok: true as const, decision }));
    const messages = [turn("user", "hi"), turn("assistant", "hello"), turn("user", "帮我写周报")];
    const quick = await attachOpenSquillaRoute(request(), "conversation-a", messages, bridge(route));
    expect(quick.openSquillaRoute).toEqual(decision);
    expect(route).toHaveBeenCalledWith({ conversationId: "conversation-a", message: "帮我写周报", historyUserTexts: ["hi"], prevAssistantText: "hello", prevAssistantOutputTokens: null });
    for (const skipped of [request({ mode: "standard" }), request({ outputFormat: "image_plan" }), request({ retryOf: "request-original-000", retryMode: "regenerate" })]) {
      expect((await attachOpenSquillaRoute(skipped, "conversation-a", messages, bridge(route))).openSquillaRoute).toBeUndefined();
    }
    expect(route).toHaveBeenCalledTimes(1);
    expect((await attachOpenSquillaRoute(request(), "conversation-a", messages, undefined)).openSquillaRoute).toBeUndefined();
  });

  it("never blocks or poisons a send: failures, invalid results and slow routers yield no decision", async () => {
    vi.useFakeTimers();
    try {
      const input = openSquillaRouteInput("c", [], "x");
      await expect(requestOpenSquillaRoute(bridge(async () => ({ ok: false, code: "OPENSQUILLA_RUNTIME_FAILED" })), input)).resolves.toBeNull();
      await expect(requestOpenSquillaRoute(bridge(async () => { throw new Error("ipc"); }), input)).resolves.toBeNull();
      await expect(requestOpenSquillaRoute(bridge(async () => ({ ok: true, decision: { ...decision, tier: "c9" } })), input)).resolves.toBeNull();
      const slow = requestOpenSquillaRoute(bridge(() => new Promise(() => undefined)), input, 3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(slow).resolves.toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
