import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { AiChatPreflight } from "../../../shared/ai";
import { ChatPreflightGate, preflightNotice, sameSendContext, withPreparedChatSend } from "./chatPreflight";
import { hydrateWorkspace, serializeWorkspace } from "./workspaceState";

const budget = { inputReserve: 1800, searchInputReserve: 32768, convertedReserve: 100,
  minOutputTokens: 16, minimumRequiredTokens: 34684, availableOutputTokens: 0, maxOutputTokens: 2048 };
const result: AiChatPreflight = { canSend: false, reason: "search_quota_insufficient", budget,
  quota: { limitTokens: 10000, usedTokens: 0, reservedTokens: 0, remainingTokens: 10000, inputTokens: 0, outputTokens: 0 },
  withoutWebSearch: { canSend: true, reason: null, budget: { ...budget, searchInputReserve: 0, convertedReserve: 0, minimumRequiredTokens: 1816, availableOutputTokens: 2048 } },
};

describe("chat quota preflight feedback", () => {
  it("explains search reservation without claiming the 10,000 balance is empty", () => {
    const notice = preflightNotice(result);
    expect(notice.title).toContain("余额尚有");
    expect(notice.message).toContain("10,000");
    expect(notice.message).toContain("34,684");
    expect(notice.message).toContain("不是实际扣费");
    expect(notice.canDisableSearch).toBe(true);
  });
  it("does not offer ordinary chat when its budget is also insufficient", () => {
    expect(preflightNotice({ ...result, withoutWebSearch: { ...result.withoutWebSearch!, canSend: false } }).canDisableSearch).toBe(false);
    expect(preflightNotice({ ...result, reason: "quota_exhausted" }).canDisableSearch).toBe(false);
    expect(preflightNotice({ ...result, reason: "request_in_progress" }).title).toContain("正在处理");
  });
  it("invalidates a checked draft after navigation, edits, mode, tool or attachment changes", () => {
    const context = ["chat-a", "你好", [], "quick", "text", true, {}, {}, new Set(), 1, "chat", null];
    expect(sameSendContext(context, [...context])).toBe(true);
    for (let index = 0; index < context.length; index++) {
      const changed = [...context]; changed[index] = "changed";
      expect(sameSendContext(context, changed)).toBe(false);
    }
  });
  it("preflights before clearing drafts or persisting sent messages, without auto-disabling search", () => {
    const source = readFileSync(new URL("../../pages/TongpinAIPage.tsx", import.meta.url), "utf8");
    const send = source.slice(source.indexOf("async function sendMessage()"), source.indexOf("async function retryReply"));
    expect(send.indexOf('"/api/ai/preflight"')).toBeLessThan(send.indexOf("setDrafts(nextState.drafts)"));
    expect(send.indexOf('"/api/ai/preflight"')).toBeLessThan(send.indexOf("persistenceRef.current.saveNow"));
    expect(send).not.toContain("setWebSearch(false)");
    expect(send).toContain("preflightGate.isCurrent(ticket, sendContextRef.current)");
    expect(send).toContain("preflightGate.busy");
    expect(send).toContain("const latest = workspaceRef.current;");
    expect(send).toContain("persistenceRef.current.status");
    expect(send).not.toContain("...conversations.filter");
  });
});

describe("preflight send ownership", () => {
  it("locks synchronously against consecutive clicks before React rerenders", () => {
    const gate = new ChatPreflightGate();
    const ticket = gate.start(["chat-a", "草稿"]);
    expect(ticket).not.toBeNull();
    expect(gate.busy).toBe(true);
    expect(gate.start(["chat-a", "草稿"])).toBeNull();
  });

  it("releases an edited/navigated check without letting its finally unlock a later check", () => {
    const gate = new ChatPreflightGate();
    const original = ["chat-a", "草稿"];
    const edited = ["chat-b", "新草稿"];
    const old = gate.start(original)!;
    expect(gate.cancelIfChanged([...original])).toBe(false);
    expect(gate.cancelIfChanged(edited)).toBe(true);
    expect(old.controller.signal.aborted).toBe(true);
    const current = gate.start(edited)!;
    expect(gate.finish(old)).toBe(false);
    expect(gate.busy).toBe(true);
    expect(gate.isCurrent(old, original)).toBe(false);
    expect(gate.isCurrent(current, edited)).toBe(true);
    expect(gate.finish(current)).toBe(true);
    expect(gate.busy).toBe(false);
  });

  it("cannot save or send a late successful check after leaving AI", async () => {
    const gate = new ChatPreflightGate();
    const context = ["chat-a", "草稿"];
    const ticket = gate.start(context)!;
    let resolve!: () => void;
    const response = new Promise<void>(done => { resolve = done; });
    const saveAndSend = vi.fn();
    const task = response.then(() => { if (gate.isCurrent(ticket, context)) saveAndSend(); });
    gate.cancel();
    resolve(); await task;
    expect(saveAndSend).not.toHaveBeenCalled();
    expect(gate.busy).toBe(false);
  });

  it("merges with the latest workspace without resurrecting deleted conversations or discarding other drafts", () => {
    const latest = serializeWorkspace(hydrateWorkspace(null));
    latest.conversations = [{ id: "other", title: "检查期间重命名", timeLabel: "刚刚", messages: [] }];
    latest.projects = [{ id: "project", title: "检查期间新增项目", timeLabel: "刚刚" }];
    latest.drafts = { "new-conversation": "发送内容", other: "保留另外的草稿" };
    latest.draftAttachments = { "new-conversation": [], other: [{ id: "doc", name: "资料.txt", mimeType: "text/plain", content: "保留附件" }] };
    latest.sidebarCollapsed = true;
    const sent = { id: "sent", title: "发送内容", timeLabel: "刚刚", messages: [] };
    const next = withPreparedChatSend(latest, sent, "new-conversation");
    expect(next.conversations).toEqual([sent, latest.conversations[0]]);
    expect(next.projects).toBe(latest.projects);
    expect(next.drafts).toEqual({ "new-conversation": "", other: "保留另外的草稿" });
    expect(next.draftAttachments?.other).toBe(latest.draftAttachments.other);
    expect(next.sidebarCollapsed).toBe(true);
    expect(next.activeConversationId).toBe("sent");
    expect(latest.drafts["new-conversation"]).toBe("发送内容");
  });
});
