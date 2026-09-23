import { describe, expect, it, vi } from "vitest";
import { DifyEngineAdapter } from "./difyEngine";

function fragmentedSse(events: Record<string, unknown>[], fragment = 11) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += fragment) controller.enqueue(bytes.slice(offset, offset + fragment));
      controller.close();
    },
  });
}

const input = {
  tenantId: "tenant-a", userId: "member-1", conversationId: "conversation-a",
  runId: "run-a", attemptId: "attempt-a", query: "查询后总结", toolAuthorization: "signed-grant",
};

describe("Dify engine adapter", () => {
  it("binds the Tongpin task snapshot and maps a fragmented multi-step Dify stream", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(fragmentedSse([
        { event: "agent_thought", task_id: "task-remote", message_id: "message-remote", conversation_id: "conversation-remote", id: "tool-step-1", tool: "tongpin_lookup", tool_input: "{hidden}" },
        { event: "agent_thought", task_id: "task-remote", message_id: "message-remote", conversation_id: "conversation-remote", id: "tool-step-1", tool: "tongpin_lookup", observation: "private tool output" },
        { event: "agent_thought", task_id: "task-remote", message_id: "message-remote", conversation_id: "conversation-remote", id: "tool-step-2", tool: "tongpin_summarize" },
        { event: "agent_thought", task_id: "task-remote", message_id: "message-remote", conversation_id: "conversation-remote", id: "tool-step-2", observation: "second private output" },
        { event: "agent_message", task_id: "task-remote", message_id: "message-remote", conversation_id: "conversation-remote", answer: "已完成" },
        { event: "message_end", task_id: "task-remote", message_id: "message-remote", conversation_id: "conversation-remote", metadata: { usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } } },
      ], 7), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    const emitted: string[] = [];
    const result = await new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl }).run(input, event => emitted.push(event.type));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestBody).toMatchObject({
      response_mode: "streaming", query: input.query, user: "tenant-a:member-1",
      inputs: {
        tongpin_tenant_id: "tenant-a", tongpin_user_id: "member-1", tongpin_conversation_id: "conversation-a",
        tongpin_run_id: "run-a", tongpin_attempt_id: "attempt-a", tongpin_tool_authorization: "signed-grant",
      },
    });
    expect(result).toMatchObject({ engine: "dify", status: "completed", answer: "已完成", remoteTaskId: "task-remote", remoteConversationId: "conversation-remote" });
    expect(emitted).toEqual(["run_started", "tool_started", "tool_progress", "tool_finished", "tool_started", "tool_progress", "tool_finished", "answer_delta", "usage_updated", "run_finished"]);
    expect(JSON.stringify(result.events)).not.toContain("private tool output");
    expect(JSON.stringify(result.events)).not.toContain("second private output");
    expect(JSON.stringify(result.events)).not.toContain("{hidden}");
    expect(result.events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("does not append the Agent closing full message to already streamed agent_message deltas", async () => {
    const ids = { task_id: "task-agent", message_id: "message-agent", conversation_id: "conversation-agent" };
    const fetchImpl = vi.fn(async () => new Response(fragmentedSse([
      { event: "agent_message", ...ids, answer: "你好，" },
      { event: "agent_message", ...ids, answer: "世界" },
      { event: "message", ...ids, answer: "你好，世界" },
      { event: "message_end", ...ids, metadata: { usage: { total_tokens: 3 } } },
    ], 3), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const result = await new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl }).run(input);
    expect(result.answer).toBe("你好，世界");
    expect(result.events.filter(event => event.type === "answer_delta").map(event => event.content)).toEqual(["你好，", "世界"]);
    expect(result.events.at(-1)?.type).toBe("run_finished");
  });

  it("emits only the missing suffix when the Agent final message completes partial deltas", async () => {
    const ids = { task_id: "task-agent", message_id: "message-agent", conversation_id: "conversation-agent" };
    const fetchImpl = vi.fn(async () => new Response(fragmentedSse([
      { event: "agent_message", ...ids, answer: "你好，" },
      { event: "message", ...ids, answer: "你好，世界" },
      { event: "message_end", ...ids },
    ], 5), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const result = await new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl }).run(input);
    expect(result.answer).toBe("你好，世界");
    expect(result.events.filter(event => event.type === "answer_delta").map(event => event.content)).toEqual(["你好，", "世界"]);
  });

  it("retains agent_message-only Legacy Agent and message-only Chatbot streams", async () => {
    for (const event of ["agent_message", "message"] as const) {
      const ids = { task_id: `task-${event}`, message_id: `message-${event}`, conversation_id: `conversation-${event}` };
      const fetchImpl = vi.fn(async () => new Response(fragmentedSse([
        { event, ...ids, answer: "片段一" },
        { event, ...ids, answer: "片段二" },
        { event: "message_end", ...ids },
      ], 2), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
      const result = await new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl }).run(input);
      expect(result.answer).toBe("片段一片段二");
      expect(result.events.filter(item => item.type === "answer_delta").map(item => item.content)).toEqual(["片段一", "片段二"]);
    }
  });

  it("waits for a successful workflow_finished after Chatflow message chunks", async () => {
    const ids = { task_id: "task-chatflow", conversation_id: "conversation-chatflow", workflow_run_id: "workflow-chatflow" };
    const fetchImpl = vi.fn(async () => new Response(fragmentedSse([
      { event: "workflow_started", ...ids },
      { event: "message", ...ids, message_id: "message-chatflow", answer: "你好，" },
      { event: "message", ...ids, message_id: "message-chatflow", answer: "世界" },
      { event: "message_end", ...ids, message_id: "message-chatflow", metadata: { usage: { total_tokens: 3 } } },
      { event: "workflow_finished", ...ids, data: { status: "succeeded" } },
    ], 4), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const result = await new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl }).run(input);
    expect(result).toMatchObject({ status: "completed", answer: "你好，世界", remoteWorkflowRunId: "workflow-chatflow" });
    expect(result.events.filter(event => event.type === "answer_delta").map(event => event.content)).toEqual(["你好，", "世界"]);
    expect(result.events.slice(-2).map(event => event.type)).toEqual(["usage_updated", "run_finished"]);
  });

  it("does not report Chatflow success from message_end without workflow_finished", async () => {
    const ids = { task_id: "task-chatflow", conversation_id: "conversation-chatflow", workflow_run_id: "workflow-chatflow" };
    const fetchImpl = vi.fn(async () => new Response(fragmentedSse([
      { event: "workflow_started", ...ids },
      { event: "message", ...ids, message_id: "message-chatflow", answer: "片段" },
      { event: "message_end", ...ids, message_id: "message-chatflow", metadata: { usage: { total_tokens: 3 } } },
    ]), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const emitted: string[] = [];
    await expect(new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl }).run(input, event => emitted.push(event.type)))
      .rejects.toMatchObject({ code: "DIFY_OUTCOME_UNKNOWN", outcome: "unknown", retryable: false });
    expect(emitted).not.toContain("usage_updated");
    expect(emitted).not.toContain("run_finished");
  });

  it("does not report Chatflow success when workflow_finished fails or lacks its run ID", async () => {
    for (const [workflowRunId, status] of [["workflow-chatflow", "failed"], [undefined, "succeeded"]] as const) {
      const ids = { task_id: "task-chatflow", conversation_id: "conversation-chatflow", ...(workflowRunId ? { workflow_run_id: workflowRunId } : {}) };
      const fetchImpl = vi.fn(async () => new Response(fragmentedSse([
        { event: "workflow_started", ...ids },
        { event: "message", ...ids, message_id: "message-chatflow", answer: "片段" },
        { event: "message_end", ...ids, message_id: "message-chatflow", metadata: { usage: { total_tokens: 3 } } },
        { event: "workflow_finished", ...ids, data: { status } },
      ]), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
      const emitted: string[] = [];
      await expect(new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl }).run(input, event => emitted.push(event.type)))
        .rejects.toMatchObject({ outcome: status === "failed" ? "failed" : "unknown", retryable: false });
      expect(emitted).not.toContain("usage_updated");
      expect(emitted).not.toContain("run_finished");
    }
  });

  it("rejects a divergent Agent closing answer instead of showing duplicate or inconsistent text", async () => {
    const ids = { task_id: "task-agent", message_id: "message-agent", conversation_id: "conversation-agent" };
    const fetchImpl = vi.fn(async () => new Response(fragmentedSse([
      { event: "agent_message", ...ids, answer: "先前片段" },
      { event: "message", ...ids, answer: "不同的最终回答" },
      { event: "message_end", ...ids, metadata: { usage: { total_tokens: 3 } } },
    ]), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const emitted: string[] = [];
    await expect(new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl }).run(input, event => emitted.push(event.type)))
      .rejects.toMatchObject({ code: "DIFY_PROTOCOL_ERROR", outcome: "unknown", retryable: false });
    expect(emitted).not.toContain("usage_updated");
    expect(emitted).not.toContain("run_finished");
  });

  it("keeps terminal success and usage hidden when an observed tool never finishes", async () => {
    const fetchImpl = vi.fn(async () => new Response(fragmentedSse([
      { event: "agent_thought", task_id: "task-unresolved", message_id: "message-unresolved", conversation_id: "conversation-unresolved", id: "tool-1", tool: "tongpin_lookup" },
      { event: "message_end", task_id: "task-unresolved", message_id: "message-unresolved", conversation_id: "conversation-unresolved", metadata: { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } },
    ]), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const emitted: string[] = [];
    await expect(new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl }).run(input, event => emitted.push(event.type)))
      .rejects.toMatchObject({ code: "DIFY_OUTCOME_UNKNOWN", outcome: "unknown", retryable: false });
    expect(emitted).toEqual(["run_started", "tool_started", "tool_progress"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["task ID", { message_id: "message-only", conversation_id: "conversation-only" }],
    ["conversation ID", { task_id: "task-only", message_id: "message-only" }],
    ["valid task ID", { task_id: "   ", message_id: "message-only", conversation_id: "conversation-only" }],
  ])("rejects terminal success without the required remote %s", async (_label, ids) => {
    const fetchImpl = vi.fn(async () => new Response(fragmentedSse([
      { event: "agent_message", ...ids, answer: "不可提前视为完成" },
      { event: "message_end", ...ids, metadata: { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } },
    ]), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const emitted: string[] = [];
    await expect(new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl }).run(input, event => emitted.push(event.type)))
      .rejects.toMatchObject({ outcome: "unknown", retryable: false });
    expect(emitted).not.toContain("run_finished");
    expect(emitted).not.toContain("usage_updated");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a post-terminal error without ever publishing success or usage", async () => {
    const ids = { task_id: "task-remote", message_id: "message-remote", conversation_id: "conversation-remote" };
    const fetchImpl = vi.fn(async () => new Response(fragmentedSse([
      { event: "message_end", ...ids, metadata: { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } },
      { event: "error", ...ids, code: "REMOTE_FAILED", message: "failed after terminal" },
    ]), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const emitted: string[] = [];
    await expect(new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl }).run(input, event => emitted.push(event.type)))
      .rejects.toMatchObject({ code: "DIFY_PROTOCOL_ERROR", outcome: "unknown", retryable: false });
    expect(emitted).toEqual(["run_started"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("holds terminal events until the accepted stream closes cleanly", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const emitted: string[] = [];
    const run = new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl }).run(input, event => emitted.push(event.type));
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ event: "message_end", task_id: "task-clean", message_id: "message-clean", conversation_id: "conversation-clean", metadata: { usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } })}\n\n`));
    await vi.waitFor(() => expect(emitted).toContain("run_started"));
    expect(emitted).not.toContain("usage_updated");
    expect(emitted).not.toContain("run_finished");
    controller.close();
    await expect(run).resolves.toMatchObject({ status: "completed", remoteTaskId: "task-clean" });
    expect(emitted).toEqual(["run_started", "usage_updated", "run_finished"]);
  });

  it("does not accept an unterminated terminal SSE frame as completion", async () => {
    const frame = `data: ${JSON.stringify({ event: "message_end", task_id: "task-tail", message_id: "message-tail", conversation_id: "conversation-tail", metadata: { usage: { total_tokens: 9 } } })}`;
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const emitted: string[] = [];
    await expect(new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl }).run(input, event => emitted.push(event.type)))
      .rejects.toMatchObject({ code: "DIFY_OUTCOME_UNKNOWN", outcome: "unknown", retryable: false });
    expect(emitted).toEqual([]);
  });

  it("marks a disconnected identified task unknown and never retries or falls back", async () => {
    const fetchImpl = vi.fn(async () => new Response(fragmentedSse([
      { event: "agent_message", task_id: "remote-running", message_id: "message-a", conversation_id: "remote-conversation", answer: "partial" },
    ]), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const adapter = new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080/v1", apiKey: "server-secret", fetchImpl });
    await expect(adapter.run(input)).rejects.toMatchObject({ code: "DIFY_OUTCOME_UNKNOWN", outcome: "unknown", retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not expose the API key in health results or errors", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer server-secret");
      return new Response(JSON.stringify({ name: "Tongpin Dify", description: "Local agent" }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const adapter = new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "server-secret", fetchImpl });
    expect(await adapter.health()).toEqual({ reachable: true, name: "Tongpin Dify", description: "Local agent" });
    expect(JSON.stringify(await adapter.health())).not.toContain("server-secret");
  });
});
