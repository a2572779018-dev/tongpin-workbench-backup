import { describe, expect, it } from "vitest";
import { workspaceV2Client, type WorkspaceV2Api } from "./workspaceV2Client";

describe("V2 browser client boundary", () => {
  it("uses only narrow V2 routes and carries the account guard", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const api: WorkspaceV2Api = async <T,>(path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return { schemaVersion: 2, epoch: 1, entities: [], revision: 1, messages: [], artifact: {} } as T;
    };
    const client = workspaceV2Client(api, "member-a");
    await client.bootstrap();
    await client.context("conversation-a");
    await client.messages("conversation-a", "message-a");
    await client.mutate(1, [{ kind: "draft", entityId: "conversation-a", expectedRevision: 0, action: "put", value: "草稿" }]);
    await client.appendUser(1, "conversation-a", 1, { id: "user-a", role: "user", content: "你好", time: "10:00" });
    await client.commitAssistant(1, "conversation-a", 2, crypto.randomUUID(), "assistant-a");
    expect(calls.map(call => call.path)).toEqual([
      "/api/ai/workspace-v2/bootstrap", "/api/ai/workspace-v2/conversations/conversation-a/context",
      "/api/ai/workspace-v2/conversations/conversation-a/messages?limit=30&before=message-a",
      "/api/ai/workspace-v2/mutate", "/api/ai/workspace-v2/append-user", "/api/ai/workspace-v2/commit-assistant",
    ]);
    expect(calls.every(call => new Headers(call.init?.headers).get("X-Tongpin-Account") === "member-a")).toBe(true);
    expect(calls.every(call => !call.path.includes("/api/ai/workspace/"))).toBe(true);
  });
});
