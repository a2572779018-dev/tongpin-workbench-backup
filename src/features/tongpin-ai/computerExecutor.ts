import type { AiMode, AiQuota } from "../../../shared/ai";
import {
  COMPUTER_AGENT_LIMITS,
  type ComputerAgentBridge,
  type ComputerAgentEvent,
  type ComputerCandidate,
  type ComputerConsentResult,
  type ComputerDecisionRequest,
  type ComputerDecisionResponse,
  type ComputerExecutorFacts,
  type ComputerHistoryEntry,
  type ComputerObserveResult,
  type ComputerRunLimits,
  type ComputerRunOutcome,
  type ComputerRunReason,
  type ComputerRunStart,
  type ComputerStepResult,
  type ComputerTaskResponse,
  type ComputerTaskSpec,
} from "../../../shared/computerAgent";

/**
 * Renderer loop of the unified computer executor. It never decides by itself
 * what to do on screen: every step is
 *   observe (main, Cua Driver) → closed candidates (main) → Jev choice (server)
 *   → authorization + execution (main) → re-observe/verify,
 * and this module only applies the run policy between those calls: confidence
 * floors, reobserve-once-then-ask, done verification with executor evidence,
 * outcome classes, repeated-failure and budget stops.
 */

export type ComputerApi = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;

export interface ComputerRunRequest {
  /** Idempotency key of the task-spec request (one billed tier-LLM call). */
  requestId: string;
  mode: AiMode;
  conversationId: string;
  /** The member's own words. Shown only in the live panel; never persisted. */
  instruction: string;
  /** Dispatch summary from the chat turn, used only to resolve references. */
  contextHint?: string;
}

export type ComputerTimelinePhase = "observe" | "decide" | "authorize" | "execute" | "verify" | "reobserve" | "ask" | "done";
export interface ComputerTimelineStep {
  step: number;
  phase: ComputerTimelinePhase;
  observation?: ComputerObserveResult["display"];
  candidateCount?: number;
  choice?: { id: string; label: string; confidence: number; reserved: boolean; risk: ComputerCandidate["risk"] };
  authorization?: "allowed" | "extra_consent" | "denied";
  execution?: { status: ComputerStepResult; message: string; delivery?: "background" | "foreground" };
  verification?: { goalDone: number; previousEffect?: number; recipientMatch?: number; contentMatch?: number };
  points?: number;
  note?: string;
}

export interface ComputerQuestion {
  step: number;
  question: string;
  options: string[];
  /**
   * Offered only when Jev chose the granted send with confidence but cannot
   * verify the recipient or the text from the screen structure (WeChat does
   * not expose its message box): the label of the button with which the
   * member confirms they checked the app themselves.
   */
  confirmLabel?: string;
}

/** The member's reply: guidance for Jev, or the confirmation offered in `confirmLabel`. */
export type ComputerAnswer = string | { confirmed: true };

export interface ComputerRunResult {
  outcome: ComputerRunOutcome;
  reason: ComputerRunReason;
  /** Plain Chinese result for the chat reply (contains only task literals). */
  summary: string;
  steps: number;
  actions: number;
  points: number;
  runId?: string;
}

export interface ComputerRunCallbacks {
  onTask?(run: ComputerRunStart): void;
  onConsent?(state: "waiting" | "granted", detail?: ComputerConsentResult): void;
  onAgentEvent?(event: ComputerAgentEvent): void;
  onStep?(step: ComputerTimelineStep): void;
  onQuota?(quota: AiQuota): void;
  /** Ask the member in chat. Resolve with guidance text (or the offered confirmation), or null to stop. */
  askUser?(question: ComputerQuestion): Promise<ComputerAnswer | null>;
}

export interface ComputerRunDeps {
  api: ComputerApi;
  accountId: string;
  bridge: ComputerAgentBridge;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const REOBSERVE_DELAY_MS = 700;
const MAX_REOBSERVE_STREAK = 3;
const MAX_FAILURE_STREAK = 3;
/** Background refusals escalate to distinct foreground candidates; they get their own, separate budget. */
const MAX_BACKGROUND_MISSES = 3;
const MAX_BLOCKED_STREAK = 2;
const NEEDS_USER_THRESHOLD = 0.8;
const SEND_RECHECK_DELAY_MS = 1_500;
const AUTO_DONE_THRESHOLD = 0.9;

class RunStop extends Error {
  constructor(readonly outcome: ComputerRunOutcome, readonly reason: ComputerRunReason, message: string) { super(message); }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : "";
}
function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}
/** `@computer` is routing syntax, not part of the task. */
export function computerInstructionText(text: string): string {
  return text.replace(/(^|\s)@computer(?=\s|$|[，。！？,:;])/giu, "$1").replace(/\s+/gu, " ").trim();
}

