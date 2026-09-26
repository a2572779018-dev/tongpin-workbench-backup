// Derived from OpenSquilla (https://github.com/TokenRhythm/opensquilla @ d27ba0e, Apache-2.0),
// ported to TypeScript and modified for Tongpin. See THIRD_PARTY_NOTICES.md.
import type { AiChatRequest, AiUsage } from "../../../../shared/ai";
import {
  OPENSQUILLA_INPUT_LIMITS, parseOpenSquillaRouteDecision,
  type AiOpenSquillaRouteDecision, type AiOpenSquillaRouteInput,
} from "../../../../shared/aiOpenSquilla";
import { pyStrip, pyTail } from "./pyCodePoints";

/*
 * Renderer side of the desktop OpenSquilla router. The web build has no
 * bridge and simply sends no decision; the server then keeps the built-in
 * quick-tier routing. A slow or failed local router never blocks a send.
 */

export type OpenSquillaBridgeResult = { ok: true; decision: unknown } | { ok: false; code: string };
export interface OpenSquillaDesktopBridge {
  route(input: AiOpenSquillaRouteInput): Promise<OpenSquillaBridgeResult>;
  warmup(): Promise<{ ok: boolean; code?: string }>;
}

export interface OpenSquillaTranscriptMessage {
  role: "user" | "assistant";
  content: string;
  status?: string;
  usage?: Pick<AiUsage, "outputTokens" | "estimated">;
}

/** Budget for the local decision before the send proceeds without it. */
export const OPENSQUILLA_ROUTE_WAIT_MS = 3_000;

function contextText(content: string): string | null {
  // OpenSquilla runtime.py: strip, skip empty, keep the last 8000 characters.
  const text = pyStrip(content);
  return text ? pyTail(text, OPENSQUILLA_INPUT_LIMITS.contextCharacters) : null;
}

/**
 * OpenSquilla `TurnRunner._router_history_context` over this conversation:
 * the last four earlier user texts and the most recent assistant reply with
 * its provider-reported output tokens. Failed or in-flight replies are not
 * part of the transcript the model saw, so they are skipped like the chat
 * request does.
 */
export function openSquillaRouteInput(conversationId: string, earlier: readonly OpenSquillaTranscriptMessage[], message: string): AiOpenSquillaRouteInput {
  const transcript = earlier.filter(item => !["error", "thinking", "typing"].includes(item.status ?? "ready"));
  const userTexts = transcript.filter(item => item.role === "user").map(item => contextText(item.content)).filter((text): text is string => text !== null);
  let prevAssistantText: string | null = null, prevAssistantOutputTokens: number | null = null;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item.role !== "assistant") continue;
    const text = contextText(item.content);
    if (!text) continue;
    prevAssistantText = text;
    const tokens = item.usage && !item.usage.estimated ? item.usage.outputTokens : undefined;
    if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0 && tokens <= OPENSQUILLA_INPUT_LIMITS.outputTokens) prevAssistantOutputTokens = tokens;
    break;
  }
  return {
    conversationId,
    message,
    historyUserTexts: userTexts.slice(-OPENSQUILLA_INPUT_LIMITS.historyTurns),
    prevAssistantText,
    prevAssistantOutputTokens,
  };
}

export async function requestOpenSquillaRoute(bridge: OpenSquillaDesktopBridge | undefined, input: AiOpenSquillaRouteInput, waitMs = OPENSQUILLA_ROUTE_WAIT_MS): Promise<AiOpenSquillaRouteDecision | null> {
  if (!bridge?.route) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      bridge.route(input),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs); }),
    ]);
    return result && result.ok ? parseOpenSquillaRouteDecision(result.decision) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Adds the local decision to a quick-tier conversational turn. Tool
 * executions, other tiers and the web build are left untouched.
 */
export async function attachOpenSquillaRoute(
  request: AiChatRequest,
  conversationId: string,
  messages: readonly OpenSquillaTranscriptMessage[],
  bridge: OpenSquillaDesktopBridge | undefined = typeof window === "undefined" ? undefined : window.tongpin?.openSquilla,
): Promise<AiChatRequest> {
  if (request.mode !== "quick" || !bridge || request.retryOf) return request;
  if (request.outputFormat && request.outputFormat !== "text" && request.outputFormat !== "dispatch") return request;
  const current = messages.at(-1);
  if (!current || current.role !== "user" || !current.content.trim() || current.content.length > OPENSQUILLA_INPUT_LIMITS.messageCharacters) return request;
  const decision = await requestOpenSquillaRoute(bridge, openSquillaRouteInput(conversationId, messages.slice(0, -1), current.content));
  if (decision) request.openSquillaRoute = decision;
  return request;
}

/** Loads the model before the first quick-tier send; failures stay silent. */
export function warmOpenSquillaRouter(bridge: OpenSquillaDesktopBridge | undefined = typeof window === "undefined" ? undefined : window.tongpin?.openSquilla): void {
  if (!bridge?.warmup) return;
  void bridge.warmup().catch(() => undefined);
}
