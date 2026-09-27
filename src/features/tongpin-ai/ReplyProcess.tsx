import {
  CheckCircle2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Circle,
  CircleDashed,
  CircleStop,
  FileText,
  Globe,
  Hourglass,
  Image as ImageIcon,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  Monitor,
  Presentation,
  Terminal,
  Route,
  TriangleAlert,
  Users,
  Video,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { AiHarnessTrace } from "../../../shared/ai";
import type { AiReplyProcessOutcome } from "../../../shared/aiReplyProcess";
import { useAuth } from "../../auth/AuthContext";
import { readAiProcessDetailsExpanded, saveAiProcessDetailsExpanded } from "../../lib/aiProcessPreference";
import { aiMotionRef, prefersReducedMotion } from "./motion";
import { MultiAgentProcess } from "./MultiAgentProcess";
import { AgentOfficePanel, agentOfficeSnapshotFromMessage, type AgentOfficeSnapshot } from "./agentOffice";
import {
  formatProcessTotal,
  isReplyProcessExpanded,
  nextReplyProcessDetails,
  REPLY_PROCESS_OUTCOME_LABELS,
  replyProcessActivity,
  replyProcessExecLabel,
  replyProcessSearchLabel,
  replyProcessSummary,
  replyProcessView,
  type ReplyProcessChoice,
  type ReplyProcessDetails,
  type ReplyProcessPart,
  type ReplyProcessView,
} from "./replyProcessModel";
import { harnessTraceRefresh, harnessTraceRequestId, sameHarnessTrace } from "./runTracePolling";
import { useReplyHighlight } from "./useReplyHighlight";
import type { TongpinAIArtifact, TongpinAIMessage } from "./types";
import { ComputerRunLinkContext, type ComputerRunLink } from "./computerRunLink";
import "./reply-markdown.css";
import "./reply-process.css";

/* Adapted from LibreChat v0.8.7 (MIT): the ordered part list follows
 * `ContentParts.tsx`/`Part.tsx`, the header row and chevron follow
 * `ProgressText.tsx`, and the per-group expansion memory with a user override
 * follows `ToolCallGroup.tsx`. The conversation-level preference plays the role
 * of LibreChat's persisted `showThinking` setting. Styling is Tongpin's own. */

const DEFAULT_DETAILS: ReplyProcessDetails = Object.freeze({ expanded: false, revision: 0 });

/** Conversation-level "过程详情" state shared by every reply's process section. */
export const ReplyProcessDetailsContext = createContext<ReplyProcessDetails>(DEFAULT_DETAILS);

/** Per-viewer preference, persisted through the sanctioned safe-storage helper. */
export function useReplyProcessDetails(viewerId?: string): [ReplyProcessDetails, () => void] {
  const [details, setDetails] = useState<ReplyProcessDetails>(() => ({ expanded: viewerId ? readAiProcessDetailsExpanded(viewerId) : false, revision: 0 }));
  useEffect(() => {
    if (viewerId && details.revision > 0) saveAiProcessDetailsExpanded(viewerId, details.expanded);
  }, [details, viewerId]);
  const toggle = useCallback(() => setDetails(nextReplyProcessDetails), []);
  return [details, toggle];
}

export function ReplyProcessDetailsToggle({ details, onToggle }: { details: ReplyProcessDetails; onToggle: () => void }) {
  const action = details.expanded ? "全部收起" : "全部展开";
  return <button type="button" className={`tp-ai-process-toggle-all${details.expanded ? " is-expanded" : ""}`}
    aria-label={`过程详情：${action}`} title={`过程详情：${action}`} onClick={onToggle}>
    {details.expanded ? <ChevronsDownUp size={16} aria-hidden="true" /> : <ChevronsUpDown size={16} aria-hidden="true" />}
    <span><span className="tp-ai-process-toggle-all__prefix">过程详情：</span>{action}</span>
  </button>;
}

/** Background GET of the application-owned run trace. Never claims a
 * continuation or invokes a model; mounted only while the run is active. */
function HarnessTracePoller({ requestId, trace, onTrace }: { requestId: string; trace: AiHarnessTrace; onTrace: (trace: AiHarnessTrace) => void }) {
  const { api } = useAuth();
  const onTraceRef = useRef(onTrace);
  onTraceRef.current = onTrace;
  useEffect(() => {
    const refreshRequest = harnessTraceRefresh(trace);
    if (!refreshRequest) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await api<{ trace: AiHarnessTrace }>(`/api/ai/runs/${encodeURIComponent(requestId)}${refreshRequest.suffix}`, { signal: controller.signal });
        if (!controller.signal.aborted && !sameHarnessTrace(trace, result.trace)) onTraceRef.current(result.trace);
      } catch {
        // The chat result remains usable when a background status refresh fails.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 4_000);
      }
    };
    void refresh();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [api, requestId, trace]);
  return null;
}

