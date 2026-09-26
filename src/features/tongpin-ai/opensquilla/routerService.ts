// Derived from OpenSquilla (https://github.com/TokenRhythm/opensquilla @ d27ba0e, Apache-2.0),
// ported to TypeScript and modified for Tongpin. See THIRD_PARTY_NOTICES.md.
import {
  OPENSQUILLA_FLAGS, OPENSQUILLA_INPUT_LIMITS, OPENSQUILLA_ROUTER_VERSION,
  type AiOpenSquillaGate, type AiOpenSquillaRouteDecision, type AiOpenSquillaRouteInput,
} from "../../../../shared/aiOpenSquilla";
import type { OpenSquillaRouterEngine, OpenSquillaRouterInput, OpenSquillaRouterResult } from "./engine";
import { routeClassForTier, type RoutingHistoryEntry } from "./policy";
import { pyLen } from "./pyText";

/*
 * Session-level router state, as OpenSquilla's gateway keeps it in process
 * (`engine/steps/squilla_router.py`): per-conversation routing history of the
 * last five routed turns inside a 30-minute window, used for the history
 * feature channel, the deep-conversation rule and the KV-cache
 * anti-downgrade gate. One request is evaluated at a time.
 */

export class OpenSquillaInputError extends Error {}

type StoredEntry = Omit<RoutingHistoryEntry, "ageSeconds"> & { at: number };
type Engine = Pick<OpenSquillaRouterEngine, "manifest"> & {
  route(input: OpenSquillaRouterInput, options?: { rawEmbeddings?: Float32Array }): Promise<OpenSquillaRouterResult>;
};

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CONVERSATIONS = 256;
const MAX_QUEUE = 8;

function boundedText(value: unknown, label: string, maxCodePoints: number, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new OpenSquillaInputError(`${label} is invalid`);
  if (value.length > maxCodePoints * 2 || pyLen(value) > maxCodePoints) throw new OpenSquillaInputError(`${label} is too long`);
  return value;
}

export function validateRouteInput(value: unknown): AiOpenSquillaRouteInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OpenSquillaInputError("route input is invalid");
  const source = value as Record<string, unknown>;
  const keys = ["conversationId", "message", "historyUserTexts", "prevAssistantText", "prevAssistantOutputTokens"];
  if (Object.keys(source).some(key => !keys.includes(key))) throw new OpenSquillaInputError("route input has unknown fields");
  if (typeof source.conversationId !== "string" || !CONVERSATION_ID.test(source.conversationId)) throw new OpenSquillaInputError("conversation id is invalid");
  const message = boundedText(source.message, "message", OPENSQUILLA_INPUT_LIMITS.messageCharacters, false);
  if (!Array.isArray(source.historyUserTexts) || source.historyUserTexts.length > OPENSQUILLA_INPUT_LIMITS.historyTurns) throw new OpenSquillaInputError("history is invalid");
  const historyUserTexts = source.historyUserTexts.map(text => boundedText(text, "history", OPENSQUILLA_INPUT_LIMITS.contextCharacters));
  const prevAssistantText = source.prevAssistantText === null || source.prevAssistantText === undefined ? null
    : boundedText(source.prevAssistantText, "assistant text", OPENSQUILLA_INPUT_LIMITS.contextCharacters);
  const tokens = source.prevAssistantOutputTokens;
  if (tokens !== null && tokens !== undefined && (!Number.isSafeInteger(tokens) || Number(tokens) < 0 || Number(tokens) > OPENSQUILLA_INPUT_LIMITS.outputTokens)) throw new OpenSquillaInputError("output tokens are invalid");
  return { conversationId: source.conversationId, message, historyUserTexts, prevAssistantText, prevAssistantOutputTokens: typeof tokens === "number" ? tokens : null };
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function toRouteDecision(result: OpenSquillaRouterResult, bundle: string, latencyMs: number): AiOpenSquillaRouteDecision {
  const gates: AiOpenSquillaGate[] = [];
  if (result.gateway.confidenceGateApplied) gates.push("confidence_gate");
  if (result.gateway.complaintUpgradeApplied) gates.push("complaint_upgrade");
  if (result.gateway.antiDowngradeApplied) gates.push("anti_downgrade");
  const probabilities = result.probabilities.map(value => round(value)) as [number, number, number, number];
  return {
    router: "opensquilla",
    version: OPENSQUILLA_ROUTER_VERSION,
    bundle,
    routeClass: result.routeClass,
    tier: result.tier,
    probabilities,
    confidence: probabilities[["R0", "R1", "R2", "R3"].indexOf(result.routeClass)],
    margin: round(result.margin),
    difficulty: round(result.difficulty),
    thinkingMode: result.thinkingMode,
    promptPolicy: result.promptPolicy,
    flags: OPENSQUILLA_FLAGS.filter(flag => result.flags[flag]),
    gates,
    latencyMs: Math.max(0, Math.min(600_000, Math.round(latencyMs))),
  };
}

