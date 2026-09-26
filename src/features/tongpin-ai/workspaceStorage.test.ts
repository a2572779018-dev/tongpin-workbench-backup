import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AI_WORKSPACE_LIMITS, type AiWorkspaceState } from "../../../shared/aiWorkspace";
import { WorkspaceStorageMeter, WorkspaceStorageRelief } from "./WorkspaceStorage";
import {
  conversationExportFilename,
  conversationExportJson,
  estimateWorkspaceStorage,
  formatWorkspaceMegabytes,
  isWorkspaceSpaceRejection,
  largestWorkspaceConversations,
  workspaceStorageFrom,
  workspaceStorageHint,
  workspaceStorageLabel,
  workspaceStorageLevel,
} from "./workspaceStorage";
import { WorkspaceSaveQueue } from "./workspaceSync";
import { ApiRequestError } from "../../lib/api";
import { AdminAiMemberWorkspaceStorage } from "./AdminAiQuotaPanel";

const MB = 1024 * 1024;
const LIMIT = AI_WORKSPACE_LIMITS.stateBytes;

function state(): AiWorkspaceState {
  return {
    view: "chat", mode: "deep", projects: [], enabledSkillIds: [], activeConversationId: "small", activeProjectId: null,
    conversations: [
      { id: "small", title: "短对话", timeLabel: "刚刚", messages: [{ id: "m1", role: "user", content: "你好", time: "10:00" }] },
      { id: "big", title: "带附件的长对话", timeLabel: "昨天", messages: [
        { id: "m2", role: "user", content: "看看这份文档", time: "10:00", attachments: [{ id: "a1", name: "报告.txt", mimeType: "text/plain", content: "字".repeat(20_000) }] },
        { id: "m3", role: "assistant", content: "好的", time: "10:01" },
      ] },
      { id: "artifact-heavy", title: "成果对话", timeLabel: "前天", messages: [{ id: "m4", role: "assistant", content: "见成果", time: "10:00", artifactId: "art" }] },
    ],
    artifacts: [{ id: "art", conversationId: "artifact-heavy", title: "方案", kind: "document", updatedLabel: "刚刚", summary: "", sections: [{ heading: "正文", lines: ["x".repeat(10_000)] }] }],
    drafts: { small: "草稿" },
    draftAttachments: {},
  };
}

describe("V1 workspace storage meter", () => {
  it("accepts only well-formed server usage and tolerates older servers", () => {
    expect(workspaceStorageFrom(undefined)).toBeNull();
    expect(workspaceStorageFrom({ usedBytes: "1", limitBytes: LIMIT })).toBeNull();
    expect(workspaceStorageFrom({ usedBytes: 1, limitBytes: 0 })).toBeNull();
    expect(workspaceStorageFrom({ usedBytes: Number.NaN, limitBytes: LIMIT })).toBeNull();
    expect(workspaceStorageFrom({ usedBytes: 10, limitBytes: LIMIT, extra: 1 })).toEqual({ usedBytes: 10, limitBytes: LIMIT });
  });
  it("labels in MB and switches level at 70% and 90%", () => {
    expect(workspaceStorageLabel({ usedBytes: 5.2 * MB, limitBytes: 8 * MB })).toBe("云端资料 5.2 / 8 MB");
    expect(formatWorkspaceMegabytes(0)).toBe("0");
    expect(formatWorkspaceMegabytes(100)).toBe("0.1");
    expect(workspaceStorageLevel({ usedBytes: LIMIT * 0.69, limitBytes: LIMIT })).toBe("normal");
    expect(workspaceStorageLevel({ usedBytes: LIMIT * 0.7, limitBytes: LIMIT })).toBe("warning");
    expect(workspaceStorageLevel({ usedBytes: LIMIT * 0.9, limitBytes: LIMIT })).toBe("critical");
    expect(workspaceStorageLevel({ usedBytes: LIMIT * 2, limitBytes: LIMIT })).toBe("critical");
  });
  it("renders a quiet meter normally and a plain-Chinese hint when filling up", () => {
    expect(renderToStaticMarkup(createElement(WorkspaceStorageMeter, { storage: null }))).toBe("");
    const normal = renderToStaticMarkup(createElement(WorkspaceStorageMeter, { storage: { usedBytes: MB, limitBytes: LIMIT } }));
    expect(normal).toContain("云端资料 1 / 8 MB"); expect(normal).not.toContain("tp-ai-storage-meter__hint");
    const warning = renderToStaticMarkup(createElement(WorkspaceStorageMeter, { storage: { usedBytes: 6 * MB, limitBytes: LIMIT } }));
    expect(warning).toContain("is-warning"); expect(warning).toContain("空间已用七成以上");
    const critical = renderToStaticMarkup(createElement(WorkspaceStorageMeter, { storage: { usedBytes: 7.5 * MB, limitBytes: LIMIT } }));
    expect(critical).toContain("is-critical"); expect(critical).toContain("空间快满了"); expect(critical).toContain('aria-valuenow="94"');
    // Generated images/videos are stored by reference only (assetId / videoJobId), so the hint must not blame them.
    for (const level of ["normal", "warning", "critical"] as const) expect(workspaceStorageHint(level)).toContain("AI 生成的图片和视频另外存放");
  });
  it("falls back to a local UTF-8 estimate against the same cap", () => {
    const value = state();
    expect(estimateWorkspaceStorage(value)).toEqual({ usedBytes: new TextEncoder().encode(JSON.stringify(value)).byteLength, limitBytes: LIMIT });
    expect(estimateWorkspaceStorage(null).usedBytes).toBe(0);
  });
});