/** Whole seconds since the reply's durable start, ticking only while live. */
function useElapsedSeconds(startedAt: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === undefined ? undefined : Math.max(0, Math.floor((now - startedAt) / 1_000));
}

const OUTCOME_ICONS: Record<AiReplyProcessOutcome, ReactNode> = {
  completed: <CheckCircle2 size={14} aria-hidden="true" />,
  partial: <CircleDashed size={14} aria-hidden="true" />,
  stopped: <CircleStop size={14} aria-hidden="true" />,
  failed: <TriangleAlert size={14} aria-hidden="true" />,
};

function partIcon(part: ReplyProcessPart): ReactNode {
  if (part.state === "running") return <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />;
  if (part.state === "failed") return <TriangleAlert size={14} aria-hidden="true" />;
  if (part.state === "waiting") return <Hourglass size={14} aria-hidden="true" />;
  switch (part.kind) {
    case "route": return <Route size={14} aria-hidden="true" />;
    case "plan": return <ListChecks size={14} aria-hidden="true" />;
    case "thinking": return <Lightbulb size={14} aria-hidden="true" />;
    case "search": case "search-total": return <Globe size={14} aria-hidden="true" />;
    case "agents": return <Users size={14} aria-hidden="true" />;
    case "exec": return <Terminal size={14} aria-hidden="true" />;
    case "tool":
      return part.tool === "image" ? <ImageIcon size={14} aria-hidden="true" />
        : part.tool === "video" ? <Video size={14} aria-hidden="true" />
        : part.tool === "presentation" ? <Presentation size={14} aria-hidden="true" />
        : part.tool === "computer" ? <Monitor size={14} aria-hidden="true" />
        : <FileText size={14} aria-hidden="true" />;
  }
}

/** The result card stays where it is; this only brings it into view. */
function showResultCard(event: MouseEvent<HTMLButtonElement>) {
  const cards = event.currentTarget.closest("article")?.querySelector<HTMLElement>(".tp-ai-message__cards");
  if (!cards) return;
  cards.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  cards.querySelector<HTMLElement>("button:not(:disabled), a[href], video, [tabindex]:not([tabindex='-1'])")?.focus({ preventScroll: true });
}

/** Code highlighting reuses the same markdown code-block styling and
 * lowlight grammar; a still-running call has no code/output to reveal yet. */
function ExecDetail({ part }: { part: Extract<ReplyProcessPart, { kind: "exec" }> }) {
  const [feedback, setFeedback] = useState("");
  const highlighted = useReplyHighlight(part.code ?? null, part.language);
  const hasOutput = Boolean(part.logs?.trim()) || Boolean(part.imageCount);
  if (!part.code && !hasOutput) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(part.code ?? ""); setFeedback("已复制代码"); }
    catch { setFeedback("复制失败，请手动选择代码。"); }
  };
  return <div className="tp-ai-process-exec">
    {part.code ? <div className="tp-ai-markdown-code">
      <div className="tp-ai-markdown-code__actions">
        <span className="tp-ai-markdown-code__lang">{part.language}</span>
        <button type="button" onClick={() => void copy()}>复制代码</button>
        <span role="status" aria-live="polite">{feedback}</span>
      </div>
      <pre><code className={highlighted ? `hljs language-${part.language}` : undefined}>{highlighted ?? part.code}</code></pre>
    </div> : null}
    {hasOutput ? <details className="tp-ai-process-exec__output">
      <summary>运行输出</summary>
      {part.logs?.trim() ? <pre className="tp-ai-process-exec__logs">{part.logs}</pre> : null}
      {part.imageCount ? <p className="tp-ai-process-exec__images">生成了 {part.imageCount} 张图</p> : null}
    </details> : null}
  </div>;
}

