import { CircleCheck, CircleStop, LoaderCircle, MonitorUp, PanelRightClose, PanelRightOpen, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { AiMode, AiQuota } from "../../../shared/ai";
import { COMPUTER_ACTION_KIND_LABELS, COMPUTER_OUTCOME_LABELS, type ComputerAgentEvent, type ComputerRunStart } from "../../../shared/computerAgent";
import { getComputerUseBridge } from "../../lib/computerUseBridge";
import { computerInstructionText, runComputerTask, type ComputerAnswer, type ComputerApi, type ComputerQuestion, type ComputerRunResult, type ComputerTimelineStep } from "./computerExecutor";
import "./computer-use.css";
import "./computer-run.css";

export interface ComputerRunPanelRequest {
  id: string;
  conversationId: string;
  mode: AiMode;
  /** The member's words: kept in this live panel only, never persisted. */
  instruction: string;
  contextHint?: string;
}

interface ComputerRunPanelProps {
  request: ComputerRunPanelRequest;
  accountId: string;
  api: ComputerApi;
  onQuota: (quota: AiQuota) => void;
  onFinish: (result: ComputerRunResult) => void;
  onClose: () => void;
  /**
   * The page's right-hand panel slot. When the page offers one (even while it
   * is closed, as null), the composer area keeps only a one-line status bar
   * and the run's details open beside the chat; without it the details show
   * in place, as before.
   */
  sideSlot?: HTMLElement | null;
  panelOpen?: boolean;
  onPanelOpenChange?: (open: boolean) => void;
}

const percent = (value: number) => `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
const AUTH_LABELS = { allowed: "在授权范围内", extra_consent: "你已再次确认", denied: "超出授权，未执行" } as const;

function mergeStep(steps: ComputerTimelineStep[], next: ComputerTimelineStep): ComputerTimelineStep[] {
  const defined = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as Partial<ComputerTimelineStep>;
  const index = steps.findIndex(step => step.step === next.step);
  const merged = index === -1 ? [...steps, next] : steps.map((step, position) => position === index ? { ...step, ...defined } : step);
  // Jev's previous_effect judgment verifies the step before this one.
  const effect = next.verification?.previousEffect;
  return effect === undefined ? merged : merged.map(step => step.step === next.step - 1 && step.execution ? { ...step, verifiedEffect: effect } as ComputerTimelineStep : step);
}

/** Windows the app floats over the target (its search list), read with it. */
export function popupText(observation: NonNullable<ComputerTimelineStep["observation"]>): string {
  if (!observation.popupCount) return "";
  const what = observation.searchListShown ? "搜索列表" : "浮层窗口";
  const count = observation.popupElementCount ? ` ${observation.popupElementCount} 项` : "（读不到内容）";
  // Where it hangs in the window (and where the app says its search box is).
  const where = observation.floating
    ? `〔${observation.floating.popups.map(item => `${item.list ? "列表" : "浮层"} ${item.x},${item.y} ${item.w}×${item.h}`).join("；")}${observation.floating.searchBox ? `；搜索框 ${observation.floating.searchBox.x},${observation.floating.searchBox.y} ${observation.floating.searchBox.w}×${observation.floating.searchBox.h}` : ""}〕`
    : "";
  return ` · ${what}${count}${where}`;
}

/** What the executor read off the window around a send (never the text itself). */
export function screenTextNote(observation: NonNullable<ComputerTimelineStep["observation"]>): string {
  const screen = observation.screenText;
  if (!screen) return "";
  if (screen.phase === "after") return ` · 屏幕文字：${screen.composerHoldsText ? "输入框里仍有这段文字" : "输入框已清空"}、聊天里可见 ${screen.copies} 处`;
  return ` · 屏幕文字：聊天标题${screen.recipientInTitle ? "✓" : "未核对"}、输入框${screen.composerHoldsText ? "恰好是这段文字 ✓" : "未核对"}`;
}

/**
 * Buttons under a question: the confirmation (only when offered, for a send
 * Jev chose but cannot verify on screen), guidance for Jev, or stop.
 */
export function ComputerQuestionActions({ confirmLabel, canSubmit, onConfirm, onStop }: { confirmLabel?: string; canSubmit: boolean; onConfirm: () => void; onStop: () => void }) {
  return <div className="tp-ai-computer-run__question-actions">
    {confirmLabel ? <button type="button" className="tp-ai-computer__primary" onClick={onConfirm}>{confirmLabel}</button> : null}
    <button type="submit" className={confirmLabel ? undefined : "tp-ai-computer__primary"} disabled={!canSubmit}>补充后继续</button>
    <button type="button" onClick={onStop}>停止任务</button>
  </div>;
}

/** One line for the status bar: the latest step and what Jev is doing in it. */
export function latestStepText(steps: readonly ComputerTimelineStep[]): string {
  const step = steps.at(-1);
  if (!step) return "";
  const doing = step.execution ? step.execution.message
    : step.choice ? `Jev 选择：${step.choice.label}`
      : step.phase === "decide" ? "Jev 决策中…" : `读取「${step.observation?.app ?? "目标应用"}」界面…`;
  return `第 ${step.step} 步 · ${doing}`;
}

function StepChain({ step }: { step: ComputerTimelineStep & { verifiedEffect?: number } }) {
  const parts: Array<{ key: string; text: string; tone?: "ok" | "warn" | "muted" }> = [];
  if (step.observation) parts.push({ key: "observe", text: `读取「${step.observation.app ?? "目标应用"}」${step.observation.elementCount ? ` · ${step.observation.elementCount} 个元素` : ""}${popupText(step.observation)}${screenTextNote(step.observation)}${step.observation.screenshotUsed ? " · 截图定位" : ""}` });
  else parts.push({ key: "observe", text: "读取界面…", tone: "muted" });
  if (step.candidateCount !== undefined) parts.push({ key: "candidates", text: `候选 ${step.candidateCount} 个` });
  if (step.choice) parts.push({ key: "choice", text: `Jev 选择：${step.choice.label}（置信度 ${percent(step.choice.confidence)}）`, tone: step.choice.risk !== "none" ? "warn" : undefined });
  else if (step.phase === "decide") parts.push({ key: "choice", text: "Jev 决策中…", tone: "muted" });
  if (step.authorization) parts.push({ key: "auth", text: `授权检查：${AUTH_LABELS[step.authorization]}`, tone: step.authorization === "denied" ? "warn" : "ok" });
  else if (step.phase === "authorize") parts.push({ key: "auth", text: "授权检查…", tone: "muted" });
  if (step.execution) parts.push({ key: "execute", text: `执行：${step.execution.message}${step.execution.delivery === "foreground" ? "（前台）" : ""}`, tone: ["failed", "unknown", "no_effect", "blocked"].includes(step.execution.status) ? "warn" : "ok" });
  if (step.verifiedEffect !== undefined) parts.push({ key: "verify", text: step.verifiedEffect >= 0.5 ? `验证：已生效（${percent(step.verifiedEffect)}）` : `验证：未见效果（${percent(step.verifiedEffect)}）`, tone: step.verifiedEffect >= 0.5 ? "ok" : "warn" });
  else if (step.verification && step.choice?.reserved) parts.push({ key: "verify", text: `验证：完成度 ${percent(step.verification.goalDone)}` });
  return <p className="tp-ai-computer-run__chain">{parts.map((part, index) => <span key={part.key} className={part.tone ? `is-${part.tone}` : undefined}>{index ? <i aria-hidden="true">→</i> : null}{part.text}</span>)}</p>;
}

export function ComputerRunPanel({ request, accountId, api, onQuota, onFinish, onClose, sideSlot, panelOpen = true, onPanelOpenChange }: ComputerRunPanelProps) {
  const bridge = getComputerUseBridge()?.agent;
  const controllerRef = useRef<AbortController | null>(null);
  const answerRef = useRef<((value: ComputerAnswer | null) => void) | null>(null);
  const callbacksRef = useRef({ onQuota, onFinish, onPanelOpenChange });
  callbacksRef.current = { onQuota, onFinish, onPanelOpenChange };
  const [run, setRun] = useState<ComputerRunStart | null>(null);
  const [status, setStatus] = useState("正在用当前档位模型整理任务…");
  const [steps, setSteps] = useState<ComputerTimelineStep[]>([]);
  const [question, setQuestion] = useState<ComputerQuestion | null>(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<ComputerRunResult | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (!bridge) {
      const unavailable: ComputerRunResult = { outcome: "abstained", reason: "error", summary: "未完成：当前同频桌面端还不支持统一电脑操作执行器，请更新到最新版本后重试。没有执行任何动作。", steps: 0, actions: 0, points: 0 };
      setResult(unavailable);
      callbacksRef.current.onFinish(unavailable);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    let active = true;
    const onAgentEvent = (event: ComputerAgentEvent) => {
      if (!active) return;
      if (event.type === "permission_wait") setStatus(`正在申请系统权限：${event.missing.map(item => item === "accessibility" ? "辅助功能" : "屏幕录制").join("、")}。请在弹出的系统提示或系统设置中为「同频」打开开关，同频会自动继续。`);
      else if (event.type === "permission_ready") setStatus(event.axOnly ? "辅助功能已开启；屏幕录制未开启，本次只读取界面结构。" : "系统权限已就绪。");
      else if (event.type === "extra_consent") setStatus(`下一步超出本次授权（${event.summary}），请在系统确认框中决定是否仅允许这一次。`);
      else if (event.type === "stopped") setStatus(event.reason === "esc" ? "已按 Esc 停止。" : "电脑操作已停止。");
    };
    // Started on the next tick so a development StrictMode double mount
    // cancels the first start before any billed request is made.
    const timer = window.setTimeout(() => void runComputerTask({ api, accountId, bridge, signal: controller.signal }, {
      requestId: request.id, mode: request.mode, conversationId: request.conversationId,
      instruction: request.instruction, ...(request.contextHint ? { contextHint: request.contextHint } : {}),
    }, {
      onTask: start => { if (active) { setRun(start); setStatus("请在系统确认框中核对并授权本次电脑操作。"); } },
      onConsent: state => { if (active && state === "granted") setStatus("已授权，Jev 正在逐步决策。按 Esc 或点「停止」可随时结束。"); },
      onAgentEvent,
      onStep: step => { if (active) setSteps(current => mergeStep(current, step)); },
      onQuota: quota => { if (active) callbacksRef.current.onQuota(quota); },
      askUser: next => new Promise(resolve => {
        if (!active) { resolve(null); return; }
        answerRef.current = resolve;
        setAnswer("");
        setQuestion(next);
        // A question needs the member: bring the details beside the chat into view.
        callbacksRef.current.onPanelOpenChange?.(true);
      }),
    }).then(outcome => {
      answerRef.current = null;
      if (!active) return;
      setQuestion(null);
      setResult(outcome);
      setStatus(COMPUTER_OUTCOME_LABELS[outcome.outcome]);
      callbacksRef.current.onFinish(outcome);
    }), 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
      answerRef.current?.(null);
      answerRef.current = null;
    };
  }, [accountId, api, bridge, request.contextHint, request.conversationId, request.id, request.instruction, request.mode]);

  function stop() {
    setStopping(true);
    setStatus("正在停止…");
    answerRef.current?.(null);
    answerRef.current = null;
    setQuestion(null);
    controllerRef.current?.abort();
  }

  function submitAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = answer.trim();
    if (!text) return;
    answerRef.current?.(text);
    answerRef.current = null;
    setQuestion(null);
    setStatus("已收到补充说明，Jev 继续决策。");
  }

  /** The member checked the app and confirms the send Jev chose. */
  function confirmChecked() {
    answerRef.current?.({ confirmed: true });
    answerRef.current = null;
    setQuestion(null);
    setStatus("已确认，正在执行这一步（执行前会再核对一次界面）。");
  }

  const task = run?.task;
  const running = !result;
  const sideLayout = sideSlot !== undefined;
  const header = <header>
    <span><MonitorUp size={17} aria-hidden="true" />电脑操作 · Jev 逐步决策</span>
    <div className="tp-ai-computer-run__header-actions">
      {running ? <button type="button" className="tp-ai-computer-run__stop" onClick={stop} disabled={stopping} aria-label="停止电脑操作"><CircleStop size={16} aria-hidden="true" />停止</button> : null}
      {sideLayout
        ? <button type="button" onClick={() => onPanelOpenChange?.(false)} aria-label="收起电脑操作过程"><PanelRightClose size={16} aria-hidden="true" /></button>
        : !running ? <button type="button" onClick={onClose} aria-label="关闭电脑操作面板"><X size={16} aria-hidden="true" /></button> : null}
    </div>
  </header>;
  const details = <section className={`tp-ai-computer tp-ai-computer-run${sideLayout ? " is-side" : ""}`} aria-label="电脑操作执行器" aria-busy={running}>
    {header}
    <p className="tp-ai-computer__goal">{computerInstructionText(request.instruction) || request.instruction}</p>
    {task ? <dl className="tp-ai-computer-run__spec">
      <div><dt>任务目标</dt><dd>{task.goal}</dd></div>
      <div><dt>目标应用</dt><dd>{task.apps.map(app => `「${app.name}」`).join("、")}</dd></div>
      <div><dt>允许的动作</dt><dd>{task.actionKinds.map(kind => COMPUTER_ACTION_KIND_LABELS[kind]).join("、")}</dd></div>
      <div><dt>只会输入</dt><dd>{task.parameters.length ? task.parameters.map(parameter => `「${parameter.value}」`).join("、") : "不输入文字"}</dd></div>
      <div><dt>不可逆操作</dt><dd>{task.irreversible ? `${task.irreversible.summary}（最多一次）` : "无（不会发送、提交、删除或付款）"}</dd></div>
      <div><dt>完成标准</dt><dd>{task.successCheck}</dd></div>
      <div><dt>上限</dt><dd>{run.limits.maxSteps} 步 · {run.limits.maxMinutes} 分钟 · 决策模型 {run.decisionModel}</dd></div>
    </dl> : null}
    <p className="tp-ai-computer__notice" role="status">{running ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : result?.outcome === "verified" ? <CircleCheck size={14} aria-hidden="true" /> : <TriangleAlert size={14} aria-hidden="true" />}{status}</p>
    {steps.length ? <ol className="tp-ai-computer-run__timeline" aria-label="执行记录">
      {steps.map(step => <li key={step.step} className={step.execution && ["failed", "unknown", "blocked"].includes(step.execution.status) ? "is-warn" : undefined}>
        <span className="tp-ai-computer-run__index">{step.step}</span>
        <div><StepChain step={step} />{step.note ? <small>{step.note}</small> : null}</div>
      </li>)}
    </ol> : null}
    {question ? <form className="tp-ai-computer-run__question" onSubmit={submitAnswer}>
      <p>{question.question}</p>
      <textarea value={answer} maxLength={300} rows={2} placeholder="例如：联系人在微信里的备注是“大姐”" onChange={event => setAnswer(event.target.value)} aria-label="给 Jev 的补充说明" />
      <ComputerQuestionActions confirmLabel={question.confirmLabel} canSubmit={Boolean(answer.trim())} onConfirm={confirmChecked} onStop={stop} />
    </form> : null}
    {result ? <p className={`tp-ai-computer-run__result is-${result.outcome}`}>{result.summary}</p> : null}
    <p className="tp-ai-computer__boundary"><ShieldCheck size={13} aria-hidden="true" />只在你授权的应用里操作；Jev 只收到界面结构摘要，不接收截图；超出授权的发送、删除、付款会先停下来问你。按 Esc 可随时停止。</p>
  </section>;
  if (!sideLayout) return details;
  return <>
    <ComputerRunStatusBar running={running} stopping={stopping} question={Boolean(question)} outcome={result?.outcome}
      text={question ? question.question : result ? result.summary : latestStepText(steps) || status}
      panelOpen={panelOpen && Boolean(sideSlot)} onTogglePanel={() => onPanelOpenChange?.(!(panelOpen && sideSlot))} onStop={stop} onClose={onClose} />
    {sideSlot && panelOpen ? createPortal(<div className="tp-ai-computer-side__body">{details}</div>, sideSlot) : null}
  </>;
}

/**
 * The composer area while a computer run is active: one line with where the
 * run is, and the buttons that matter now (open the details, answer Jev,
 * stop, or go back to chatting once it has ended).
 */
export function ComputerRunStatusBar({ running, stopping, question, outcome, text, panelOpen, onTogglePanel, onStop, onClose }: {
  running: boolean; stopping: boolean; question: boolean; outcome?: ComputerRunResult["outcome"]; text: string; panelOpen: boolean;
  onTogglePanel: () => void; onStop: () => void; onClose: () => void;
}) {
  const title = question ? "需要你确认" : running ? (stopping ? "正在停止" : "电脑操作进行中") : COMPUTER_OUTCOME_LABELS[outcome ?? "abstained"];
  const tone = question ? "is-question" : running ? "is-running" : outcome === "verified" ? "is-done" : "is-ended";
  return <section className={`tp-ai-computer-bar ${tone}`} aria-label="电脑操作状态" aria-busy={running}>
    <span className="tp-ai-computer-bar__icon" aria-hidden="true">
      {question ? <TriangleAlert size={16} /> : running ? <LoaderCircle size={16} className="is-spinning" /> : outcome === "verified" ? <CircleCheck size={16} /> : <TriangleAlert size={16} />}
    </span>
    <p className="tp-ai-computer-bar__text" role="status"><strong>{title}</strong><span>{text}</span></p>
    <div className="tp-ai-computer-bar__actions">
      {question && !panelOpen ? <button type="button" className="is-primary" onClick={onTogglePanel}>去确认</button>
        : <button type="button" onClick={onTogglePanel} aria-pressed={panelOpen}>{panelOpen ? <PanelRightClose size={15} aria-hidden="true" /> : <PanelRightOpen size={15} aria-hidden="true" />}{panelOpen ? "收起过程" : "查看过程"}</button>}
      {running
        ? <button type="button" className="is-stop" onClick={onStop} disabled={stopping} aria-label="停止电脑操作"><CircleStop size={15} aria-hidden="true" />停止</button>
        : <button type="button" className="is-primary" onClick={onClose}>继续对话</button>}
    </div>
  </section>;
}
