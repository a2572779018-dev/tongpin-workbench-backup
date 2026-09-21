import { describe, expect, it } from "vitest";
import type { AiWorkspaceDocument } from "../../../shared/aiWorkspace";
import { ToolPlanRequestGate, toolPlanClientContextKey, type ToolPlanClientContext } from "./toolPlanState";

const document = (id: string, content = id): AiWorkspaceDocument => ({ id, name: `${id}.txt`, mimeType: "text/plain", content });
const base = (extra: Partial<ToolPlanClientContext> = {}): ToolPlanClientContext => ({
  conversationId: "conversation-a",
  projectId: "project-a",
  projectContext: "项目说明",
  projectDocuments: [document("project-document")],
  currentAttachments: [document("current-document")],
  messages: [{ id: "message-a", role: "user", content: "历史问题", attachments: [document("history-document")] }],
  draft: "生成一份产品介绍 PPT",
  composerTool: "presentation",
  mode: "quick",
  enabledSkillIds: ["slide-maker"],
  ...extra,
});

describe("tool plan client context gate", () => {
  it("invalidates for draft, current/history/project attachment, conversation and project changes", () => {
    const original = toolPlanClientContextKey(base());
    for (const changed of [
      base({ draft: "生成一份公司介绍 PPT" }),
      base({ currentAttachments: [] }),
      base({ currentAttachments: [document("current-document", "同长度新内容")] }),
      base({ messages: [{ id: "message-a", role: "user", content: "历史问题", attachments: [] }] }),
      base({ messages: [{ id: "message-a", role: "user", content: "改过的历史问题", attachments: [document("history-document")] }] }),
      base({ projectDocuments: [document("other-project-document")] }),
      base({ conversationId: "conversation-b" }),
      base({ projectId: "project-b" }),
      base({ projectContext: "新项目说明" }),
    ]) expect(toolPlanClientContextKey(changed)).not.toBe(original);
  });

  it("drops a delayed plan result after context changes and accepts only the latest generation", async () => {
    const gate = new ToolPlanRequestGate();
    let currentKey = toolPlanClientContextKey(base());
    gate.syncContext(currentKey);
    const first = gate.start(currentKey);
    let resolveFirst!: (value: string) => void;
    const delayed = new Promise<string>(resolve => { resolveFirst = resolve; });
    const committed: string[] = [];
    const firstCommit = delayed.then(value => {
      if (gate.isCurrent(first, currentKey)) committed.push(value);
    });

    currentKey = toolPlanClientContextKey(base({ conversationId: "conversation-b" }));
    gate.syncContext(currentKey);
    const second = gate.start(currentKey);
    resolveFirst("stale plan");
    await firstCommit;
    expect(committed).toEqual([]);

    if (gate.isCurrent(second, currentKey)) committed.push("latest plan");
    expect(committed).toEqual(["latest plan"]);
  });
});
