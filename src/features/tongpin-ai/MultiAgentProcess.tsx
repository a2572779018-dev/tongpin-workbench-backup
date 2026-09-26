import { CheckCircle2, ChevronDown, CircleStop, Globe, Hourglass, LoaderCircle, PenLine, Sparkles, TriangleAlert, Users } from "lucide-react";
import { useEffect, useId, useReducer, useRef, useState, type ReactNode } from "react";
import type { AiSubagentStatus } from "../../../shared/aiMultiAgent";
import { ReplyCitationMarker } from "./ReplyCitation";
import { formatProcessDuration, type ReplyProcessAgentView, type ReplyProcessPart } from "./replyProcessModel";
import "./multi-agent.css";

/*
 * 多 Agent 协作 inside the reply process. Adapted from LibreChat v0.8.7
 * (MIT, Copyright (c) 2026 LibreChat), commit
 * 9e74cc0e57b395926122bd4062c1fcedc48ed465,
 * client/src/components/Chat/Messages/Content/Parts/SubagentCall.tsx: one
 * compact card per sub-agent whose header resolves running / finished /
 * cancelled / errored, a short "what it is doing right now" ticker whose
 * newest characters stay visible (label span + `dir="rtl"` body span), and the
 * trailing-edge `useThrottledValue` hook (400 ms, pass-through for short
 * text). 同频 shows the details inline instead of LibreChat's dialog; every
 * state comes from a real run event or the saved process record.
 */

export const SUBAGENT_TICKER_THROTTLE_MS = 400;
/** Shorter lines pass straight through. LibreChat uses 120 characters; 同频
 * activity lines are capped at 80 code points, so the threshold scales down. */
const TICKER_PASSTHROUGH_CHARS = 40;

const STATUS_LABELS: Record<AiSubagentStatus, string> = {
  queued: "排队中", thinking: "思考中", working: "撰写中", searching: "联网搜索中", done: "已完成", failed: "未完成", cancelled: "已停止",
};
const SYNTHESIS_LABELS = { running: "正在综合各子任务的结果", done: "已综合为下方回答", failed: "未能完成综合", cancelled: "已停止" } as const;

/** LibreChat `useThrottledValue`: forwards `value` at most once per interval
 * while enabled; refs + a reducer avoid a render loop on fresh references. */
export function useThrottledValue<T>(value: T, intervalMs: number, enabled: boolean): T {
  const [, forceUpdate] = useReducer((count: number) => count + 1, 0);
  const throttledRef = useRef<T>(value);
  const latestRef = useRef<T>(value);
  const lastFireRef = useRef(Number.NEGATIVE_INFINITY);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  latestRef.current = value;
  let effective: T;
  if (!enabled) effective = value;
  else {
    const now = performance.now();
    if (now - lastFireRef.current >= intervalMs) { throttledRef.current = value; lastFireRef.current = now; effective = value; }
    else effective = throttledRef.current;
  }
  useEffect(() => {
    if (!enabled) { if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; } return; }
    if (Object.is(throttledRef.current, latestRef.current) || timerRef.current !== null) return;
    const delay = Math.max(0, intervalMs - (performance.now() - lastFireRef.current));
    timerRef.current = setTimeout(() => { timerRef.current = null; forceUpdate(); }, delay);
  }, [value, intervalMs, enabled]);
  useEffect(() => () => { if (timerRef.current !== null) clearTimeout(timerRef.current); }, []);
  return effective;
}

function statusIcon(status: AiSubagentStatus): ReactNode {
  switch (status) {
    case "queued": return <Hourglass size={13} aria-hidden="true" />;
    case "thinking": return <LoaderCircle className="is-spinning" size={13} aria-hidden="true" />;
    case "working": return <PenLine size={13} aria-hidden="true" />;
    case "searching": return <Globe size={13} aria-hidden="true" />;
    case "done": return <CheckCircle2 size={13} aria-hidden="true" />;
    case "failed": return <TriangleAlert size={13} aria-hidden="true" />;
    case "cancelled": return <CircleStop size={13} aria-hidden="true" />;
  }
}

/** "联网搜索：深圳 天气" → label + body, so only the body clips at its start. */
function splitActivity(activity: string): { label?: string; body: string } {
  const index = activity.indexOf("：");
  return index > 0 && index <= 6 ? { label: activity.slice(0, index), body: activity.slice(index + 1) } : { body: activity };
}