/** A send was attempted, yet the input still holds the text and no new copy is visible. */
function sendStuck(task: ComputerTaskSpec, facts: ComputerExecutorFacts): boolean {
  const evidence = facts.sendEvidence;
  return task.irreversible?.kind === "send_message" && facts.irreversibleDone && Boolean(evidence && evidence.inputStillHasText === true && evidence.after <= evidence.before);
}

function sendVisible(facts: ComputerExecutorFacts): boolean {
  const evidence = facts.sendEvidence;
  return Boolean(evidence && evidence.after > evidence.before && evidence.inputStillHasText !== true);
}

/**
 * Done verification combines Jev's `goal_done` judgment with application-owned
 * executor facts. A send is verified only when the executor saw one more copy
 * of the granted text after its own send and the input box no longer holds it.
 */
export function evaluateComputerDone(task: ComputerTaskSpec, facts: ComputerExecutorFacts, goalDone: number): "verified" | "unconfirmed" | "not_done" {
  if (task.irreversible && !facts.irreversibleDone) return "not_done";
  if (task.irreversible?.kind === "send_message") {
    if (sendVisible(facts) && goalDone >= 0.5) return "verified";
    return "unconfirmed";
  }
  if (goalDone >= 0.6) return "verified";
  if (task.irreversible && facts.irreversibleDone) return "unconfirmed";
  return "not_done";
}

function verifiedSummary(task: ComputerTaskSpec, app: string, readout: readonly string[] = [], title: string | null = null): string {
  const irreversible = task.irreversible;
  if (irreversible?.kind === "send_message" && irreversible.recipient && irreversible.content) {
    return `已完成：已在「${app}」给「${irreversible.recipient}」发送“${irreversible.content}”，并在聊天记录中看到了这条消息。`;
  }
  // What the member asked for comes first: the goal and check can be long.
  const named = title ? `「${app}」当前的标题是“${title}”。` : "";
  const shown = readout.length ? `「${app}」显示的结果：${readout.join("、")}。` : "";
  // The planner usually ends the goal with its own full stop ("…告诉用户。").
  const goal = task.goal.replace(/[。．.！!？?；;，,、\s]+$/u, "");
  return `已完成：${named}${shown}${goal}。界面检查符合完成标准：${task.successCheck}`;
}

/** A task that asks to read something off the screen and report it. */
const READ_BACK_TASK = /(?:读取|读出|读一下|读给|告诉我|告诉用户|显示的?(?:结果|数字|数值|金额|数)|结果是|是多少|等于多少|得多少|多少钱)/u;
/**
 * Plain values only (numbers, amounts, percentages): words never leave the
 * screen this way, so screen text cannot bring instructions into the chat.
 * At most 12 digits: card, account and ID numbers are longer.
 */
const SCREEN_VALUE = /^[-−+]?[¥$€£]?\d[\d,，.．\s]*(?:[%％]|元)?$/u;
const MAX_VALUE_DIGITS = 12;
/** Controls and inputs, by role word (a keypad's digits are buttons, a page number is a link). */
const CONTROL_ROLE_WORDS = new Set(["button", "menu", "link", "hyperlink", "tab", "slider", "scroll", "indicator", "check", "radio",
  "incrementor", "stepper", "spin", "combo", "pop", "disclosure", "toolbar", "field", "area", "search", "edit"]);
const isControlRole = (role: string): boolean => role.toLowerCase().split(/[_\s-]+/).some(word => CONTROL_ROLE_WORDS.has(word));

/** Plain values shown in the target window's text (not its controls or inputs). */
export function screenValues(observation: ComputerObserveResult["observation"]): string[] {
  const values = new Set<string>();
  const add = (text: string | undefined) => {
    const value = (text ?? "").replace(/\s+/g, " ").trim();
    if (!value || [...value].length > 24 || !SCREEN_VALUE.test(value)) return;
    if ((value.match(/\d/g)?.length ?? 0) > MAX_VALUE_DIGITS) return;
    values.add(value);
  };
  for (const element of observation.elements) {
    if (element.editable || element.secure || element.searchBox || element.messageBox || isControlRole(element.role)) continue;
    add(element.value);
    add(element.label);
  }
  return [...values];
}

/** A read-back task that asks for the window's (a web page's) title. */
const TITLE_TASK = /(?:标题|title)/iu;
const MAX_TITLE_CHARACTERS = 80;

/**
 * For "打开…网页，告诉我网页标题": the target window's title (a browser shows the
 * page title there) as one bounded, quoted line — control characters, quotes
 * and line breaks removed, at most 80 characters. Only when the member asked
 * for a title; otherwise screen words stay off the chat (see screenValues).
 */
