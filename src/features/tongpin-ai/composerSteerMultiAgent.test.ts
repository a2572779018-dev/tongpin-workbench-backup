import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AiSubagentUpdate } from "../../../shared/aiMultiAgent";
import { applyReplyProcessEvent, EMPTY_REPLY_PROCESS_LIVE, type AiReplyProcessEvent, type AiReplyProcessLive } from "../../../shared/aiReplyProcess";
import { activeMultiAgentRequestId, steerDeliveryTarget, steerRunActive } from "./composerSteer";
import type { TongpinAIMessage } from "./types";

/* Steer × Pro 多 Agent 协作: a supplement typed while a multi-agent reply
 * streams goes to that request's run guidance (taken before the sub-agents or
 * before synthesis) instead of waiting for the follow-up turn. */

const REQUEST_ID = "request-multi-agent-000001";
const update = (timestamp: number, data: AiSubagentUpdate): AiReplyProcessEvent => ({ type: "subagent_update", data, timestamp });
const PLAN: AiSubagentUpdate = { phase: "plan", maxConcurrency: 2, subtasks: [
  { id: "agent-1", role: "研究员", title: "方面1", task: "分析第一个方面。", search: false },
  { id: "agent-2", role: "分析员", title: "方面2", task: "分析第二个方面。", search: false },
] };
const live = (...updates: AiSubagentUpdate[]): AiReplyProcessLive => updates.reduce((state, data, index) => applyReplyProcessEvent(state, update(1_000 + index, data)), EMPTY_REPLY_PROCESS_LIVE);
const reply = (liveProcess: AiReplyProcessLive | undefined, overrides: Partial<TongpinAIMessage> = {}): TongpinAIMessage => ({
  id: "assistant-ma", role: "assistant", content: "", time: "12:00", status: "thinking", requestId: REQUEST_ID, ...(liveProcess ? { liveProcess } : {}), ...overrides,
});

describe("steering a streaming Pro 多 Agent 协作 reply", () => {
  it("routes a supplement to the run's guidance while a checkpoint is still ahead", () => {
    for (const process of [live({ phase: "planning" }), live({ phase: "planning" }, PLAN), live({ phase: "planning" }, PLAN, { phase: "start", id: "agent-1" })]) {
      expect(activeMultiAgentRequestId(reply(process))).toBe(REQUEST_ID);
      expect(steerDeliveryTarget(reply(process))).toEqual({ kind: "guidance", runRequestId: REQUEST_ID });
      expect(steerDeliveryTarget(reply(process, { status: "typing" }))).toEqual({ kind: "guidance", runRequestId: REQUEST_ID });
    }
  });

  it("keeps the follow-up path when no checkpoint is left or the reply is not a live multi-agent run", () => {
    const working = live({ phase: "planning" }, PLAN, { phase: "start", id: "agent-1" });
    for (const message of [
      reply(live({ phase: "planning" }, PLAN, { phase: "synthesis" })), // synthesis already took its guidance
      reply(live({ phase: "planning" }, PLAN, { phase: "finish", outcome: "done" })),
      reply(live({ phase: "planning" }, { phase: "direct" })), // the coordinator answers itself
      reply(working, { status: "ready" }), // settled: the run is over
      reply(working, { requestId: "draft-conversation-1" }),
      reply(working, { requestId: undefined }),
      reply(undefined),
      { ...reply(working), role: "user" as const },
    ]) expect(steerDeliveryTarget(message)).toEqual({ kind: "followup" });
  });

  it("treats the run as active only while its reply streams, so untaken items become the follow-up turn", () => {
    const working = live({ phase: "planning" }, PLAN, { phase: "start", id: "agent-1" });
    expect(steerRunActive([reply(working)], REQUEST_ID)).toBe(true);
    expect(steerRunActive([reply(working, { status: "ready" })], REQUEST_ID)).toBe(false);
    expect(steerRunActive([reply(undefined, { status: "ready" })], REQUEST_ID)).toBe(false);
  });

  it("reads the reply as rendered, with its live stream state, in the main workspace", () => {
    const page = readFileSync(new URL("../../pages/TongpinAIPage.tsx", import.meta.url), "utf8");
    expect(page).toContain("steerDeliveryTarget(reply && withLiveReply(reply))");
    expect(page).toContain("?.messages.map(withLiveReply), runRequestId)");
    expect(page).toContain("liveProcess: streamReplies[message.id].liveProcess");
  });
});
