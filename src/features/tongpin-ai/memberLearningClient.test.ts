import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AiMemoryRecallOverview, AiMemorySkill, AiMemorySkillsView } from "../../../shared/aiMemoryLearning";
import {
  currentMemberLearningSource, currentPersonalSkills, loadRecallDetail, memberLearningApi, parseSkillTriggers, recallDateLabel, refreshPersonalSkills,
  replyActivityLines, setMemberLearningSource, skillDraft, skillInput, skillUsageLabel,
} from "./memberLearningClient";
import { MemberRecallSection } from "./MemberRecallSection";
import { MemberSkillsSection } from "./MemberSkillsSection";
import { insertSkillMention, mentionedCapabilityRequest } from "./skillMentions";

const skill = (patch: Partial<AiMemorySkill> = {}): AiMemorySkill => ({
  id: "my-abc123", status: "adopted", name: "周报格式", whenToUse: "写每周工作汇报时", instructions: "1. 先写结论\n2. 列出完成事项", triggers: ["周报", "每周汇报"],
  origin: "review", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", useCount: 0, revision: 1, ...patch,
});

describe("history recall and personal skills (client)", () => {
  it("binds every call to the signed-in account", async () => {
    const api = vi.fn(async (path: string) => path.startsWith("/api/ai/memory/recalls/") ? { recall: null } : path === "/api/ai/memory/skills" ? { enabled: true, skills: [] } : {}) as never;
    const client = memberLearningApi(api, "member-a");
    await client.recall("request-000000000001");
    await client.skills();
    await client.updateSkill({ action: "dismiss", id: "my-abc123", expectedRevision: 1 });
    const calls = (api as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map(call => call[0])).toEqual(["/api/ai/memory/recalls/request-000000000001", "/api/ai/memory/skills", "/api/ai/memory/skills"]);
    for (const call of calls) expect((call[1] as RequestInit).headers).toEqual({ "X-Tongpin-Account": "member-a" });
    expect(JSON.parse((calls[2][1] as RequestInit).body as string)).toEqual({ action: "dismiss", id: "my-abc123", expectedRevision: 1 });
  });

  it("words the reply lines from counts and names only", () => {
    const base = { requestId: "request-000000000001", status: "none" as const };
    expect(replyActivityLines(base)).toEqual({ recall: null, skills: null, skillProposed: false });
    expect(replyActivityLines({ ...base, activity: { recalled: 3, trigger: "reference", skills: [] } }).recall).toBe("回忆：找到 3 段相关历史对话");
    expect(replyActivityLines({ ...base, activity: { recalled: 0, trigger: "explicit", skills: [] } }).recall).toBe("回忆：没有找到相关的历史对话");
    expect(replyActivityLines({ ...base, activity: { recalled: 0, skills: [{ id: "my-abc123", name: "周报格式", via: "auto" }, { id: "my-def456", name: "会议纪要", via: "mention" }] } }).skills).toBe("使用技能：周报格式、会议纪要");
    expect(replyActivityLines({ ...base, status: "applied", skillProposed: true }).skillProposed).toBe(true);
  });

  it("keeps personal skills and recall details per account, and forgets them on sign-out", async () => {
    const recall = vi.fn(async (requestId: string) => ({ requestId, conversationId: "c", at: "2026-09-27T00:00:00.000Z", trigger: "reference" as const, count: 1, snippets: [], skills: [] }));
    setMemberLearningSource({ accountId: "member-a", recall, skills: async () => ({ enabled: true, skills: [{ id: "my-abc123", name: "周报格式", whenToUse: "写周报时" }, { id: "bad-id", name: "x", whenToUse: "y" }] }) });
    await refreshPersonalSkills();
    expect(currentPersonalSkills()).toEqual([{ id: "my-abc123", name: "周报格式", whenToUse: "写周报时" }]);
    await loadRecallDetail("request-000000000001");
    await loadRecallDetail("request-000000000001");
    expect(recall).toHaveBeenCalledTimes(1);
    setMemberLearningSource({ accountId: "member-b", recall, skills: async () => ({ enabled: false, skills: [{ id: "my-zzz999", name: "别人的", whenToUse: "z" }] }) });
    await refreshPersonalSkills();
    expect(currentPersonalSkills()).toEqual([]);
    await loadRecallDetail("request-000000000001");
    expect(recall).toHaveBeenCalledTimes(2);
    setMemberLearningSource(null);
    expect(currentMemberLearningSource()).toBeNull();
    expect(await loadRecallDetail("request-000000000001")).toBeNull();
  });

  it("formats skill drafts, triggers, dates and usage", () => {
    expect(parseSkillTriggers("周报、每周汇报, weekly；周报")).toEqual(["周报", "每周汇报", "weekly"]);
    expect(skillInput(skillDraft(skill()))).toEqual({ name: "周报格式", whenToUse: "写每周工作汇报时", instructions: "1. 先写结论\n2. 列出完成事项", triggers: ["周报", "每周汇报"] });
    expect(recallDateLabel(null)).toBe("日期未知");
    expect(recallDateLabel("2019-03-04")).toBe("2019年3月4日");
    expect(skillUsageLabel(skill())).toBe("还没有用过");
    expect(skillUsageLabel(skill({ useCount: 3, lastUsedAt: "2019-03-04T01:00:00.000Z" }))).toBe("用过 3 次 · 最近 2019年3月4日");
    expect(skillUsageLabel(skill({ stale: true, useCount: 2 }))).toContain("可以考虑删除");
  });

  it("offers personal skills in the @ list without treating them as reviewed skills", () => {
    expect(insertSkillMention("帮我 @周", { start: 3, end: 5 }, "my-abc123").text).toBe("帮我 @my-abc123 ");
    expect(() => insertSkillMention("@", { start: 0, end: 1 }, "my-ABC")).toThrow("尚未接入");
    expect(mentionedCapabilityRequest("@my-abc123 写周报")).toEqual({ skillIds: [] });
    const chat = readFileSync(new URL("./ChatWorkspace.tsx", import.meta.url), "utf8");
    expect(chat).toContain("usePersonalSkillMentions()");
    expect(chat).toContain("· 我的技能");
  });

  it("renders proposals with 采纳 / 编辑 / 忽略 and adopted skills with their @ id and usage", () => {
    const view: AiMemorySkillsView = { enabled: true, items: [skill({ id: "my-pro123", status: "proposed", reason: "repeated", evidence: 3 }), skill({ stale: true, useCount: 1 })] };
    const html = renderToStaticMarkup(createElement(MemberSkillsSection, { skills: view, busy: false, onUpdate: async () => true }));
    for (const copy of ["AI 学到的技能", "待你确认 · 1", "你已提过 3 次类似的请求", "采纳", "编辑", "忽略", "@my-abc123", "可以考虑删除", "已采纳 1/12", "自己添加一个技能"]) expect(html).toContain(copy);
    const off = renderToStaticMarkup(createElement(MemberSkillsSection, { skills: { enabled: false, items: [] }, busy: false, onUpdate: async () => true }));
    expect(off).toContain("管理员未开启技能学习");
    expect(off).not.toContain("自己添加一个技能");
  });

  it("renders the recall overview and recent recalls", () => {
    const recall: AiMemoryRecallOverview = { enabled: true, indexedConversations: 12, indexedMessages: 80, pending: true, recent: [{
      requestId: "request-000000000001", conversationId: "c", at: "2026-09-27T02:00:00.000Z", trigger: "reference", count: 2, skills: [],
      snippets: [{ conversationTitle: "季度汇报", date: "2026-09-12", role: "assistant", excerpt: "季度汇报模板：一、完成情况" }],
    }] };
    const html = renderToStaticMarkup(createElement(MemberRecallSection, { recall }));
    for (const copy of ["历史回忆", "12 段对话可回忆", "正在整理你更早的对话", "找到 2 段", "《季度汇报》"]) expect(html).toContain(copy);
    expect(renderToStaticMarkup(createElement(MemberRecallSection, { recall: { ...recall, enabled: false, recent: [] } }))).toContain("管理员未开启历史回忆");
  });
});