function PartRow({ part, office, computerLink }: { part: ReplyProcessPart; office?: AgentOfficeSnapshot | null; computerLink?: ComputerRunLink | null }) {
  let title: ReactNode;
  let detail: ReactNode = null;
  switch (part.kind) {
    case "route":
      title = <><strong>路由</strong><span>{part.label}</span></>;
      detail = <p className="tp-ai-process-part__text">{part.detail}</p>;
      break;
    case "plan":
      title = <><strong>{part.label}</strong><small>{part.completed}/{part.steps.length} 步</small></>;
      detail = <ol className="tp-ai-process-plan">{part.steps.map(step => <li key={step.id} className={`is-${step.status}`}>
        {step.status === "succeeded" ? <CheckCircle2 size={13} aria-hidden="true" /> : step.status === "running" ? <LoaderCircle className="is-spinning" size={13} aria-hidden="true" /> : step.status === "failed" ? <TriangleAlert size={13} aria-hidden="true" /> : <Circle size={13} aria-hidden="true" />}
        <span><strong>{step.title}</strong><small>{step.summary}</small></span>
      </li>)}</ol>;
      break;
    case "thinking":
      title = <><strong>思考过程</strong><small>公开摘要</small></>;
      detail = <p className="tp-ai-process-part__text">{part.text}</p>;
      break;
    case "search":
      title = <><strong>联网搜索</strong>{part.query ? <q>{part.query}</q> : null}<small>{replyProcessSearchLabel(part)}</small></>;
      break;
    case "search-total":
      title = <><strong>联网搜索</strong><small>{part.count} 次</small></>;
      break;
    case "agents":
      title = <><strong>多 Agent 协作</strong><small>{part.agents.length ? `${part.agents.filter(agent => agent.status === "done").length}/${part.agents.length} 个子任务完成` : part.state === "running" ? "任务分解中" : "未完成任务分解"}</small></>;
      // The AI 员工办公室 sits with the sub-agent cards: open while the run works, collapsed once it settles.
      detail = <><MultiAgentProcess part={part} />{office ? <AgentOfficePanel snapshot={office} /> : null}</>;
      break;
    case "exec":
      title = <><strong>代码执行</strong><small>{replyProcessExecLabel(part)}</small></>;
      detail = <ExecDetail part={part} />;
      break;
    case "tool":
      title = <><strong>工具调用 · {part.label}</strong><small>{computerLink?.running ? "电脑操作进行中" : part.statusText}</small>
        {part.hasCard ? <button type="button" className="tp-ai-process-part__link" onClick={showResultCard}>{part.state === "done" ? "查看结果" : "查看任务"}</button> : null}
        {computerLink ? <button type="button" className="tp-ai-process-part__link" onClick={computerLink.open}>{computerLink.running ? "查看操作过程" : "查看操作记录"}</button> : null}</>;
      break;
  }
  return <li className={`tp-ai-process-part is-${part.kind} is-${part.state}`}>
    <span className="tp-ai-process-part__icon">{partIcon(part)}</span>
    <div className="tp-ai-process-part__body">
      <p className="tp-ai-process-part__title">{title}</p>
      {detail}
    </div>
  </li>;
}

function headerIcon(view: ReplyProcessView): ReactNode {
  if (view.phase === "running") return <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />;
  if (view.phase === "waiting") return <Hourglass size={14} aria-hidden="true" />;
  return OUTCOME_ICONS[view.outcome];
}

