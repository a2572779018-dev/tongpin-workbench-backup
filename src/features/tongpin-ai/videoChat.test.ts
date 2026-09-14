import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isVideoGenerationRequest } from "./videoChat";
import { withPreparedChatSend } from "./chatPreflight";
import { validateAiWorkspaceState } from "../../../server/ai/workspace";
import { hydrateWorkspace, serializeWorkspace } from "./workspaceState";
import type { AiWorkspaceState } from "../../../shared/aiWorkspace";

describe("video conversations", () => {
  it.each(["生成视频", "帮我生成一个15秒视频", "请帮我制作一个产品短片", "做一个小猫视频", "Generate a video of a cat"])("offers inline confirmation for %s", text => {
    expect(isVideoGenerationRequest(text)).toBe(true);
  });
  it.each(["你好", "为什么不能生成视频", "不要生成视频", "如何生成视频？", "总结视频的内容", "这个视频不好看", "帮我生成一个视频脚本", "Create a video prompt"])("does not turn discussion into a paid request: %s", text => {
    expect(isVideoGenerationRequest(text)).toBe(false);
  });
  it("persists the video job as an artifact belonging to exactly one conversation", () => {
    const state: AiWorkspaceState = { view: "chat", mode: "quick", conversations: [], projects: [], artifacts: [{ id: "artifact-video", conversationId: "conversation-video", title: "生成的视频", kind: "视频", updatedLabel: "刚刚", summary: "测试", sections: [], data: { videoJobId: "a-valid-video-job-id" } }], drafts: { "new-conversation": "测试视频" }, enabledSkillIds: [], activeConversationId: null, activeProjectId: null };
    const next = withPreparedChatSend(state, { id: "conversation-video", title: "测试", timeLabel: "刚刚", messages: [{ id: "user-video", role: "user", content: "测试视频", time: "12:00" }, { id: "assistant-video", role: "assistant", content: "视频生成任务", time: "12:00", status: "ready", artifactId: "artifact-video" }] }, "new-conversation");
    expect(validateAiWorkspaceState(JSON.parse(JSON.stringify(next)))).toEqual(next);
    expect(serializeWorkspace(hydrateWorkspace(next))).toEqual(next);
    expect(next.artifacts[0].data?.videoJobId).toBe("a-valid-video-job-id");
    expect(next.conversations[0].messages[1].requestId).toBeUndefined();
    expect(() => validateAiWorkspaceState({ ...next, artifacts: [{ ...next.artifacts[0], conversationId: "another-conversation" }] })).toThrow();
  });
  it("keeps media retrieval read-only, authenticated and releases media on unmount", () => {
    const source = readFileSync(new URL("./AiVideoReply.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('method: "POST"');
    expect(source).toContain('"X-Tongpin-Account"');
    expect(source).toContain('api<{ job: AiVideoJob }>');
    expect(source).toContain('URL.revokeObjectURL');
    expect(source).toContain('IntersectionObserver');
    expect(source).toContain('controls playsInline');
    expect(source).toContain('controller.abort()');
  });
  it("saves the message before generation and does not open a video modal", () => {
    const page = readFileSync(new URL("../../pages/TongpinAIPage.tsx", import.meta.url), "utf8");
    const send = page.slice(page.indexOf("async function sendVideo"), page.indexOf("async function sendMessage"));
    expect(send.indexOf("saveNow(next)")).toBeLessThan(send.indexOf('api("/api/ai/videos"'));
    expect(send).toContain("if (!saved || pendingCancelledRef.current)");
    expect(send).toContain("if (importOnly) return true;");
    const workspace = readFileSync(new URL("./ChatWorkspace.tsx", import.meta.url), "utf8");
    expect(workspace).not.toContain("AiVideoPanel");
    expect(workspace).toContain("AiVideoComposer");
  });
});
