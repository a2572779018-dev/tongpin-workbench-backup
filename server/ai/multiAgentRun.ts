import type { AiChatBudget, AiChatPreflight, AiChatRequest, AiChatResponse, AiDispatchDecision, AiMode, AiSource, AiUsage } from "../../shared/ai";
import type { AiPersonaProfile } from "../../shared/aiPersona";
import type { AiRunEvent, AiRunEventPayload, AiToolProgress } from "../../shared/aiRunEvents";
import { AI_CITATION_LIMITS } from "../../shared/aiCitations";
import {
  AI_MULTI_AGENT_LIMITS, boundedMultilineText, boundedText, type AiMultiAgentSettings, type AiSubagentFailure, type AiSubagentPlanItem, type AiSubagentUpdate,
} from "../../shared/aiMultiAgent";
import { chatInstructions, chatMessages, SAFETY } from "./capabilities";
import { parseAiDispatchDecision } from "./dispatch";
import { generationDiagnostic } from "./generationDiagnostic";
import { validConversationId, type AiHarness, type ResolvedHarnessRoute } from "./harness";
import {
  combineAbortSignals, MultiAgentSources, parseMultiAgentPlan, runIsolatedSubagent, runWithConcurrencyLimit, subagentSummary, truncateErrorMessage,
  type IsolatedOutcome, type MultiAgentPlan,
} from "./multiAgentOrchestrator";
import {
  appendToLastUser, coordinatorProtocol, guidanceBlock, subagentInstructions, subagentUserMessage, subagentUserMessageBound, SYNTHESIS_PROTOCOL,
  synthesisReference, synthesisReferenceBound, unsynthesizedAnswer, utf8Bytes, type SynthesisReport,
} from "./multiAgentPrompts";
import { AI_TIMEOUT_MS, isProviderRejection, parseProviderResult, providerBody, readProviderHttpError, readProviderResponse, supportsOfficialPublicSummary, type AiTransport } from "./provider";
import { parseProviderPublicSummary, parsePublicExplanation, providerPublicSummaryFromResponse, stripToolRequestMarkup, supportsPublicExplanation } from "./publicExplanation";
import { searchCallLimit } from "./searchPolicy";
import { AiError } from "./security";
import type { AiStore, StoredProvider, StoredRequest } from "./storage";
import { createVisibleStream } from "./visibleStream";

/*
 * 同频「多 Agent 协作」execution for one member request (strategy
 * `multi_agent`). The orchestration primitives are adapted open-source code
 * (multiAgentOrchestrator.ts); this module is the 同频 integration: one
 * quota reservation covering the worst case, 同频's provider transport,
 * journaled run events, harness trace and a single ledger settlement.
 *
 * Flow: coordinator (answer directly | tool request | plan) → up to 5
 * isolated sub-agents with at most `maxConcurrency` in flight → synthesis.
 */

/** Same conservative allowance as service.ts `SEARCH_INPUT_RESERVE`. */
export const MULTI_AGENT_SEARCH_INPUT_RESERVE = 32768;
/** Timing bounds. Tests may shorten them; production code never mutates them. */
export const multiAgentTiming = {
  callTimeoutMs: AI_TIMEOUT_MS,
  subagentTimeoutMs: 90_000,
  subagentPhaseMs: 180_000,
  minSubagentStartMs: 5_000,
  progressIntervalMs: 1_200,
  guidanceTimeoutMs: 3_000,
};
/** Worst-case wall time; a pending request older than this is recovered as uncertain. */
export function multiAgentDeadlineMs(): number {
  return multiAgentTiming.callTimeoutMs * 2 + multiAgentTiming.subagentPhaseMs;
}

// ---------------------------------------------------------------------------
// Pending user guidance hook
// ---------------------------------------------------------------------------

/** Boundaries between orchestration steps where guidance can be injected. */
export type MultiAgentCheckpoint = "before_coordinator" | "before_subagents" | "before_synthesis";
export interface MultiAgentGuidanceContext {
  checkpoint: MultiAgentCheckpoint;
  tenantId: string;
  userId: string;
  requestId: string;
  conversationId: string;
}
/**
 * Returns the member's pending mid-run corrections for this request (the
 * separately developed "pending user guidance" helper). Items are consumed by
 * the hook itself; the run bounds them (≤3 items, ≤600 characters in total),
 * appends them to the next model turn as user text — coordinator user message,
 * every sub-agent's task, or the synthesis reference — and ignores errors or
 * a hook slower than `multiAgentTiming.guidanceTimeoutMs`.
 */
export type MultiAgentPendingGuidance = (context: MultiAgentGuidanceContext) => readonly string[] | undefined | Promise<readonly string[] | undefined>;
let pendingGuidanceHook: MultiAgentPendingGuidance | undefined;
export function setMultiAgentPendingGuidance(hook: MultiAgentPendingGuidance | undefined): void { pendingGuidanceHook = hook; }

const GUIDANCE_ITEMS = 3;
const GUIDANCE_CODE_POINTS = 600;
const GUIDANCE_BYTES = utf8Bytes(guidanceBlock(["-", "-", "-"])) + GUIDANCE_CODE_POINTS * 4;
/** What one checkpoint carries, so a hook can take only items that fit whole. */
export const MULTI_AGENT_GUIDANCE_LIMITS = Object.freeze({ items: GUIDANCE_ITEMS, codePoints: GUIDANCE_CODE_POINTS });