export function readBackTitle(task: ComputerTaskSpec, observation: ComputerObserveResult["observation"]): string | null {
  const asked = `${task.goal} ${task.successCheck}`;
  if (!READ_BACK_TASK.test(asked) || !TITLE_TASK.test(asked)) return null;
  const title = (observation.windowTitle ?? "").replace(/[\u0000-\u001f\u007f"“”「」]/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return null;
  const characters = [...title];
  return characters.length > MAX_TITLE_CHARACTERS ? `${characters.slice(0, MAX_TITLE_CHARACTERS).join("")}…` : title;
}

/** A text literal that is a whole calculation ("128×36"); same shape as the Electron policy's. */
const CALCULATION_LITERAL = /^\s*\d[\d.,，．]*(?:\s*[+\-−＋－×xX*＊÷/／]\s*\d[\d.,，．]*)+\s*[=＝]?\s*$/u;

function numberOf(text: string): number | null {
  const value = Number(text.replace(/[¥$€£%％元\s,，]/g, "").replace(/．/g, ".").replace(/^−/, "-"));
  return Number.isFinite(value) ? value : null;
}

/** A calculation written inside the goal ("计算 128×36") when the plan typed its numbers as separate parameters. */
const CALCULATION_IN_TEXT = /\d[\d.,，．]*(?:\s*[+\-−＋－×xX*＊÷/／]\s*\d[\d.,，．]*)+/u;

/** The task's calculation: a whole-calculation parameter, else one written in its goal. */
function calculationLiteral(task: ComputerTaskSpec): string | undefined {
  const parameter = task.parameters.find(item => item.role === "text" && CALCULATION_LITERAL.test(item.value))?.value;
  if (parameter) return parameter;
  const written = CALCULATION_IN_TEXT.exec(task.goal)?.[0];
  // A date ("9/28") or a phone number is not a calculation: an operator must sit between two numbers.
  return written && /[+\-−＋－×xX*＊÷／]|\d\s*\/\s*\d/u.test(written) && !/^\d{1,2}\/\d{1,2}$/u.test(written.trim()) ? written : undefined;
}

/** The result of the task's calculation (× ÷ before + −), or null. */
export function calculationResult(task: ComputerTaskSpec): number | null {
  const literal = calculationLiteral(task);
  if (!literal) return null;
  const tokens = literal.replace(/[=＝\s]/g, "").match(/\d[\d.,，．]*|[+\-−＋－×xX*＊÷/／]/gu) ?? [];
  const terms: number[] = [];
  let sign = 1;
  let product: number | null = null;
  let pending: "×" | "÷" | null = null;
  for (const token of tokens) {
    if (/^\d/u.test(token)) {
      const value = numberOf(token);
      if (value === null) return null;
      product = product === null ? value : pending === "÷" ? product / value : product * value;
      pending = null;
    } else if (/[×xX*＊]/u.test(token)) pending = "×";
    else if (/[÷/／]/u.test(token)) pending = "÷";
    else {
      if (product === null) return null;
      terms.push(sign * product);
      sign = /[+＋]/u.test(token) ? 1 : -1;
      product = null;
    }
  }
  if (product === null) return null;
  const result = terms.reduce((sum, term) => sum + term, sign * product);
  return Number.isFinite(result) ? result : null;
}

/**
 * For a read-back task ("读取计算器显示的结果并告诉我"): for a calculation, the
 * shown value that equals its result (10 − 5 shows 5 before "=" too);
 * otherwise the plain values on screen now that were not there in the view
 * the last action was chosen on — the result that action produced
 * (Calculator: "4,608" after "="). At most three; none when the task does not
 * ask to read anything.
 */
export function readBackValues(task: ComputerTaskSpec, beforeLastAction: ReadonlySet<string>, observation: ComputerObserveResult["observation"]): string[] {
  if (!READ_BACK_TASK.test(`${task.goal} ${task.successCheck}`)) return [];
  const literals = new Set(task.parameters.map(parameter => parameter.value.replace(/\s+/g, "")));
  const shown = screenValues(observation).filter(value => !literals.has(value.replace(/\s+/g, "")));
  const expected = calculationResult(task);
  if (expected !== null) {
    // Equal to the calculation's own result: strong enough to take from the
    // window's untyped texts too (a display can fall outside the elements).
    const equalsResult = (value: string) => {
      const number = numberOf(value);
      return number !== null && Math.abs(number - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
    };
    const texts = observation.texts.map(text => text.replace(/\s+/g, " ").trim()).filter(text => [...text].length <= 24 && SCREEN_VALUE.test(text) && (text.match(/\d/g)?.length ?? 0) <= MAX_VALUE_DIGITS);
    const match = shown.find(equalsResult) ?? texts.find(value => !literals.has(value.replace(/\s+/g, "")) && equalsResult(value));
    if (match) return [match];
  }
  return shown.filter(value => !beforeLastAction.has(value)).slice(0, 3);
}

/** The text a type candidate enters: the last 「…」 of its label (「字段」 may come first), bounded. */
export function typedTextOf(label: string): string | null {
  const matches = [...label.matchAll(/「([^「」]+)」/g)];
  const text = matches.at(-1)?.[1]?.trim();
  if (!text) return null;
  const points = [...text];
  return points.length > 40 ? `${points.slice(0, 39).join("")}…` : text;
}

const REASON_TEXT: Record<ComputerRunReason, string> = {
  goal_verified: "已完成",
  goal_refuted: "界面检查显示任务没有完成",
  action_uncertain: "有一步的结果无法确认，为避免重复操作已停止",
  jev_abstained: "Jev 判断当前界面没有安全、有用的下一步",
  low_confidence: "Jev 对下一步把握不足",
  needs_user: "界面需要你亲自处理（例如登录、扫码、输入密码或验证码）",
  authorization_denied: "下一步超出了你授权的范围",
  consent_denied: "你没有允许本次电脑操作",
  permission_missing: "同频缺少系统权限",
  user_stopped: "你停止了电脑操作",
  step_limit: "已达到本次任务的步数上限",
  time_limit: "已超过本次任务的时长上限",
  repeated_failures: "连续几步都没有生效",
  clarification: "任务还缺少必要信息",
  error: "执行中出现错误",
};

export async function runComputerTask(deps: ComputerRunDeps, request: ComputerRunRequest, callbacks: ComputerRunCallbacks = {}): Promise<ComputerRunResult> {
  const { api, bridge } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const controller = new AbortController();
  // Stop must also reach main at once: a consent or permission wait there
  // does not observe this signal.
  const abortFromOutside = () => { controller.abort(); void bridge.stop().catch(() => undefined); };
  if (deps.signal?.aborted) controller.abort();
  deps.signal?.addEventListener("abort", abortFromOutside, { once: true });
  let stoppedByAgent: ComputerAgentEvent | null = null;
  const unsubscribe = bridge.onEvent?.(event => {
    callbacks.onAgentEvent?.(event);
    if (event.type === "stopped") { stoppedByAgent = event; controller.abort(); }
  });
  const headers = { "X-Tongpin-Account": deps.accountId };
  const instruction = computerInstructionText(request.instruction) || request.instruction.trim();

  let run: ComputerRunStart | null = null;
  let steps = 0;
  let actions = 0;
  /** Actions of this run that entered something (clicks, typing, keys) — not switching apps or scrolling. */
  let inputActions = 0;
  let doneBeforeInput = 0;
  let points = 0;
  let irreversibleAttempted = false;
  let appName = "";
  /** Text this run typed that no later Enter, send or submit consumed: it may still sit in the app. */
  let unsentTyping: string | null = null;

  let budget: { startedAt: number; limits: ComputerRunLimits } | null = null;
  const stoppedReason = (): RunStop => {
    const event = stoppedByAgent as ComputerAgentEvent | null;
    if (event?.type === "stopped" && event.reason === "limit") {
      const timedOut = !budget || now() - budget.startedAt >= budget.limits.maxMinutes * 60_000;
      return timedOut ? new RunStop("budget_exhausted", "time_limit", REASON_TEXT.time_limit) : new RunStop("budget_exhausted", "step_limit", REASON_TEXT.step_limit);
    }
    return new RunStop("abstained", "user_stopped", event?.type === "stopped" && event.reason === "esc" ? "你按 Esc 停止了电脑操作" : REASON_TEXT.user_stopped);
  };
  const checkStopped = () => { if (controller.signal.aborted) throw stoppedReason(); };

  const summaryFor = (stop: RunStop): string => {
    if (stop.outcome === "verified") return stop.message;
    const done = actions > 0
      ? `已执行 ${actions} 个动作${irreversibleAttempted ? "，其中授权的不可逆操作已执行一次" : "，没有执行任何发送、提交、删除或付款"}`
      : "没有执行任何动作";
    const leftover = unsentTyping ? `最后输入的「${unsentTyping}」还没有发送或提交，可能还留在${appName ? `「${appName}」的` : ""}输入框里，不需要的话请手动删除。` : "";
    return `未完成：${stop.message}。${done}。${leftover}`;
  };

  let result: ComputerRunResult;
  try {
    /* 1. Instruction → structured task spec (tier LLM, once, billed). */
    let task: ComputerTaskResponse;
    try {
      task = await api<ComputerTaskResponse>("/api/ai/computer/tasks", {
        method: "POST", headers, signal: controller.signal,
        body: JSON.stringify({ requestId: request.requestId, mode: request.mode, conversationId: request.conversationId, instruction, ...(request.contextHint ? { contextHint: request.contextHint } : {}) }),
      }, 130_000);
    } catch (error) {
      checkStopped();
      throw new RunStop("abstained", "error", `任务整理失败：${errorText(error, "请稍后重试")}`);
    }
    callbacks.onQuota?.(task.quota);
    if (task.kind === "clarification") throw new RunStop("abstained", "clarification", `需要你补充：${task.question}`);
    run = task.run;
    const spec = run.task;
    const limits: ComputerRunLimits = run.limits;
    appName = spec.apps[0]?.name ?? "";
    callbacks.onTask?.(run);

    /* 2. ONE consent in main (scope + missing permissions). */
    callbacks.onConsent?.("waiting");
    const consent = await bridge.consent({ runId: run.runId, task: spec, limits });
    if (!consent.ok) {
      checkStopped();
      const code = consent.error.code;
      if (code === "consent_denied") throw new RunStop("abstained", "consent_denied", REASON_TEXT.consent_denied);
      if (code === "permission_missing") throw new RunStop("abstained", "permission_missing", consent.error.message);
      if (code === "stopped") throw stoppedReason();
      throw new RunStop("abstained", "error", consent.error.message);
    }
    callbacks.onConsent?.("granted", consent.value);
    const startedAt = now();
    budget = { startedAt, limits };

    /* 3. Observe → decide (Jev) → authorize + execute → verify, until done. */
    const history: ComputerHistoryEntry[] = [];
    const guidance: string[] = [];
    let lastAction: ComputerDecisionRequest["lastAction"];
    let lowConfidenceStreak = 0, reobserveStreak = 0, failureStreak = 0, backgroundMisses = 0, blockedStreak = 0, prematureDone = 0, observeFailures = 0, sendStuckSeen = 0;
    // Plain values in the view the last action was chosen on: what is new at
    // "done" is the result a read-back task reports.
    let valuesBeforeAction: ReadonlySet<string> = new Set<string>();
    // The member checked the app and confirmed the recipient and the text of
    // the send Jev chose; it holds until the next executed action.
    let memberConfirmedSend = false;

    for (;;) {
      checkStopped();
      if (steps >= limits.maxSteps) throw new RunStop("budget_exhausted", "step_limit", `${REASON_TEXT.step_limit}（${limits.maxSteps} 步）`);
      if (now() - startedAt > limits.maxMinutes * 60_000) throw new RunStop("budget_exhausted", "time_limit", `${REASON_TEXT.time_limit}（${limits.maxMinutes} 分钟）`);
      const step = steps + 1;
      callbacks.onStep?.({ step, phase: "observe" });
      const observed = await bridge.observe();
      checkStopped();
      if (!observed.ok) {
        if (observed.error.code === "time_limit") throw new RunStop("budget_exhausted", "time_limit", REASON_TEXT.time_limit);
        if (observed.error.code === "session_not_active" || observed.error.code === "stopped") throw stoppedReason();
        observeFailures += 1;
        callbacks.onStep?.({ step, phase: "observe", note: observed.error.message });
        if (observeFailures >= MAX_FAILURE_STREAK) throw new RunStop("unknown", "repeated_failures", `${observed.error.message}，已连续 ${observeFailures} 次读取失败`);
        await sleep(REOBSERVE_DELAY_MS);
        continue;
      }
      observeFailures = 0;
      const view = observed.value;
      if (view.display.app) appName = view.display.app;
      const readout = readBackValues(spec, valuesBeforeAction, view.observation);
      const readTitle = readBackTitle(spec, view.observation);
      // Typed text showed up in the wrong kind of input box: keyboard focus was
      // not where the run believed. Stop before any Return could send it.
      const landing = view.facts.typedLanding;
      if (landing?.landed === "elsewhere") {
        const intended = landing.field === "search" ? "搜索框" : landing.field === "message" ? "消息输入框" : "输入框";
        const app = appName || spec.apps[0].name;
        throw new RunStop(irreversibleAttempted ? "unknown" : "abstained", "action_uncertain", `刚才输入的“${landing.text}”没有进入${intended}，而是出现在「${app}」的另一个输入框里。为避免误发已停止，没有按回车；请到「${app}」里检查并删除这段文字`);
      }
      // The granted send was attempted once but the input still holds the text
      // and no new copy appeared: give the app a moment, then stop honestly
      // instead of sending again.
      if (sendStuck(spec, view.facts)) {
        sendStuckSeen += 1;
        if (sendStuckSeen >= 2) throw new RunStop("refuted", "goal_refuted", `已按授权尝试发送一次，但输入框里仍是“${spec.irreversible?.content ?? ""}”，聊天中也没有出现这条消息。为避免重复发送已停止，请在「${appName}」里手动发送，或检查发送快捷键设置`);
        callbacks.onStep?.({ step, phase: "verify", observation: view.display, note: "发送后输入框仍有内容，稍等后再核对一次" });
        await sleep(SEND_RECHECK_DELAY_MS);
        continue;
      }
      sendStuckSeen = 0;
      callbacks.onStep?.({ step, phase: "decide", observation: view.display, candidateCount: view.candidates.length });

      const body: ComputerDecisionRequest = {
        step, observationId: view.observationId, observation: view.observation,
        candidates: view.candidates.map(({ id, description, risk }) => ({ id, description, risk })),
        facts: view.facts, history: history.slice(-COMPUTER_AGENT_LIMITS.maxHistory),
        ...(lastAction ? { lastAction } : {}),
        ...(guidance.length ? { guidance: guidance.slice(-COMPUTER_AGENT_LIMITS.maxGuidance) } : {}),
      };
      let decided: ComputerDecisionResponse;
      try {
        decided = await api<ComputerDecisionResponse>(`/api/ai/computer/runs/${encodeURIComponent(run.runId)}/decide`, {
          method: "POST", headers, signal: controller.signal, body: JSON.stringify(body),
        }, 45_000);
      } catch (error) {
        checkStopped();
        const code = errorCode(error);
        if (code === "AI_COMPUTER_STEP_LIMIT") throw new RunStop("budget_exhausted", "step_limit", REASON_TEXT.step_limit);
        if (code === "AI_COMPUTER_RUN_EXPIRED") throw new RunStop("budget_exhausted", "time_limit", REASON_TEXT.time_limit);
        throw new RunStop(irreversibleAttempted ? "unknown" : "abstained", "error", `Jev 决策失败：${errorText(error, "请稍后重试")}`);
      }
      steps = step;
      points += decided.usage.points;
      callbacks.onQuota?.(decided.quota);
      const decision = decided.decision;
      const choice = view.candidates.find(candidate => candidate.id === decision.selectedId);
      if (!choice) throw new RunStop("unknown", "error", "Jev 返回了候选之外的动作，已停止");
      const verification = decision.verification;
      callbacks.onStep?.({
        step, phase: "decide", observation: view.display, candidateCount: view.candidates.length, points: decided.usage.points,
        choice: { id: choice.id, label: choice.label, confidence: decision.confidence, reserved: choice.kind === "reserved", risk: choice.risk },
        verification: { goalDone: verification.goalDone, previousEffect: verification.previousEffect, recipientMatch: verification.recipientMatch, contentMatch: verification.contentMatch },
      });
      checkStopped();

      /* A task that asks for something to be entered is not done before this run
       * entered anything: a screen left over from an earlier run (a calculator
       * already showing the result) only looks done. Jev is told once; if it
       * insists, a calculation still counts when the screen shows its correct result. */
      if (choice.id === "done" && inputActions === 0 && spec.parameters.some(parameter => parameter.role === "text")) {
        doneBeforeInput += 1;
        const expected = calculationResult(spec);
        const showsResult = expected !== null && readout.some(value => { const number = numberOf(value); return number !== null && Math.abs(number - expected) <= 1e-9 * Math.max(1, Math.abs(expected)); });
        if (doneBeforeInput < 2 || (expected !== null && !showsResult)) {
          history.push({ step, action: "Chose done before entering anything in this run; the task asks to enter its input now (an earlier run may have left the screen looking done).", result: "reobserved" });
          lastAction = undefined;
          callbacks.onStep?.({ step, phase: "verify", note: "还没有按任务要求输入，先完成输入" });
          if (doneBeforeInput >= 3) throw new RunStop("refuted", "goal_refuted", `${REASON_TEXT.goal_refuted}：${spec.successCheck}`);
          continue;
        }
      }
      /* Verification of the goal (executor evidence + Jev goal_done). */
      if (choice.id === "done" || (verification.goalDone >= AUTO_DONE_THRESHOLD && view.facts.irreversibleDone)) {
        const verdict = evaluateComputerDone(spec, view.facts, verification.goalDone);
        if (verdict === "verified") throw new RunStop("verified", "goal_verified", verifiedSummary(spec, appName || spec.apps[0].name, readout, readTitle));
        if (verdict === "unconfirmed") throw new RunStop("unknown", "action_uncertain", `${spec.irreversible?.summary ?? "操作"}已执行，但无法从界面确认结果，请到「${appName || spec.apps[0].name}」里核对`);
        if (choice.id === "done") {
          prematureDone += 1;
          if (prematureDone >= 2) throw new RunStop("refuted", "goal_refuted", `${REASON_TEXT.goal_refuted}：${spec.successCheck}`);
          history.push({ step, action: "Chose done, but the success check is not met yet.", result: "reobserved" });
          lastAction = undefined;
          callbacks.onStep?.({ step, phase: "verify", note: "完成条件尚未满足，重新读取界面" });
          continue;
        }
      }
      if (verification.needsUser >= NEEDS_USER_THRESHOLD) {
        throw new RunStop(irreversibleAttempted ? "unknown" : "abstained", "needs_user", REASON_TEXT.needs_user);
      }
      if (choice.id === "abstain" && decision.confidence >= limits.minConfidence) {
        throw new RunStop(irreversibleAttempted ? "unknown" : "abstained", "jev_abstained", REASON_TEXT.jev_abstained);
      }
      if (choice.id === "reobserve") {
        reobserveStreak += 1;
        if (reobserveStreak >= MAX_REOBSERVE_STREAK) {
          const hidden = view.facts.targetWindow === "hidden" || view.facts.targetWindow === "none";
          throw new RunStop(irreversibleAttempted ? "unknown" : "abstained", "action_uncertain", hidden
            ? `「${appName}」的窗口已最小化、在其他桌面或没有打开，读不到界面；请先把「${appName}」窗口打开再试`
            : "界面一直没有稳定下来");
        }
        history.push({ step, action: "Waited and re-observed the screen.", result: "reobserved" });
        callbacks.onStep?.({ step, phase: "reobserve", note: "Jev 选择重新读取界面" });
        await sleep(REOBSERVE_DELAY_MS);
        continue;
      }
      reobserveStreak = 0;

      /* Confidence floors: reobserve once, then ask the member in chat. */
      const floor = choice.risk === "none" ? limits.minConfidence : Math.max(limits.minConfidence, COMPUTER_AGENT_LIMITS.irreversibleMinConfidence);
      const matchFloor = COMPUTER_AGENT_LIMITS.irreversibleMinConfidence;
      // The executor read the chat title and the message box off the screen
      // itself: that is the check the member would otherwise be asked to do.
      const screenVerified = view.facts.screenCheck?.recipientInTitle === true && view.facts.screenCheck.composerHoldsText === true;
      const sendDoubt = choice.risk === "send" && !memberConfirmedSend && !screenVerified && ((verification.recipientMatch ?? 1) < matchFloor || (verification.contentMatch ?? 1) < matchFloor);
      if (choice.risk !== "send") memberConfirmedSend = false;
      if (decision.confidence < floor || sendDoubt || choice.id === "abstain") {
        lowConfidenceStreak += 1;
        if (lowConfidenceStreak === 1) {
          history.push({ step, action: `Low confidence (${decision.confidence.toFixed(2)}); re-observed instead of: ${choice.description}`, result: "reobserved" });
          callbacks.onStep?.({ step, phase: "reobserve", note: `把握不足（${percent(decision.confidence)}），先重新读取界面` });
          await sleep(REOBSERVE_DELAY_MS);
          continue;
        }
        const ranked = Object.entries(decision.probabilities)
          .sort((a, b) => b[1] - a[1])
          .map(([id]) => view.candidates.find(candidate => candidate.id === id))
          .filter((candidate): candidate is ComputerCandidate => Boolean(candidate && candidate.kind !== "reserved"))
          .slice(0, 3)
          .map(candidate => candidate.label);
        // Jev chose the granted send with confidence and only cannot see the
        // chat or the text: the member may check the app and confirm it.
        const confirmable = sendDoubt && decision.confidence >= floor;
        const where = appName ? `「${appName}」` : "目标应用";
        const question = sendDoubt
          ? `Jev 不能确认当前聊天就是「${spec.irreversible?.recipient ?? ""}」、输入框里恰好是“${spec.irreversible?.content ?? ""}”。请看一眼${where}：${confirmable ? "核对无误就点确认按钮，否则" : ""}告诉我需要怎么调整，或者停止。`
          : `Jev 对下一步把握不足（${percent(decision.confidence)}）。${ranked.length ? `它在考虑：${ranked.join("；")}。` : ""}可以补充一句说明（例如联系人的完整备注名），或者停止。`;
        callbacks.onStep?.({ step, phase: "ask", note: confirmable ? "等待你核对后确认" : "等待你的补充说明" });
        const answer = callbacks.askUser
          ? await callbacks.askUser({ step, question, options: ranked, ...(confirmable ? { confirmLabel: `已核对，${choice.label}` } : {}) })
          : null;
        checkStopped();
        if (confirmable && answer !== null && typeof answer === "object" && answer.confirmed === true) {
          // The chosen send runs now; the executor still re-checks it on a
          // fresh capture and asks natively when it cannot verify it.
          memberConfirmedSend = true;
          callbacks.onStep?.({ step, phase: "ask", note: "你已核对界面并确认发送" });
        } else {
          const text = typeof answer === "string" ? answer.trim() : "";
          if (!text) throw new RunStop(irreversibleAttempted ? "unknown" : "abstained", "low_confidence", REASON_TEXT.low_confidence);
          guidance.push([...text].slice(0, COMPUTER_AGENT_LIMITS.maxGuidanceChars).join(""));
          lowConfidenceStreak = 0;
          lastAction = undefined;
          continue;
        }
      }
      lowConfidenceStreak = 0;

      /* Authorization and scope are checked in main, then Cua Driver executes. */
      callbacks.onStep?.({ step, phase: "authorize" });
      const executed = await bridge.execute({ observationId: view.observationId, candidateId: choice.id });
      if (!executed.ok) {
        checkStopped();
        const code = executed.error.code;
        if (code === "step_limit") throw new RunStop("budget_exhausted", "step_limit", REASON_TEXT.step_limit);
        if (code === "time_limit") throw new RunStop("budget_exhausted", "time_limit", REASON_TEXT.time_limit);
        if (code === "session_not_active" || code === "stopped") throw stoppedReason();
        history.push({ step, action: choice.description, result: "blocked" });
        failureStreak += 1;
        callbacks.onStep?.({ step, phase: "execute", execution: { status: "blocked", message: executed.error.message } });
        if (failureStreak >= MAX_FAILURE_STREAK) throw new RunStop(irreversibleAttempted ? "unknown" : "abstained", "repeated_failures", REASON_TEXT.repeated_failures);
        lastAction = undefined;
        continue;
      }
      const outcome = executed.value;
      memberConfirmedSend = false;
      if (outcome.status !== "blocked") { actions += 1; valuesBeforeAction = new Set(screenValues(view.observation)); }
      if (outcome.status !== "blocked" && outcome.status !== "failed" && choice.kind !== "activate_app" && choice.kind !== "scroll" && choice.kind !== "reserved") inputActions += 1;
      if (choice.risk !== "none" && outcome.status !== "blocked" && outcome.status !== "failed") irreversibleAttempted = true;
      if (outcome.status !== "blocked" && outcome.status !== "failed") {
        if (choice.kind === "type") unsentTyping = typedTextOf(choice.label);
        else if (choice.risk !== "none" || /回车/.test(choice.label)) unsentTyping = null;
      }
      callbacks.onStep?.({ step, phase: outcome.status === "blocked" ? "authorize" : "verify", authorization: outcome.authorization, execution: { status: outcome.status, message: outcome.message, ...(outcome.delivery ? { delivery: outcome.delivery } : {}) } });
      history.push({ step, action: choice.description, result: outcome.status });
      if (outcome.status === "blocked") {
        if (outcome.code === "extra_consent_denied" || outcome.code === "stopped") throw new RunStop(irreversibleAttempted ? "unknown" : "abstained", "authorization_denied", `${REASON_TEXT.authorization_denied}，你选择了停止`);
        blockedStreak += 1;
        if (blockedStreak >= MAX_BLOCKED_STREAK) throw new RunStop(irreversibleAttempted ? "unknown" : "abstained", "authorization_denied", `${REASON_TEXT.authorization_denied}：${outcome.message}`);
        lastAction = undefined;
        continue;
      }
      blockedStreak = 0;
      if (outcome.status === "unknown" && choice.risk !== "none") {
        throw new RunStop("unknown", "action_uncertain", `「${choice.label}」的结果无法确认，为避免重复执行已停止，请到「${appName}」里核对`);
      }
      if (outcome.status === "failed" || outcome.status === "no_effect") {
        // A harmless background miss makes the next observation offer distinct
        // foreground candidates, so it is not yet a sign that nothing works.
        if (outcome.delivery === "background" && choice.risk === "none") backgroundMisses += 1;
        else failureStreak += 1;
        if (failureStreak >= MAX_FAILURE_STREAK || backgroundMisses >= MAX_BACKGROUND_MISSES) throw new RunStop(irreversibleAttempted ? "unknown" : "abstained", "repeated_failures", REASON_TEXT.repeated_failures);
      } else {
        failureStreak = 0;
        backgroundMisses = 0;
      }
      lastAction = { action: choice.description, expect: choice.expect ?? "The screen changed as intended by this action." };
    }
  } catch (error) {
    const stop = error instanceof RunStop ? error
      : controller.signal.aborted ? stoppedReason()
        : new RunStop(irreversibleAttempted ? "unknown" : "abstained", "error", `${REASON_TEXT.error}：${errorText(error, "未知错误")}`);
    const summary = [...`${summaryFor(stop)}${steps ? `（共 ${steps} 步 Jev 决策，消耗 ${points} 同频点）` : ""}`].slice(0, COMPUTER_AGENT_LIMITS.maxResultSummaryChars).join("");
    result = { outcome: stop.outcome, reason: stop.reason, summary, steps, actions, points, ...(run ? { runId: run.runId } : {}) };
  } finally {
    deps.signal?.removeEventListener("abort", abortFromOutside);
    unsubscribe?.();
  }
  // Always release the native session; record the outcome on the server.
  await bridge.stop().catch(() => undefined);
  if (run) {
    await api(`/api/ai/computer/runs/${encodeURIComponent(run.runId)}/finish`, {
      method: "POST", headers,
      body: JSON.stringify({ outcome: result!.outcome, reason: result!.reason, summary: result!.summary, steps }),
    }, 15_000).catch(() => undefined);
  }
  return result!;
}
