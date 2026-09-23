import { describe, expect, it } from "vitest";
import { conversationTaskStatus, readSeenResults, saveSeenResults } from "./conversationTaskStatus";
import type { TongpinAIArtifact, TongpinAIConversation } from "./types";
const conversation: TongpinAIConversation = { id: "a", title: "A", timeLabel: "", messages: [{ id: "reply", role: "assistant", content: "视频任务", time: "", artifactId: "video", status: "ready" }] };
const video: TongpinAIArtifact = { id: "video", conversationId: "a", title: "", kind: "视频", summary: "", updatedLabel: "", sections: [], data: { videoJobId: "job" } };
describe("durable conversation result status", () => {
  it("does not report a submitted video as completed or unread", () => {
    expect(conversationTaskStatus(conversation, [video])).toEqual({ phase: "running", messageId: "reply" });
    expect(conversationTaskStatus(conversation, [{ ...video, data: { ...video.data, videoStatus: "uncertain" } }])?.phase).toBe("unknown");
  });
  it("keeps an earlier video active while later text finishes", () => {
    const c = { ...conversation, messages: [...conversation.messages, { id: "text", role: "assistant" as const, content: "later", time: "", status: "ready" as const }] };
    expect(conversationTaskStatus(c, [video])?.phase).toBe("running");
  });
  it("shows completion only after a result; viewing a prior reply does not clear it", () => {
    const artifacts = [{ ...video, data: { ...video.data, videoStatus: "completed" } }];
    const status = conversationTaskStatus(conversation, artifacts);
    expect(status).toMatchObject({ phase: "completed", unread: true });
    expect(conversationTaskStatus(conversation, artifacts, "old-result")?.unread).toBe(true);
    expect(conversationTaskStatus(conversation, artifacts, status?.resultToken)?.unread).toBe(false);
  });
  it("persists only result IDs, scoped to each account, across a restart", () => {
    const data = new Map<string, string>(); const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    saveSeenResults("member-a", { a: "reply:video-ready" }, storage);
    expect(readSeenResults("member-a", storage)).toEqual({ a: "reply:video-ready" });
    expect(readSeenResults("member-b", storage)).toEqual({});
  });
  it("does not accept an artifact from another conversation or silence failure", () => {
    expect(conversationTaskStatus({ ...conversation, messages: [{ ...conversation.messages[0], status: "error" }] }, [{ ...video, conversationId: "b" }])?.phase).toBe("failed");
  });
  it("a save failure does not leave an obsolete queued spinner", () => {
    expect(conversationTaskStatus({ ...conversation, messages: [{ ...conversation.messages[0], taskPhase: "queued", status: "error" }] }, [])?.phase).toBe("failed");
  });
  it("read-marker persistence rejects credentials, content and arbitrary objects", () => {
    let stored = "";
    saveSeenResults("account", { a: "reply:video-ready", key: "sk-provider-key", text: "用户隐私内容", nested: { apiKey: "secret" } } as unknown as Record<string, string>, { setItem: (_, value) => { stored = value; } });
    expect(JSON.parse(stored)).toEqual({ a: "reply:video-ready" });
  });
  it("tracks a new persistent media task without treating its queued assistant message as completed", () => {
    const media = { ...video, data: { mediaTaskRequestId: "request-media", mediaTaskStatus: "queued" } };
    expect(conversationTaskStatus(conversation, [media])?.phase).toBe("queued");
    expect(conversationTaskStatus(conversation, [{ ...media, data: { ...media.data, mediaTaskStatus: "awaiting_input" } }])?.phase).toBe("awaiting_input");
    expect(conversationTaskStatus(conversation, [{ ...media, data: { ...media.data, mediaTaskStatus: "cancelled" } }])?.phase).toBe("cancelled");
    expect(conversationTaskStatus(conversation, [{ ...media, data: { ...media.data, mediaTaskStatus: "completed", mediaTaskResultIds: ["asset-id"] } }])?.resultToken).toBe("reply:media-ready");
  });
});