function AgentTicker({ agent }: { agent: ReplyProcessAgentView }) {
  const text = useThrottledValue(agent.activity ?? "", SUBAGENT_TICKER_THROTTLE_MS, agent.live && (agent.activity?.length ?? 0) >= TICKER_PASSTHROUGH_CHARS);
  if (!text) return null;
  const { label, body } = splitActivity(text);
  // LibreChat's `dir="rtl"` body keeps the newest characters visible; the
  // inner LTR isolate stops Chinese end punctuation from flipping sides.
  const tail = agent.live && Boolean(label);
  return <p className="tp-ai-agent__ticker">
    {label ? <span className="tp-ai-agent__ticker-label">{label}：</span> : null}
    <span className="tp-ai-agent__ticker-body" dir={tail ? "rtl" : undefined}>{tail ? <bdi dir="ltr">{body}</bdi> : body}</span>
  </p>;
}

function AgentCard({ agent }: { agent: ReplyProcessAgentView }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const duration = agent.durationMs !== undefined && !agent.live ? ` · ${formatProcessDuration(agent.durationMs)}` : "";
  return <li className={`tp-ai-agent is-${agent.status}${agent.live ? " is-live" : ""}`} data-agent-id={agent.id}>
    <button type="button" className="tp-ai-agent__header" aria-expanded={open} aria-controls={open ? detailsId : undefined} onClick={() => setOpen(current => !current)}>
      <span className="tp-ai-agent__avatar">{statusIcon(agent.status)}</span>
      <span className="tp-ai-agent__role">{agent.role}</span>
      <span className="tp-ai-agent__title">{agent.title}</span>
      <span className="tp-ai-agent__status">{STATUS_LABELS[agent.status]}{duration}</span>
      <ChevronDown className="tp-ai-agent__chevron" size={14} aria-hidden="true" />
    </button>
    <AgentTicker agent={agent} />
    {open ? <dl id={detailsId} className="tp-ai-agent__details">
      <div><dt>子任务</dt><dd className="is-task">{agent.task}</dd></div>
      {agent.summary ? <div><dt>结论</dt><dd>{agent.summary}</dd></div> : null}
      {agent.error && agent.status !== "done" ? <div className="is-error"><dt>状态</dt><dd>{agent.error}</dd></div> : null}
      {agent.searchCount ? <div><dt>联网</dt><dd>搜索 {agent.searchCount} 次{agent.sourceCount ? ` · ${agent.sourceCount} 个来源` : ""}</dd></div> : null}
      {agent.sources?.length ? <div><dt>引用</dt><dd><ReplyCitationMarker node={{ properties: { dataNumbers: agent.sources.join(" ") } }}>
        <span className="tp-ai-agent__source-count">{agent.sources.map(n => `[${n}]`).join("")}</span>
      </ReplyCitationMarker></dd></div> : null}
    </dl> : null}
  </li>;
}

/** 任务分解 → one card per sub-agent → 结果综合. */
export function MultiAgentProcess({ part }: { part: Extract<ReplyProcessPart, { kind: "agents" }> }) {
  const running = part.state === "running";
  return <div className="tp-ai-agents" data-phase={part.phase}>
    <p className="tp-ai-agents__coordinator">
      <span className="tp-ai-agents__badge"><Users size={13} aria-hidden="true" />协调 Agent</span>
      <span className="tp-ai-agents__coordinator-text">{part.coordinatorActivity}</span>
    </p>
    {part.agents.length ? <>
      <p className="tp-ai-agents__meta">任务分解 · {part.agents.length} 个子任务{part.maxConcurrency ? ` · 最多同时 ${part.maxConcurrency} 个` : ""}</p>
      <ol className="tp-ai-agents__list" aria-label="子 Agent">
        {part.agents.map(agent => <AgentCard key={agent.id} agent={agent} />)}
      </ol>
    </> : null}
    {part.synthesis ? <p className={`tp-ai-agents__synthesis is-${part.synthesis}`}>
      {part.synthesis === "running" && running ? <LoaderCircle className="is-spinning" size={13} aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}
      <strong>结果综合</strong><span>{SYNTHESIS_LABELS[part.synthesis]}</span>
    </p> : null}
  </div>;
}