/**
 * The reply's process, in the order it really happened: plan steps, the
 * provider's public thinking summary, each web search, the tool call whose
 * card sits below, then a final "完成 · 用时 N 秒" row. Expanded while the
 * reply streams; one summary line once settled unless the viewer prefers
 * details. Renders nothing for a plain answer.
 */
export function ReplyProcess({ message, artifact, onTraceChange }: {
  message: TongpinAIMessage;
  artifact?: TongpinAIArtifact;
  onTraceChange?: (messageId: string, trace: AiHarnessTrace) => void;
}) {
  const details = useContext(ReplyProcessDetailsContext);
  const computerLink = useContext(ComputerRunLinkContext);
  const [mountedRevision] = useState(details.revision);
  const [choice, setChoice] = useState<ReplyProcessChoice>();
  const [trace, setTrace] = useState(message.trace);
  const bodyId = useId();
  const onTraceChangeRef = useRef(onTraceChange);
  onTraceChangeRef.current = onTraceChange;
  useEffect(() => {
    setTrace(current => !message.trace ? undefined : current && sameHarnessTrace(current, message.trace) ? current : message.trace);
  }, [message.trace]);
  const acceptTrace = useCallback((next: AiHarnessTrace) => {
    setTrace(next);
    onTraceChangeRef.current?.(message.id, next);
  }, [message.id]);
  const view = useMemo(() => replyProcessView({ message, artifact, trace }), [message, artifact, trace]);
  const office = useMemo(() => agentOfficeSnapshotFromMessage(message), [message]);
  const elapsed = useElapsedSeconds(view?.streaming ? view.startedAt : undefined);
  const traceRequestId = harnessTraceRequestId(message);
  const poller = trace && traceRequestId && harnessTraceRefresh(trace)
    ? <HarnessTracePoller requestId={traceRequestId} trace={trace} onTrace={acceptTrace} /> : null;
  if (!view) return poller;

  const expanded = isReplyProcessExpanded({ streaming: view.streaming, details, choice, mountedRevision });
  const headline = view.phase === "settled" ? replyProcessSummary(view) : replyProcessActivity(view, message);
  return <>
    {poller}
    <section className={`tp-ai-process is-${view.phase}${expanded ? " is-expanded" : ""}`} aria-label="回复过程"
      data-outcome={view.phase === "settled" ? view.outcome : undefined}>
      <button type="button" className="tp-ai-process__header" aria-expanded={expanded} aria-controls={expanded ? bodyId : undefined}
        onClick={() => setChoice({ expanded: !expanded, revision: details.revision })}>
        <span className="tp-ai-process__badge">{headerIcon(view)}</span>
        <span className="tp-ai-process__headline">{headline}</span>
        {elapsed !== undefined ? <span className="tp-ai-process__elapsed">已用时 {elapsed} 秒</span> : null}
        <ChevronDown className="tp-ai-process__chevron" size={15} aria-hidden="true" />
      </button>
      {view.phase !== "settled" ? <span className="sr-only" role="status">{replyProcessActivity(view, message)}</span> : null}
      {expanded ? <ol id={bodyId} className="tp-ai-process__parts" aria-label="回复过程详情" ref={view.streaming ? aiMotionRef : undefined}>
        {view.parts.map(part => <PartRow key={part.key} part={part} office={part.kind === "agents" ? office : undefined}
          computerLink={part.kind === "tool" && part.tool === "computer" && computerLink?.messageId === message.id ? computerLink : null} />)}
        {view.phase === "settled" ? <li className={`tp-ai-process-part is-done is-outcome-${view.outcome}`}>
          <span className="tp-ai-process-part__icon">{OUTCOME_ICONS[view.outcome]}</span>
          <div className="tp-ai-process-part__body"><p className="tp-ai-process-part__title">
            <strong>{REPLY_PROCESS_OUTCOME_LABELS[view.outcome]}{view.durationMs !== undefined ? ` · 用时 ${formatProcessTotal(view.durationMs)}` : ""}</strong>
          </p></div>
        </li> : null}
      </ol> : null}
    </section>
  </>;
}
