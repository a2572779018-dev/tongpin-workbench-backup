import { describe, expect, it, vi } from "vitest";
import { validateAiWorkspaceState } from "../../../server/ai/workspace";
import { liveConversation, withoutConversation } from "./conversationOperations";
import { hydrateWorkspace, serializeWorkspace } from "./workspaceState";

function fixture() {
  const state = hydrateWorkspace(null);
  state.projects = [{ id: "project-a", title: "客户资料", timeLabel: "刚刚" }];
  state.conversations = [
    { id: "conversation-a", projectId: "project-a", title: "待删除", timeLabel: "刚刚", messages: [{ id: "message-a", role: "assistant", content: "答复", time: "12:00", artifactId: "artifact-a" }] },
    { id: "conversation-b", title: "保留", timeLabel: "刚刚", messages: [{ id: "message-b", role: "user", content: "你好", time: "12:00" }] },
  ];
  state.artifacts = [{ id: "artifact-a", conversationId: "conversation-a", projectId: "project-a", title: "图片", kind: "图片", updatedLabel: "刚刚", summary: "结果", sections: [], data: { images: [{ assetId: "asset-a", mimeType: "image/png" }] } }];
  state.drafts = { "conversation-a": "待删除草稿", "conversation-b": "保留草稿" };
  state.draftAttachments = { "conversation-a": [{ id: "document-a", name: "资料.txt", mimeType: "text/plain", content: "资料" }] };
  state.videoDraftSettings = {
    "conversation-a": { model: "sd-2.5-c1", seconds: 30, resolution: "720p", aspectRatio: "16:9" },
    "conversation-b": { seconds: 15, resolution: "768p", aspectRatio: "9:16" },
  };
  state.activeConversationId = "conversation-a";
  state.activeProjectId = "project-a";
  return state;
}

describe("conversation generation/deletion race guards", () => {
  it("blocks new sends, retries, and recovered results while asset deletion is pending", async () => {
    let state = fixture();
    const deleting = new Set(["conversation-a"]);
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const paidCall = vi.fn();
    const recoverResult = vi.fn();
    const deletingTask = waiting.then(() => { state = withoutConversation(state, "conversation-a"); deleting.delete("conversation-a"); });
    if (liveConversation(state, deleting, "conversation-a")) paidCall();
    if (liveConversation(state, deleting, "conversation-a", "message-a")) recoverResult();
    expect(paidCall).not.toHaveBeenCalled();
    expect(recoverResult).not.toHaveBeenCalled();
    expect(liveConversation(state, deleting, "conversation-b", "message-b")?.id).toBe("conversation-b");
    finish(); await deletingTask;
    // Stale callbacks stay blocked even after the lock is released.
    expect(liveConversation(state, deleting, "conversation-a", "message-a")).toBeUndefined();
  });

  it("rejects a disappeared assistant message before any paid request", () => {
    const state = fixture(), paidCall = vi.fn();
    state.conversations[0].messages = [];
    if (liveConversation(state, new Set(), "conversation-a", "message-a")) paidCall();
    expect(paidCall).not.toHaveBeenCalled();
  });

  it("preserves a different conversation selected while deletion was waiting", () => {
    const state = fixture();
    state.activeConversationId = "conversation-b"; state.activeProjectId = null;
    const next = withoutConversation(state, "conversation-a");
    expect(next.activeConversationId).toBe("conversation-b"); expect(next.activeProjectId).toBeNull(); expect(next.view).toBe("chat");
    expect(() => validateAiWorkspaceState(serializeWorkspace(next))).not.toThrow();
  });

  it("clears a target selected after deletion began and removes every associated reference", () => {
    const state = fixture();
    const next = withoutConversation(state, "conversation-a");
    expect(next.activeConversationId).toBeNull(); expect(next.activeProjectId).toBe("project-a"); expect(next.view).toBe("project");
    expect(next.conversations.map(item => item.id)).toEqual(["conversation-b"]);
    expect(next.artifacts).toEqual([]); expect(next.drafts).toEqual({ "conversation-b": "保留草稿" }); expect(next.draftAttachments).toEqual({});
    expect(state.conversations).toHaveLength(2); expect(state.drafts["conversation-a"]).toBe("待删除草稿");
    expect(next.videoDraftSettings).toEqual({ "conversation-b": state.videoDraftSettings!["conversation-b"] });
    expect(state.videoDraftSettings!["conversation-a"].model).toBe("sd-2.5-c1");
    expect(() => validateAiWorkspaceState(serializeWorkspace(next))).not.toThrow();
  });

  it("does not resurrect a project deleted while assets were being removed", () => {
    const state = fixture(); state.projects = [];
    const next = withoutConversation(state, "conversation-a");
    expect(next.activeProjectId).toBeNull(); expect(next.view).toBe("chat");
    expect(() => validateAiWorkspaceState(serializeWorkspace(next))).not.toThrow();
  });

  it("keeps the skill marketplace open and makes repeated deletion harmless", () => {
    const state = fixture(); state.view = "skills";
    const next = withoutConversation(state, "conversation-a");
    expect(next.view).toBe("skills"); expect(withoutConversation(next, "conversation-a")).toBe(next);
  });
});