export class OpenSquillaRoutingService {
  private readonly history = new Map<string, StoredEntry[]>();
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;

  constructor(
    private readonly engine: Engine,
    readonly bundle: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!/^[0-9a-f]{12}$/.test(bundle)) throw new Error("bundle id must be 12 hex characters");
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    if (this.queued >= MAX_QUEUE) return Promise.reject(new OpenSquillaInputError("router queue is full"));
    this.queued += 1;
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => undefined);
    return run.finally(() => { this.queued -= 1; });
  }

  /** Recent routed turns of one conversation inside OpenSquilla's history window. */
  private recent(conversationId: string, at: number): StoredEntry[] {
    const policy = this.engine.manifest.gatewayPolicy;
    const cutoff = at - policy.routing_history_window_seconds * 1000;
    return (this.history.get(conversationId) ?? []).filter(entry => entry.at > cutoff).slice(-policy.max_routing_history);
  }

  private remember(conversationId: string, entries: StoredEntry[]): void {
    this.history.delete(conversationId);
    this.history.set(conversationId, entries);
    while (this.history.size > MAX_CONVERSATIONS) this.history.delete(this.history.keys().next().value!);
  }

  route(value: unknown): Promise<AiOpenSquillaRouteDecision> {
    const input = validateRouteInput(value);
    return this.serial(async () => {
      const at = this.now();
      const recent = this.recent(input.conversationId, at);
      const started = performance.now();
      const result = await this.engine.route({
        message: input.message,
        historyUserTexts: input.historyUserTexts.filter(Boolean),
        prevAssistantText: input.prevAssistantText,
        prevAssistantUsage: input.prevAssistantOutputTokens && input.prevAssistantOutputTokens > 0 ? { output_tokens: input.prevAssistantOutputTokens } : null,
        routingHistory: recent.map(({ at: entryAt, ...entry }) => ({ ...entry, ageSeconds: (at - entryAt) / 1000 })),
      });
      const latencyMs = performance.now() - started;
      const entry: StoredEntry = { routeClass: result.routeClass, finalRouteClass: routeClassForTier(result.tier), finalTier: result.tier, difficulty: result.difficulty, margin: result.margin, at };
      this.remember(input.conversationId, [...recent, entry].slice(-this.engine.manifest.gatewayPolicy.max_routing_history));
      return toRouteDecision(result, this.bundle, latencyMs);
    });
  }

  /** Compiles the WebAssembly kernels once; never touches routing history. */
  warmup(): Promise<number> {
    return this.serial(async () => {
      const started = performance.now();
      await this.engine.route({ message: "你好", historyUserTexts: [], prevAssistantText: null, prevAssistantUsage: null, routingHistory: [] });
      return performance.now() - started;
    });
  }

  forget(conversationId: string): void { this.history.delete(conversationId); }
}
