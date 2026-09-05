import { describe, expect, it } from "vitest";
import {
  loadWorkspaceSession,
  moveConversationToProject,
  saveWorkspaceSession,
  submitUnavailableMessage,
} from "./workspaceState";
import type { TongpinAIConversation } from "./types";

const input = {
  conversations: [],
  activeConversationId: null,
  content: "请整理客户提案",
  conversationId: "created",
  userMessageId: "user-turn",
  responseMessageId: "response",
  time: "12:00",
};

describe("account-scoped workspace memory", () => {
  it("starts with empty data and preserves drafts and projects across navigation only for the same account", () => {
    const initial = loadWorkspaceSession("member-a");
    expect(initial.conversations).toEqual([]);
    expect(initial.projects).toEqual([]);
    expect(initial.artifacts).toEqual([]);
    const saved = {
      ...initial,
      drafts: { "chat-a": "尚未发送的内容" },
      projects: [{ id: "project-a", title: "我的项目", timeLabel: "今天" }],
    };
    saveWorkspaceSession("member-a", saved);
    expect(loadWorkspaceSession("member-a")).toBe(saved);
    expect(loadWorkspaceSession("member-b").drafts).toEqual({});
    expect(loadWorkspaceSession("member-b").projects).toEqual([]);
  });
});

describe("AI service unavailable", () => {
  it("allows a first message to create an empty-workspace conversation and reports the connection failure", () => {
    const result = submitUnavailableMessage(input);
    expect(result?.conversationId).toBe("created");
    expect(result?.conversations).toHaveLength(1);
    expect(result?.conversations[0].messages).toEqual([
      expect.objectContaining({ role: "user", content: "请整理客户提案" }),
      expect.objectContaining({
        role: "assistant",
        status: "error",
        content: expect.stringContaining("AI 服务尚未连接"),
      }),
    ]);
    expect(
      result?.conversations[0].messages.every((message) => !message.artifactId),
    ).toBe(true);
  });

  it("keeps earlier turns, title and project ownership when a send cannot reach the service", () => {
    const conversations: TongpinAIConversation[] = [
      { id: "other", title: "其他对话", timeLabel: "昨天", messages: [] },
      {
        id: "active",
        title: "用户起的名称",
        projectId: "project",
        timeLabel: "昨天",
        messages: [
          { id: "previous", role: "user", content: "上一条", time: "11:00" },
        ],
      },
    ];
    const result = submitUnavailableMessage({
      ...input,
      conversations,
      activeConversationId: "active",
    });
    expect(result?.conversationId).toBe("active");
    expect(result?.conversations[0]).toMatchObject({
      title: "用户起的名称",
      projectId: "project",
    });
    expect(
      result?.conversations[0].messages.map((message) => message.id),
    ).toEqual(["previous", "user-turn", "response"]);
    expect(result?.conversations[1]).toBe(conversations[0]);
    expect(conversations[1].messages).toHaveLength(1);
  });

  it("does not create conversations or messages for a whitespace-only send", () => {
    expect(
      submitUnavailableMessage({ ...input, content: "  \n  " }),
    ).toBeNull();
  });
});

describe("moving conversations", () => {
  const conversations: TongpinAIConversation[] = [
    {
      id: "active",
      title: "保留我",
      projectId: "from",
      timeLabel: "昨天",
      messages: [
        { id: "message", role: "user", content: "保留内容", time: "11:00" },
      ],
    },
  ];
  it("moves a conversation between project and general history without duplicating it or dropping its messages", () => {
    const moved = moveConversationToProject(
      conversations,
      [{ id: "to", title: "目标项目", timeLabel: "今天" }],
      "active",
      "to",
    );
    expect(moved).toHaveLength(1);
    expect(moved[0].projectId).toBe("to");
    expect(moved[0].messages).toBe(conversations[0].messages);
    const detached = moveConversationToProject(moved, [], "active");
    expect(detached[0].projectId).toBeUndefined();
    expect(detached[0].messages).toBe(conversations[0].messages);
  });
  it("does not orphan a conversation under an unknown project", () => {
    expect(
      moveConversationToProject(conversations, [], "active", "missing"),
    ).toBe(conversations);
  });
});
