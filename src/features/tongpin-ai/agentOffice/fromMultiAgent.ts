// Adapter from a Pro 多 Agent 协作 reply to the AI-employee office. Field
// mapping: docs/ai-handoff/11-多Agent协作开源选型.md, section 7. Kept free of
// pixi.js so the chat can import it without pulling in the renderer.

import { readReplyProcess, type AiReplyProcessAgentsStep, type AiReplyProcessLiveAgents } from "../../../../shared/aiReplyProcess";
import { agentsPart, isReplyStreaming } from "../replyProcessModel";
import type { TongpinAIMessage } from "../types";
import type { AgentOfficePhase, AgentOfficeSnapshot, AgentOfficeStatus, AgentOfficeWorker } from "./types";

export const AGENT_OFFICE_COORDINATOR_NAME = "协调 Agent";

/** The coordinator's own state follows the run phase (section 7's suggestion):
 * it thinks while it plans or waits on the workers, works while it dispatches
 * or synthesizes, and ends with the run. */
const COORDINATOR_STATUS: Readonly<Record<AgentOfficePhase, AgentOfficeStatus>> = {
  planning: "thinking",
  dispatching: "working",
  working: "thinking",
  synthesizing: "working",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

type OfficeMessage = Pick<TongpinAIMessage, "id" | "role" | "requestId" | "status" | "liveProcess" | "process">;

/** The reply's 多 Agent 协作 step, chosen exactly as the reply process picks
 * its record: the live journal while the reply streams, the saved record after. */
function agentsStep(message: OfficeMessage, streaming: boolean): AiReplyProcessLiveAgents | AiReplyProcessAgentsStep | undefined {
  if (streaming && message.liveProcess?.steps.length) {
    return message.liveProcess.steps.find((step): step is AiReplyProcessLiveAgents => step.kind === "agents");
  }
  return readReplyProcess(message.process)?.steps.find((step): step is AiReplyProcessAgentsStep => step.kind === "agents");
}

/**
 * The office snapshot for one assistant message, or null when the reply is not
 * a 多 Agent 协作 run (including a coordinator that answered directly). Built on
 * `agentsPart`, so the live and the saved record read exactly like the process
 * cards next to it (a stopped run shows its unfinished workers as stopped).
 */
export function agentOfficeSnapshotFromMessage(message: OfficeMessage): AgentOfficeSnapshot | null {
  if (message.role !== "assistant") return null;
  const streaming = isReplyStreaming(message);
  const step = agentsStep(message, streaming);
  if (!step) return null;
  const part = agentsPart(step, streaming);
  const workers = part.agents.map((agent): AgentOfficeWorker => ({
    id: agent.id,
    role: agent.role,
    task: agent.task,
    status: agent.status,
    ...(agent.activity ? { activity: agent.activity } : {}),
    ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
    ...(agent.finishedAt !== undefined ? { finishedAt: agent.finishedAt } : {}),
    ...(agent.summary ? { resultSummary: agent.summary } : {}),
    ...(agent.sourceCount !== undefined ? { sourceCount: agent.sourceCount } : {}),
  }));
  return {
    // The events' request id; a V2 stream placeholder has none yet, so its row id keeps the scene stable.
    runId: message.requestId ?? message.id,
    phase: part.phase,
    coordinator: { name: AGENT_OFFICE_COORDINATOR_NAME, status: COORDINATOR_STATUS[part.phase], activity: part.coordinatorActivity },
    workers,
    updatedAt: part.updatedAt ?? part.finishedAt ?? part.startedAt ?? 0,
  };
}