describe("space rejection relief", () => {
  it("ranks conversations by approximate serialized size including their artifacts", () => {
    const largest = largestWorkspaceConversations(state(), 2);
    expect(largest.map(item => item.id)).toEqual(["big", "artifact-heavy"]);
    expect(largest[0]).toMatchObject({ title: "带附件的长对话", messageCount: 2, attachmentCount: 1 });
    expect(largest[0].bytes).toBeGreaterThan(60_000);
    expect(largest[1].bytes).toBeGreaterThan(10_000);
  });
  it("recognises only space rejections", () => {
    expect(isWorkspaceSpaceRejection("AI_WORKSPACE_TOO_LARGE")).toBe(true);
    expect(isWorkspaceSpaceRejection("PAYLOAD_TOO_LARGE")).toBe(true);
    expect(isWorkspaceSpaceRejection("AI_WORKSPACE_CONFLICT")).toBe(false);
    expect(isWorkspaceSpaceRejection(undefined)).toBe(false);
  });
  it("exports one conversation with its artifacts and a safe filename", () => {
    const parsed = JSON.parse(conversationExportJson(state(), "artifact-heavy")!);
    expect(parsed.conversation.id).toBe("artifact-heavy");
    expect(parsed.artifacts.map((item: { id: string }) => item.id)).toEqual(["art"]);
    expect(conversationExportJson(state(), "missing")).toBeNull();
    expect(conversationExportFilename("a/b:c?")).toBe("同频-AI-对话-a b c.json");
    expect(conversationExportFilename("   ")).toBe("同频-AI-对话-对话.json");
  });
  it("offers delete buttons that only call back (no automatic deletion)", () => {
    const items = largestWorkspaceConversations(state(), 3);
    const html = renderToStaticMarkup(createElement(WorkspaceStorageRelief, { items, onDelete() { throw Error("must not run on render"); }, onExportThenDelete() { throw Error("must not run on render"); } }));
    expect(html).toContain("带附件的长对话"); expect(html).toContain("导出后删除"); expect(html).toContain("删除前会再次确认");
    expect(renderToStaticMarkup(createElement(WorkspaceStorageRelief, { items: [], onDelete() {}, onExportThenDelete() {} }))).toBe("");
  });
  it("save queue reports the rejection code so the UI can show relief, then retries a smaller state", async () => {
    const events: Array<[string, string | undefined]> = [];
    let reject = true;
    let revision = 0;
    const queue = new WorkspaceSaveQueue({ revision: 0, schemaVersion: 1, updatedAt: null, state: null }, async body => {
      if (reject) throw new ApiRequestError(413, "AI_WORKSPACE_TOO_LARGE", "云端对话资料已达安全保存上限");
      revision += 1;
      return { revision: body.expectedRevision + 1, schemaVersion: 1, updatedAt: "now", state: body.state, storage: { usedBytes: 1, limitBytes: LIMIT } };
    }, (status, _message, code) => events.push([status, code]));
    expect(await queue.saveNow(state())).toBe(false);
    expect(events.at(-1)).toEqual(["error", "AI_WORKSPACE_TOO_LARGE"]);
    reject = false;
    const smaller = state(); smaller.conversations = smaller.conversations.filter(item => item.id !== "big");
    expect(await queue.saveNow(smaller)).toBe(true);
    expect(events.at(-1)).toEqual(["saved", undefined]);
    expect(revision).toBe(1);
  });
});

describe("admin per-member snapshot size", () => {
  it("shows size against the cap, flags full accounts and tolerates missing data", () => {
    expect(renderToStaticMarkup(createElement(AdminAiMemberWorkspaceStorage, {}))).toContain("—");
    const normal = renderToStaticMarkup(createElement(AdminAiMemberWorkspaceStorage, { storage: { usedBytes: 5.2 * MB, limitBytes: LIMIT } }));
    expect(normal).toContain("5.2 / 8 MB"); expect(normal).toContain("is-normal");
    expect(renderToStaticMarkup(createElement(AdminAiMemberWorkspaceStorage, { storage: { usedBytes: 7.4 * MB, limitBytes: LIMIT } }))).toContain("is-critical");
  });
});