function boundGuidance(items: readonly string[] | undefined): string[] {
  const result: string[] = [];
  let budget = GUIDANCE_CODE_POINTS;
  for (const item of items ?? []) {
    if (result.length >= GUIDANCE_ITEMS || budget <= 0) break;
    const text = boundedMultilineText(item, budget);
    if (!text) continue;
    result.push(text);
    budget -= [...text].length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cancellation registry (the member's Stop button)
// ---------------------------------------------------------------------------

class MultiAgentCancelled extends Error {
  constructor() { super("已停止本次多 Agent 协作"); this.name = "MultiAgentCancelled"; }
}
const activeRuns = new Map<string, AbortController>();
const runKey = (tenantId: string, userId: string, requestId: string) => `${tenantId}\u0000${userId}\u0000${requestId}`;

/** Aborts every in-flight and queued model call of this member's run. */
export function cancelMultiAgentRun(tenantId: string, userId: string, requestId: string): boolean {
  const controller = activeRuns.get(runKey(tenantId, userId, requestId));
  if (!controller || controller.signal.aborted) return false;
  controller.abort(new MultiAgentCancelled());
  return true;
}

// ---------------------------------------------------------------------------
// Eligibility and worst-case budget
// ---------------------------------------------------------------------------

/** Multi-agent handles ordinary text turns of a tier set to 多 Agent 协作 only;
 * tool plans, workflows and continuations keep the global rule. */
export function multiAgentSettingsFor(route: ResolvedHarnessRoute, request: AiChatRequest): AiMultiAgentSettings | undefined {
  if (route.legacy || !route.multiAgent) return undefined;
  if (request.outputFormat !== undefined && request.outputFormat !== "text" && request.outputFormat !== "dispatch") return undefined;
  if (request.workflowId || request.retryMode === "continue" || request.skillIds?.includes("agent-continuation-v1")) return undefined;
  // Sub-agents never get the hosted code_interpreter tool: a turn that was
  // auto-routed to code execution (computation wording or a data file) takes
  // the ordinary single-agent path, where the tool actually runs.
  if (request.codeInterpreter) return undefined;
  return route.multiAgent;
}

interface CallReserve { input: number; searchInput: number; output: number; converted: number; maxSearchCalls: number }
interface PreparedRun {
  settings: AiMultiAgentSettings;
  tierModel: string;
  subModel: string;
  subMode: AiMode;
  searchAvailable: boolean;
  needsSearch: boolean;
  resultBytes: number;
  /** Coordinator instructions depend on whether sub-agent search was reserved. */
  coordinator: { request: AiChatRequest; instructions: (search: boolean) => string; reserve: CallReserve };
  synthesis: { request: AiChatRequest; instructions: string; directInstructions: string; reserve: CallReserve };
  subagent: (search: boolean) => { instructions: string; reserve: CallReserve };
  parts: (search: boolean) => { input: number; output: number; converted: number; searchInput: number };
}

function reserveInput(instructionBytes: number, messages: AiChatRequest["messages"], images: number, visionReserve: number): number {
  // Same conservative shape as chatInputReserve: UTF-8 bytes of the transport
  // messages and instructions plus protocol overhead, never a token count.
  return utf8Bytes(JSON.stringify(messages)) + instructionBytes + messages.length * 32 + 256 + images * visionReserve;
}

function prepare(input: { request: AiChatRequest; provider: StoredProvider; route: ResolvedHarnessRoute; settings: AiMultiAgentSettings; persona: AiPersonaProfile; guidance: boolean }): PreparedRun {
  const { request, provider, route, settings, persona } = input;
  const L = AI_MULTI_AGENT_LIMITS;
  const tierModel = route.modelId;
  const subModel = settings.subAgentModelId ?? tierModel;
  // A different sub-agent model may not accept the tier's reasoning parameter.
  const subMode: AiMode = subModel === tierModel ? request.mode : "standard";
  const searchAvailable = provider.protocol === "responses" && Boolean(provider.webSearchEnabled) && Boolean(provider.webSearchQuotaTokens) && route.policy.autoWebSearch;
  const guidanceBytes = input.guidance ? GUIDANCE_BYTES : 0;
  const images = request.attachments?.filter(item => item.dataUrl).length ?? 0;
  const visionReserve = Number.isSafeInteger(provider.visionInputReserveTokens) && provider.visionInputReserveTokens! >= 256 && provider.visionInputReserveTokens! <= 131072 ? provider.visionInputReserveTokens! : 4096;

  const coordinatorRequest: AiChatRequest = { ...request, webSearch: false, webSearchMode: undefined };
  const coordinatorBase = chatInstructions(coordinatorRequest, persona, tierModel, { providerPublicSummary: false });
  const instructionsFor = (search: boolean, needsSearch: boolean) =>
    `${coordinatorBase}\n\n${coordinatorProtocol({ maxSubtasks: L.maxSubtasks, searchAvailable: search, needsSearch, maxSearchAgents: L.maxSearchAgents })}`;
  // Preflight and send must reserve the same amount whatever the search hint or choice.
  const coordinatorBytes = Math.max(...[true, false].flatMap(search => [true, false].map(needs => utf8Bytes(instructionsFor(search, needs)))));
  const coordinator = {
    request: coordinatorRequest, instructions: (search: boolean) => instructionsFor(searchAvailable && search, request.webSearch === true),
    reserve: { input: reserveInput(coordinatorBytes, chatMessages(coordinatorRequest), images, visionReserve) + guidanceBytes, searchInput: 0, output: route.maxOutputTokens, converted: 0, maxSearchCalls: 0 },
  };

  const synthesisRequest: AiChatRequest = { ...request, outputFormat: undefined, webSearch: false, webSearchMode: undefined, dispatchKinds: undefined };
  const providerPublicSummary = supportsOfficialPublicSummary(provider, synthesisRequest, tierModel);
  const directInstructions = chatInstructions(synthesisRequest, persona, tierModel, { providerPublicSummary });
  const synthesisInstructions = `${directInstructions}\n\n${SYNTHESIS_PROTOCOL}`;
  const resultBytes = Math.max(1024, settings.subAgentMaxOutputTokens * 3);
  const referenceBytes = synthesisReferenceBound({ maxSubtasks: L.maxSubtasks, resultBytes, maxSources: AI_CITATION_LIMITS.sources, guidanceBytes });
  const synthesis = {
    request: synthesisRequest, instructions: synthesisInstructions, directInstructions,
    reserve: { input: reserveInput(utf8Bytes(synthesisInstructions), chatMessages(synthesisRequest), images, visionReserve) + referenceBytes, searchInput: 0, output: route.maxOutputTokens, converted: 0, maxSearchCalls: 0 },
  };

  const searchInstructions = subagentInstructions(SAFETY, true), plainInstructions = subagentInstructions(SAFETY, false);
  const subInput = Math.max(utf8Bytes(searchInstructions), utf8Bytes(plainInstructions)) + subagentUserMessageBound(guidanceBytes) + 64 + 32 + 256;
  const searchLimit = searchCallLimit(provider);
  const convertedPerSearchAgent = (provider.webSearchQuotaTokens ?? 0) * searchLimit;
  const subagent = (search: boolean) => ({
    instructions: search ? searchInstructions : plainInstructions,
    reserve: { input: subInput, searchInput: search ? MULTI_AGENT_SEARCH_INPUT_RESERVE : 0, output: settings.subAgentMaxOutputTokens,
      converted: search ? convertedPerSearchAgent : 0, maxSearchCalls: search ? searchLimit : 0 },
  });
  const parts = (search: boolean) => {
    const searchAgents = search ? L.maxSearchAgents : 0;
    const searchInput = searchAgents * MULTI_AGENT_SEARCH_INPUT_RESERVE;
    return {
      input: coordinator.reserve.input + synthesis.reserve.input + L.maxSubtasks * subInput + searchInput,
      output: coordinator.reserve.output + synthesis.reserve.output + L.maxSubtasks * settings.subAgentMaxOutputTokens,
      converted: searchAgents * convertedPerSearchAgent,
      searchInput,
    };
  };
  return { settings, tierModel, subModel, subMode, searchAvailable, needsSearch: request.webSearch === true, resultBytes, coordinator, synthesis, subagent, parts };
}

function partsTotal(parts: { input: number; output: number; converted: number }): number { return parts.input + parts.output + parts.converted; }

/** "search" when the worst case with sub-agent search fits, "plain" without search, else unaffordable. */
function affordable(prepared: PreparedRun, remainingTokens: number): "search" | "plain" | undefined {
  if (prepared.searchAvailable && remainingTokens >= partsTotal(prepared.parts(true))) return "search";
  if (remainingTokens >= partsTotal(prepared.parts(false))) return "plain";
  return undefined;
}

function preflightBudget(prepared: PreparedRun, search: boolean, maxOutputTokens: number): AiChatBudget {
  const parts = prepared.parts(search);
  return { inputReserve: parts.input - parts.searchInput, searchInputReserve: parts.searchInput, codeExecInputReserve: 0, convertedReserve: parts.converted, minOutputTokens: 16,
    minimumRequiredTokens: partsTotal(parts), availableOutputTokens: parts.output, maxOutputTokens };
}

/** Advisory preflight for a multi-agent turn. Undefined when the turn is not
 * multi-agent or its worst case does not fit: the ordinary single-agent
 * preflight (and send) then applies unchanged. */
export function multiAgentPreflight(input: { route: ResolvedHarnessRoute; request: AiChatRequest; provider: StoredProvider; persona: AiPersonaProfile; ordinary: AiChatPreflight }): AiChatPreflight | undefined {
  const settings = multiAgentSettingsFor(input.route, input.request);
  if (!settings || input.ordinary.reason === "request_in_progress" || input.ordinary.reason === "quota_exhausted") return undefined;
  const prepared = prepare({ ...input, settings, guidance: Boolean(pendingGuidanceHook) });
  const choice = affordable(prepared, input.ordinary.quota.remainingTokens);
  if (!choice) return undefined;
  return { canSend: true, reason: null, quota: input.ordinary.quota, budget: preflightBudget(prepared, choice === "search", input.route.maxOutputTokens) };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type MultiAgentSettle = (request: StoredRequest, usage: AiUsage, status: "completed" | "failed" | "uncertain", reason: string, content?: string, error?: AiError,
  extras?: Pick<AiChatResponse, "completion" | "analysisSummary" | "dispatch" | "sources" | "trace">) => boolean;
export interface MultiAgentHost {
  store: AiStore;
  transport: AiTransport;
  harness: AiHarness;
  settle: MultiAgentSettle;
  invalidateAvailability: () => void;
  /** providerIdempotencyKey(tenant, user, requestId, "chat") of the service. */
  idempotencyKey: (requestId: string) => Promise<string>;
}
export interface MultiAgentChatInput {
  userId: string;
  request: AiChatRequest;
  provider: StoredProvider;
  route: ResolvedHarnessRoute;
  key: string;
  persona: AiPersonaProfile;
  hash: string;
  parentAttempt?: StoredRequest;
  stream?: boolean;
  onEvent?: (event: AiRunEvent) => void;
  /** Transport-only opt-in; older clients reject the `subagent_update` type. */
  subagentEvents: boolean;
}

/**
 * Runs a multi-agent turn when the tier uses `multi_agent` and the worst case
 * (coordinator + 5 sub-agents + synthesis) can be reserved. Returns undefined
 * without side effects otherwise, so the caller continues on the ordinary path.
 */
export async function runMultiAgentChat(host: MultiAgentHost, input: MultiAgentChatInput): Promise<AiChatResponse | undefined> {
  const settings = multiAgentSettingsFor(input.route, input.request);
  if (!settings) return undefined;
  const { store } = host;
  const { userId, request } = input;
  const hook = pendingGuidanceHook;
  const prepared = prepare({ request, provider: input.provider, route: input.route, settings, persona: input.persona, guidance: Boolean(hook) });
  const conversationId = validConversationId(request.conversationId, request.requestId);
  const reservation = store.sql.transaction(() => {
    if (store.request(userId, request.requestId)) throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "AI 正在处理这条消息，请稍候");
    const busy = store.pending(userId).length + store.activeVideoJobs(userId).length >= 3
      || store.pendingForConversation(userId, conversationId).length > 0 || store.activeVideoForConversation(userId, conversationId).length > 0;
    const quota = store.quota(userId);
    // Busy or unaffordable: the ordinary path reports it exactly as before.
    const choice = busy ? undefined : affordable(prepared, quota.remainingTokens);
    if (!choice) return undefined;
    const parts = prepared.parts(choice === "search");
    const pending: StoredRequest = {
      requestId: request.requestId, userId, hash: input.hash, status: "pending", createdAt: new Date().toISOString(),
      expiresAt: Date.now() + multiAgentDeadlineMs() + 30_000, inputReserve: parts.input, outputReserve: parts.output, convertedReserve: parts.converted,
      kind: "chat", model: input.route.modelId, mode: request.mode, conversationId, providerId: input.route.providerId,
    };
    quota.reservedTokens += partsTotal(parts);
    store.saveQuota(userId, quota); store.saveRequest(pending);
    // Only this run is recorded as multi_agent; its tool budget is one proposal.
    pending.harnessRunId = host.harness.startRun(userId, request, { ...input.route, policy: { ...input.route.policy, strategy: "multi_agent" } });
    pending.attempt = { runId: input.parentAttempt?.attempt?.runId ?? input.parentAttempt?.harnessRunId ?? pending.harnessRunId ?? request.requestId, attemptId: request.requestId, ...(request.retryOf ? { parentAttemptId: request.retryOf } : {}) };
    store.saveRequestSnapshot(userId, request.requestId, request);
    store.saveRequest(pending);
    return { pending, search: choice === "search" };
  });
  if (!reservation) return undefined;
  return new MultiAgentRun(host, input, prepared, reservation.pending, reservation.search, conversationId, hook).execute();
}

interface CallUsage { inputTokens: number; outputTokens: number; convertedTokens: number; searchCalls: number; estimated: boolean; valid: boolean }
interface CallOutcome {
  raw: unknown;
  headers: Headers;
  content: string;
  status?: string;
  incompleteReason?: "output_limit" | "stream_interrupted";
  sources: AiSource[];
  searchCalls: number;
  completedSearchCalls: number;
  usage: CallUsage;
}
class CallFailure extends Error {
  constructor(readonly error: AiError) { super(error.message); this.name = "CallFailure"; }
}
interface CallSpec {
  label: string;
  model: string;
  mode: AiMode;
  request: AiChatRequest;
  instructions: string;
  reserve: CallReserve;
  search: boolean;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onSummary?: (delta: string) => void;
  onToolProgress?: (progress: AiToolProgress) => void;
}
interface CoordinatorResult { outcome: CallOutcome; content: string; analysisSummary?: string; plan: MultiAgentPlan }

const TOOL_LABELS: Record<Exclude<AiDispatchDecision["kind"], "text">, string> = { image: "图片生成", video: "视频生成", presentation: "PPT 生成", computer: "电脑操作" };
const PLAN_MARKER = /"(?:subtasks|tasks)"\s*:/;
const ANSWER_DECISION_CHARACTERS = 48;

/** The member's latest message, which a subtask must not merely restate. */
function lastUserText(messages: AiChatRequest["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && typeof message.content === "string") return message.content;
  }
  return "";
}

function tailPreview(text: string): string | undefined {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const points = [...clean], max = AI_MULTI_AGENT_LIMITS.previewCodePoints;
  return points.length > max ? `…${points.slice(-(max - 1)).join("").trimStart()}` : clean;
}

class MultiAgentRun {
  private readonly controller = new AbortController();
  private readonly ledger: CallUsage[] = [];
  private readonly sources = new MultiAgentSources();
  private buffered: { type: "answer_delta" | "public_summary_delta"; text: string } | undefined;
  private lastFlush = 0;
  private delegated = false;
  private coordinatorMode: "undecided" | "answer" | "plan" = "undecided";
  private coordinatorBuffer = "";
  private coordinatorWatch = "";
  private coordinatorSummary = "";
  private coordinatorSummaryRejected = false;
  private finalCall: { outcome: CallOutcome; outputReserve: number } | undefined;
  private finalSummary: string | undefined;

  constructor(
    private readonly host: MultiAgentHost,
    private readonly input: MultiAgentChatInput,
    private readonly prepared: PreparedRun,
    private readonly reserved: StoredRequest,
    private readonly search: boolean,
    private readonly conversationId: string,
    private readonly hook: MultiAgentPendingGuidance | undefined,
  ) {}

  private get requestId(): string { return this.input.request.requestId; }
  private get mode(): AiMode { return this.input.request.mode; }

  async execute(): Promise<AiChatResponse> {
    const key = runKey(this.host.store.tenantId, this.input.userId, this.requestId);
    activeRuns.set(key, this.controller);
    try { return await this.orchestrate(); }
    finally { if (activeRuns.get(key) === this.controller) activeRuns.delete(key); }
  }

  // --- events -------------------------------------------------------------

  private emit(payload: AiRunEventPayload, droppable = false): void {
    if (!this.input.stream) return;
    let event: AiRunEvent;
    try { event = this.host.store.appendRunEvent(this.input.userId, this.requestId, payload); }
    catch (error) { if (droppable) return; throw error; }
    try { this.input.onEvent?.(event); } catch { /* A closed subscriber cannot change billing or cancel an accepted task. */ }
  }

  private update(data: AiSubagentUpdate, droppable = false): void {
    if (!this.input.subagentEvents) return;
    this.flush();
    this.emit({ type: "subagent_update", data }, droppable);
  }

  private flush(): void {
    const pending = this.buffered;
    this.buffered = undefined;
    if (!pending?.text) return;
    this.emit({ type: pending.type, data: { delta: pending.text } });
    if (pending.type === "answer_delta") this.reserved.firstVisibleMs ??= Math.max(0, Date.now() - Date.parse(this.reserved.createdAt));
    this.lastFlush = Date.now();
  }

  private push(type: "answer_delta" | "public_summary_delta", delta: string): void {
    if (!delta) return;
    if (this.buffered && this.buffered.type !== type) this.flush();
    this.buffered ??= { type, text: "" };
    this.buffered.text += delta;
    if (this.buffered.text.length >= 256 || Date.now() - this.lastFlush >= 80) this.flush();
  }

  // --- guidance & cancellation ---------------------------------------------

  private throwIfCancelled(): void {
    if (this.controller.signal.aborted) throw new MultiAgentCancelled();
  }

  private async guidance(checkpoint: MultiAgentCheckpoint): Promise<string[]> {
    const hook = this.hook;
    if (!hook) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), multiAgentTiming.guidanceTimeoutMs); });
      const items = await Promise.race([Promise.resolve(hook({ checkpoint, tenantId: this.host.store.tenantId, userId: this.input.userId, requestId: this.requestId, conversationId: this.conversationId })), timeout]);
      return boundGuidance(items);
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
      this.throwIfCancelled();
    }
  }

  // --- provider calls --------------------------------------------------------

  private async call(spec: CallSpec): Promise<CallOutcome> {
    const { provider } = this.input;
    const reserve = spec.reserve;
    const conservative = (): CallUsage => ({ inputTokens: reserve.input + reserve.searchInput, outputTokens: reserve.output, convertedTokens: reserve.converted, searchCalls: 0, estimated: true, valid: false });
    let knownRejection = false;
    try {
      const body = providerBody(provider, spec.request, spec.model, reserve.output, this.input.persona, { stream: true, instructions: spec.instructions });
      const idempotencyKey = await this.host.idempotencyKey(`${this.requestId}:${spec.label}`);
      const response = await this.host.transport(`${provider.baseUrl}/${provider.protocol === "responses" ? "responses" : "chat/completions"}`, {
        method: "POST", headers: { Authorization: `Bearer ${this.input.key}`, "Content-Type": "application/json", Accept: provider.protocol === "responses" ? "text/event-stream, application/json" : "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body), signal: spec.signal,
      });
      if (!response.ok) { knownRejection = isProviderRejection(response.status); throw await readProviderHttpError(response, "chat"); }
      const raw = await readProviderResponse(response, {
        maxSearchCalls: reserve.maxSearchCalls,
        ...(spec.onText ? { onTextDelta: spec.onText } : {}), ...(spec.onSummary ? { onPublicSummaryDelta: spec.onSummary } : {}),
        ...(spec.onToolProgress ? { onToolProgress: spec.onToolProgress } : {}),
      });
      // A transport may hand back a partial stream after an abort; never a result.
      if (spec.signal.aborted) throw spec.signal.reason ?? new MultiAgentCancelled();
      const result = parseProviderResult(raw, provider.protocol);
      const valid = Boolean(result.usage && result.usage.inputTokens <= reserve.input + reserve.searchInput && result.usage.outputTokens <= reserve.output && result.searchCalls <= reserve.maxSearchCalls);
      const usage: CallUsage = valid
        ? { inputTokens: result.usage!.inputTokens, outputTokens: result.usage!.outputTokens, convertedTokens: spec.search ? (provider.webSearchQuotaTokens ?? 0) * result.searchCalls : 0, searchCalls: result.searchCalls, estimated: false, valid: true }
        : conservative();
      this.ledger.push(usage);
      return { raw, headers: response.headers, content: result.content, ...(result.status !== undefined ? { status: result.status } : {}),
        ...(result.incompleteReason ? { incompleteReason: result.incompleteReason } : {}), sources: result.sources, searchCalls: result.searchCalls,
        completedSearchCalls: result.completedSearchCalls, usage };
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError(502, "AI_CONNECTION_FAILED", "AI 服务连接失败或超时，请稍后重试；不确定用量已记录，请管理员核对");
      // Only an explicit pre-generation refusal is free; an abort after sending may still be billed.
      const notSent = knownRejection || safe.definitelyNotSent;
      this.ledger.push(notSent ? { inputTokens: 0, outputTokens: 0, convertedTokens: 0, searchCalls: 0, estimated: false, valid: false } : conservative());
      throw new CallFailure(safe);
    }
  }

  private timedSignal(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new AiError(502, "AI_CONNECTION_FAILED", "AI 服务处理超时")), timeoutMs);
    const combined = combineAbortSignals(this.controller.signal, timeout.signal);
    return { signal: combined.signal!, cleanup: () => { clearTimeout(timer); combined.cleanup(); } };
  }

  // --- coordinator -----------------------------------------------------------

  private coordinatorText(text: string): void {
    if (this.coordinatorMode === "plan") return;
    if (this.coordinatorMode === "answer") {
      this.coordinatorWatch = (this.coordinatorWatch + text).slice(-96);
      // A plan that follows streamed prose stops the stream; the final parse decides.
      if (/\{\s*"(?:subtasks|tasks)"\s*:/.test(this.coordinatorWatch)) { this.coordinatorMode = "plan"; return; }
      this.push("answer_delta", text);
      return;
    }
    this.coordinatorBuffer += text;
    if (PLAN_MARKER.test(this.coordinatorBuffer)) { this.coordinatorMode = "plan"; this.coordinatorBuffer = ""; return; }
    if (this.coordinatorBuffer.replace(/\s+/g, "").length >= ANSWER_DECISION_CHARACTERS) this.coordinatorToAnswer();
  }

  /** The coordinator is answering itself: drop the planning step and release held text. */
  private coordinatorToAnswer(): void {
    if (this.coordinatorMode === "answer") return;
    this.coordinatorMode = "answer";
    this.update({ phase: "direct" });
    if (!this.coordinatorSummaryRejected && this.coordinatorSummary) this.push("public_summary_delta", this.coordinatorSummary);
    this.coordinatorWatch = this.coordinatorBuffer.slice(-96);
    this.push("answer_delta", this.coordinatorBuffer);
    this.coordinatorBuffer = "";
  }

  private async callCoordinator(guidance: readonly string[]): Promise<CoordinatorResult> {
    const { coordinator, tierModel } = this.prepared;
    const request = { ...coordinator.request, messages: appendToLastUser(coordinator.request.messages, guidanceBlock(guidance)) };
    const visible = createVisibleStream(this.mode, text => this.coordinatorText(text), summary => {
      // A model-authored <analysis_summary> is released only for a direct answer.
      if (this.coordinatorMode === "answer") this.push("public_summary_delta", summary);
      else this.coordinatorSummary += summary;
    });
    const timed = this.timedSignal(multiAgentTiming.callTimeoutMs);
    try {
      const outcome = await this.call({ label: "coordinator", model: tierModel, mode: this.mode, request, instructions: coordinator.instructions(this.search), reserve: coordinator.reserve, search: false, signal: timed.signal, onText: delta => visible.feed(delta) });
      const explanation = supportsPublicExplanation(this.input.request) ? parsePublicExplanation(outcome.content, this.mode) : { content: outcome.content };
      const plan = parseMultiAgentPlan(explanation.content, { searchAllowed: this.search, request: lastUserText(this.input.request.messages) });
      return { outcome, content: explanation.content, ...(explanation.analysisSummary ? { analysisSummary: explanation.analysisSummary } : {}), plan };
    } finally { timed.cleanup(); }
  }

  // --- orchestration -----------------------------------------------------------

  private async orchestrate(): Promise<AiChatResponse> {
    try {
      this.emit({ type: "run_started", data: { startedAt: Date.parse(this.reserved.createdAt) } });
      this.update({ phase: "planning" });
      const coordinator = await this.callCoordinator(await this.guidance("before_coordinator"));
      this.throwIfCancelled();
      if (coordinator.plan.kind === "plan") return await this.delegate(coordinator.plan.subtasks);
      if (coordinator.plan.kind === "invalid") return await this.degradedDirect();
      return this.finishDirect(coordinator);
    } catch (error) {
      return this.fail(error);
    }
  }

  /** The coordinator answered (or asked for a tool) itself: the ordinary result. */
  private finishDirect(coordinator: CoordinatorResult): AiChatResponse {
    const { outcome } = coordinator;
    this.coordinatorToAnswer();
    const request = this.input.request;
    const analysisSummary = coordinator.analysisSummary ?? (this.coordinatorSummaryRejected ? undefined : boundedText(this.coordinatorSummary, 2000));
    this.finalCall = { outcome, outputReserve: this.prepared.coordinator.reserve.output };
    if (outcome.status === "incomplete" && coordinator.content.trim()) {
      let partial: string | undefined;
      try {
        const decision = parseAiDispatchDecision(coordinator.content, this.mode, { allowPlainText: true });
        if (decision.kind === "text") partial = decision.content;
      } catch { /* Never salvage a truncated action envelope. */ }
      if (partial) return this.settleSuccess({ content: partial, analysisSummary, status: "uncertain",
        completion: { state: "partial", reason: outcome.incompleteReason ?? "output_limit", canContinue: outcome.usage.valid } });
    }
    if (!coordinator.content.trim() || (outcome.status !== undefined && outcome.status !== "completed")) {
      throw outcome.status === "incomplete"
        ? new AiError(502, "AI_RESPONSE_INCOMPLETE", "AI 未能完成回复，可能达到输出上限，请管理员调整模型或单次输出上限")
        : new AiError(502, "AI_EMPTY_RESPONSE", "AI 未返回完整可显示的文字，请检查模型及输出上限");
    }
    let dispatch: AiDispatchDecision | undefined;
    if (request.outputFormat === "dispatch") {
      dispatch = parseAiDispatchDecision(coordinator.content, this.mode, { allowPlainText: true });
      // A model that ignores the tier allowlist must not start a closed tool.
      if (dispatch.kind !== "text" && request.dispatchKinds && !request.dispatchKinds.includes(dispatch.kind)) {
        dispatch = { kind: "text", content: `当前档位没有开放${TOOL_LABELS[dispatch.kind]}，这次没有调用该工具。你可以换用已开放该能力的档位，或直接告诉我需要的文字结果。` };
      }
    }
    const content = dispatch ? dispatch.kind === "text" ? dispatch.content : dispatch.clarification ?? "" : stripToolRequestMarkup(coordinator.content);
    const summary = dispatch?.kind === "text" && dispatch.analysisSummary ? dispatch.analysisSummary : analysisSummary;
    return this.settleSuccess({ content, ...(summary ? { analysisSummary: summary } : {}), ...(dispatch ? { dispatch } : {}), status: outcome.usage.valid ? "completed" : "uncertain" });
  }

  /** The coordinator returned a plan that failed validation: answer once, directly. */
  private async degradedDirect(): Promise<AiChatResponse> {
    this.coordinatorMode = "answer";
    this.update({ phase: "direct" });
    const { synthesis } = this.prepared;
    const outcome = await this.callFinal(synthesis.directInstructions, synthesis.request.messages);
    return this.finishFinal(outcome, undefined);
  }

  private async delegate(subtasks: AiSubagentPlanItem[]): Promise<AiChatResponse> {
    this.delegated = true;
    this.coordinatorMode = "plan";
    const { settings } = this.prepared;
    this.update({ phase: "plan", maxConcurrency: settings.maxConcurrency, subtasks });
    const guidance = await this.guidance("before_subagents");
    const phaseDeadline = Date.now() + multiAgentTiming.subagentPhaseMs;
    const reports = await runWithConcurrencyLimit(subtasks, settings.maxConcurrency, subtask => this.runSubagent(subtask, guidance, phaseDeadline), {
      signal: this.controller.signal,
      skipped: subtask => {
        this.update({ phase: "error", id: subtask.id, reason: "cancelled", message: "已停止，未执行" });
        return { subtask, status: "cancelled" as const };
      },
      failed: (subtask, _index, error) => {
        this.update({ phase: "error", id: subtask.id, reason: "failed", message: failureMessage("failed", error) });
        return { subtask, status: "failed" as const };
      },
    });
    this.throwIfCancelled();
    const synthesisGuidance = await this.guidance("before_synthesis");
    this.update({ phase: "synthesis" });
    const reference = synthesisReference(reports, this.sources.list, synthesisGuidance, this.prepared.resultBytes);
    let outcome: CallOutcome;
    try {
      outcome = await this.callFinal(this.prepared.synthesis.instructions, appendToLastUser(this.prepared.synthesis.request.messages, reference));
    } catch (error) {
      if (this.controller.signal.aborted) throw error;
      // The sub-agents' paid work is still returned, clearly marked as unsynthesized.
      this.host.invalidateAvailability();
      return this.settleSuccess({ content: unsynthesizedAnswer(reports), status: "uncertain", completion: { state: "partial", reason: "stream_interrupted", canContinue: false } });
    }
    return this.finishFinal(outcome, reports);
  }

  private async runSubagent(subtask: AiSubagentPlanItem, guidance: readonly string[], phaseDeadline: number): Promise<SynthesisReport> {
    const remaining = phaseDeadline - Date.now();
    if (remaining < multiAgentTiming.minSubagentStartMs) {
      this.update({ phase: "error", id: subtask.id, reason: "timeout", message: "协作时间已用完，子任务未开始" });
      return { subtask, status: "timeout" };
    }
    this.update({ phase: "start", id: subtask.id });
    const { prepared } = this;
    const call = prepared.subagent(subtask.search);
    let text = "", chars = 0, lastProgress = 0, progressEvents = 0;
    const visible = createVisibleStream(prepared.subMode, delta => {
      text += delta;
      chars += [...delta].length;
      const now = Date.now();
      if (progressEvents >= AI_MULTI_AGENT_LIMITS.progressEventsPerAgent || now - lastProgress < multiAgentTiming.progressIntervalMs) return;
      lastProgress = now; progressEvents += 1;
      const preview = tailPreview(text);
      this.update({ phase: "progress", id: subtask.id, chars, ...(preview ? { preview } : {}) }, true);
    }, () => { /* A sub-agent's public summary is not part of the member-visible run. */ });
    const request: AiChatRequest = { requestId: this.requestId, mode: prepared.subMode, messages: [{ role: "user", content: subagentUserMessage(subtask, guidance) }],
      ...(subtask.search ? { webSearch: true, webSearchMode: "auto" as const } : {}) };
    const timeoutMs = Math.min(multiAgentTiming.subagentTimeoutMs, remaining);
    const result: IsolatedOutcome<CallOutcome> = await runIsolatedSubagent({
      parentSignal: this.controller.signal, timeoutMs,
      run: signal => this.call({ label: subtask.id, model: prepared.subModel, mode: prepared.subMode, request, instructions: call.instructions, reserve: call.reserve,
        search: subtask.search, signal, onText: delta => visible.feed(delta),
        // Sub-agents only ever request web_search; any other tool progress is ignored here.
        ...(subtask.search ? { onToolProgress: progress => { if (progress.tool !== "web_search") return; this.update({ phase: "search", id: subtask.id, callId: progress.callId, status: progress.status,
          ...(progress.query ? { query: boundedText(progress.query, AI_MULTI_AGENT_LIMITS.queryCodePoints) } : {}),
          ...(progress.sourceCount !== undefined ? { sourceCount: progress.sourceCount } : {}) }, true); } } : {}) }),
    });
    if (!result.ok) {
      this.update({ phase: "error", id: subtask.id, reason: result.reason, message: failureMessage(result.reason, result.error, timeoutMs), durationMs: result.durationMs });
      // A timed-out sub-agent's partial text is still evidence, marked incomplete.
      return { subtask, status: result.reason === "failed" ? "failed" : result.reason, ...(result.reason === "timeout" && text.trim() ? { result: text.trim(), truncated: true } : {}) };
    }
    const outcome = result.value;
    const content = stripToolRequestMarkup(parsePublicExplanation(outcome.content, prepared.subMode).content);
    if (!content.trim()) {
      this.update({ phase: "error", id: subtask.id, reason: "failed", message: "子 Agent 没有返回可用内容", durationMs: result.durationMs });
      return { subtask, status: "failed" };
    }
    const numbers = this.sources.add(outcome.sources);
    const summary = subagentSummary(content);
    this.update({ phase: "stop", id: subtask.id, durationMs: result.durationMs, ...(summary ? { summary } : {}),
      searchCount: Math.min(outcome.searchCalls, AI_MULTI_AGENT_LIMITS.searchesPerAgent), sourceCount: outcome.sources.length, ...(numbers.length ? { sources: numbers } : {}) });
    return { subtask, status: "done", result: content, ...(outcome.status === "incomplete" ? { truncated: true } : {}), ...(numbers.length ? { sources: numbers } : {}) };
  }

  /** Synthesis (or the degraded direct answer): streams as the reply's main content. */
  private async callFinal(instructions: string, messages: AiChatRequest["messages"]): Promise<CallOutcome> {
    const { synthesis, tierModel } = this.prepared;
    const request = { ...synthesis.request, messages };
    let providerSummary = "", summaryRejected = false;
    const visible = createVisibleStream(this.mode, text => this.push("answer_delta", text), summary => this.push("public_summary_delta", summary));
    const onSummary = (delta: string) => {
      if (summaryRejected) return;
      if (!providerSummary) { delta = delta.trimStart(); if (!delta) return; }
      providerSummary += delta;
      if (!parseProviderPublicSummary(providerSummary)) { summaryRejected = true; providerSummary = ""; return; }
      this.push("public_summary_delta", delta);
    };
    const timed = this.timedSignal(multiAgentTiming.callTimeoutMs);
    try {
      const outcome = await this.call({ label: "synthesis", model: tierModel, mode: this.mode, request, instructions, reserve: synthesis.reserve, search: false, signal: timed.signal, onText: delta => visible.feed(delta), onSummary });
      const terminal = !summaryRejected && !providerSummary && supportsOfficialPublicSummary(this.input.provider, request, tierModel) ? providerPublicSummaryFromResponse(outcome.raw) : undefined;
      if (terminal) { providerSummary = terminal; this.push("public_summary_delta", terminal); }
      this.finalCall = { outcome, outputReserve: synthesis.reserve.output };
      this.finalSummary = summaryRejected ? undefined : providerSummary || undefined;
      return outcome;
    } finally { timed.cleanup(); }
  }

  private finishFinal(outcome: CallOutcome, reports: readonly SynthesisReport[] | undefined): AiChatResponse {
    const explanation = parsePublicExplanation(outcome.content, this.mode);
    const content = stripToolRequestMarkup(explanation.content);
    const analysisSummary = this.finalSummary ?? explanation.analysisSummary;
    const request = this.input.request;
    // The main chat sent a dispatch turn; a synthesized answer is its text decision.
    const dispatch: AiDispatchDecision | undefined = request.outputFormat === "dispatch" && content ? { kind: "text", content } : undefined;
    if (!content.trim()) {
      if (reports) return this.settleSuccess({ content: unsynthesizedAnswer(reports), status: "uncertain", completion: { state: "partial", reason: "stream_interrupted", canContinue: false } });
      throw new AiError(502, "AI_EMPTY_RESPONSE", "AI 未返回完整可显示的文字，请检查模型及输出上限");
    }
    const incomplete = outcome.status !== undefined && outcome.status !== "completed";
    return this.settleSuccess({ content, ...(analysisSummary ? { analysisSummary } : {}), ...(dispatch ? { dispatch } : {}),
      status: outcome.usage.valid && !incomplete ? "completed" : "uncertain",
      ...(incomplete ? { completion: { state: "partial" as const, reason: outcome.incompleteReason ?? "output_limit", canContinue: false } } : {}) });
  }

  // --- settlement ------------------------------------------------------------

  private usage(): AiUsage {
    const sum = (key: keyof Pick<CallUsage, "inputTokens" | "outputTokens" | "convertedTokens" | "searchCalls">) => this.ledger.reduce((total, entry) => total + entry[key], 0);
    const inputTokens = sum("inputTokens"), outputTokens = sum("outputTokens"), convertedTokens = sum("convertedTokens"), searchCalls = sum("searchCalls");
    const conservative = this.ledger.some(entry => entry.estimated);
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens + convertedTokens, estimated: conservative || convertedTokens > 0,
      ...(this.search ? { searchCalls, tokenUsageEstimated: conservative } : {}),
      ...(convertedTokens > 0 ? { convertedTokens, billingKind: "tokens_with_search" as const } : {}) };
  }

  private reason(prefix: string): string {
    const calls = this.ledger.length;
    const unknown = this.ledger.filter(entry => entry.estimated).length;
    const searches = this.ledger.reduce((total, entry) => total + entry.searchCalls, 0);
    return `${prefix}：共 ${calls} 次模型调用，${unknown ? `其中 ${unknown} 次用量未确认，按该次预留上限保守计入` : "按服务商实际 Token 用量"}${searches ? `，另含 ${searches} 次搜索的管理员设定折算额度` : ""}`;
  }

  private settleSuccess(options: { content: string; analysisSummary?: string; dispatch?: AiDispatchDecision; status: "completed" | "uncertain"; completion?: AiChatResponse["completion"] }): AiChatResponse {
    this.flush();
    const { store, harness } = this.host;
    const userId = this.input.userId;
    const usage = this.usage();
    if (this.finalCall) {
      const { outcome, outputReserve } = this.finalCall;
      this.reserved.generation = generationDiagnostic(outcome.raw, outcome.headers, this.input.provider.protocol, outputReserve, Date.parse(this.reserved.createdAt), outcome.usage.valid ? { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, totalTokens: outcome.usage.inputTokens + outcome.usage.outputTokens, estimated: false } : null);
    }
    const extras = { ...(options.completion ? { completion: options.completion } : {}), ...(options.analysisSummary ? { analysisSummary: options.analysisSummary } : {}),
      ...(options.dispatch ? { dispatch: options.dispatch } : {}), ...(this.sources.list.length ? { sources: [...this.sources.list] } : {}) };
    const settled = store.sql.transaction(() => {
      const trace = harness.finishRun(userId, this.requestId, options.status === "completed" ? "succeeded" : "uncertain");
      return this.host.settle(this.reserved, usage, options.status, this.reason(this.delegated ? "多 Agent 协作" : "多 Agent 协作（协调者直接回答）"), options.content, undefined, { ...extras, ...(trace ? { trace } : {}) });
    });
    if (!settled) {
      const final = store.request(userId, this.requestId);
      if (final?.result) return { ...final.result, quota: store.quota(userId) };
      throw new AiError(final?.error?.status ?? 502, final?.error?.code ?? "AI_REQUEST_UNCERTAIN", final?.error?.message ?? "请求已按中断记录，请管理员核对用量");
    }
    const response: AiChatResponse = { ...store.request(userId, this.requestId)!.result!, quota: store.quota(userId) };
    if (this.delegated) this.update({ phase: "finish", outcome: "done" });
    this.emitSettledUsage();
    this.emit({ type: "run_finished", data: { response } });
    return response;
  }

  private emitSettledUsage(): void {
    if (!this.input.stream || !this.ledger.length || !this.ledger.every(entry => entry.valid)) return;
    const status = this.host.store.request(this.input.userId, this.requestId)?.status;
    if (status !== "completed" && status !== "failed" && status !== "uncertain") return;
    const ledger = this.host.store.usage(this.input.userId).find(entry => entry.requestId === this.requestId && entry.kind === "chat");
    if (!ledger || ledger.status !== status) return;
    const { inputTokens, outputTokens, totalTokens, estimated, convertedTokens, billingKind, searchCalls, tokenUsageEstimated } = ledger;
    this.emit({ type: "usage_updated", data: { usage: { inputTokens, outputTokens, totalTokens, estimated,
      ...(convertedTokens !== undefined ? { convertedTokens } : {}), ...(billingKind !== undefined ? { billingKind } : {}),
      ...(searchCalls !== undefined ? { searchCalls } : {}), ...(tokenUsageEstimated !== undefined ? { tokenUsageEstimated } : {}) }, status, providerReported: true } });
  }

  private fail(error: unknown): never {
    const cancelled = this.controller.signal.aborted && this.controller.signal.reason instanceof MultiAgentCancelled;
    const safe = cancelled ? new AiError(409, "AI_RUN_CANCELLED", "已停止本次多 Agent 协作；已完成的调用按实际用量计入，被中断的调用按预留上限保守计入")
      : error instanceof CallFailure ? error.error : error instanceof AiError ? error
        : new AiError(502, "AI_CONNECTION_FAILED", "AI 服务连接失败或超时，请稍后重试；不确定用量已记录，请管理员核对");
    if (!cancelled) this.host.invalidateAvailability();
    const usage = this.usage();
    const status = this.ledger.some(entry => entry.estimated) ? "uncertain" : "failed";
    const { store, harness } = this.host;
    store.sql.transaction(() => {
      if (store.request(this.input.userId, this.requestId)?.status !== "pending") return;
      const trace = harness.finishRun(this.input.userId, this.requestId, status);
      this.host.settle(this.reserved, usage, status, this.reason(cancelled ? "多 Agent 协作已被成员停止" : "多 Agent 协作未完成"), undefined, safe, trace ? { trace } : undefined);
    });
    try {
      this.flush();
      if (this.delegated) this.update({ phase: "finish", outcome: cancelled ? "cancelled" : "failed" });
      this.emit({ type: "run_failed", data: { error: { code: safe.code, message: safe.message } } });
    } catch { /* The ledger is settled; a full journal cannot change it. */ }
    throw safe;
  }
}

/** Application-owned failure text for the sub-agent card (never provider text). */
function failureMessage(reason: AiSubagentFailure, error: unknown, timeoutMs?: number): string {
  if (reason === "timeout") return `超时未完成（${Math.max(1, Math.round((timeoutMs ?? multiAgentTiming.subagentTimeoutMs) / 1000))} 秒）`;
  if (reason === "cancelled") return "已停止";
  const cause = error instanceof CallFailure ? error.error : error;
  const message = cause instanceof AiError ? truncateErrorMessage(cause.message) : "子 Agent 调用失败";
  return boundedText(message, AI_MULTI_AGENT_LIMITS.errorCodePoints) ?? "子 Agent 调用失败";
}
