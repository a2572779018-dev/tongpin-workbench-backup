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
    expect(emitted).toEqual(["run_started", "tool_started", "tool_progress", "tool_finished", "answer_delta", "usage_updated", "run_finished"]);
    expect(JSON.stringify(result.events)).not.toContain("private tool output");
    expect(JSON.stringify(result.events)).not.toContain("{hidden}");
    expect(result.events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
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
