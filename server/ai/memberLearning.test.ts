import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatResponse, AiProviderInput } from "../../shared/ai";
import type { AiWorkspaceConversation, AiWorkspaceMessage, AiWorkspaceState } from "../../shared/aiWorkspace";
import { MEMBER_MEMORY_REVIEW_INSTRUCTIONS } from "./memberMemoryPrompt";
import { memberMemoryRuntime } from "./memberMemoryService";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";
import { tenantStorageKey } from "./tenant";
import { AiWorkspaceRepository } from "./workspace";
import { AiWorkspaceV2ShadowRepository } from "./workspaceV2Shadow";
import { AiWorkspaceV2Store } from "./workspaceV2Store";

/*
 * History recall and personal skills through the real service: workspace
 * saves feed the index, chat requests recall into the system prompt, the
 * background review proposes skills, the member adopts them.
 */

type Body = { model: string; messages: Array<{ role: string; content: string }>; max_completion_tokens?: number };
const provider: AiProviderInput = {
  name: "Fixture", baseUrl: "https://api.example.com/", apiKey: "fixture-provider-key-not-real", protocol: "chat_completions",
  quickModel: "quick-model", deepModel: "deep-model", maxOutputTokens: 2048, reasoningEffort: "", enabled: true,
};
const WEEKLY_SKILL = { action: "create", name: "周报格式", when_to_use: "成员要写每周工作汇报时", instructions: "1. 先写本周结论\n2. 列出完成事项和关键数据\n3. 写风险和下周计划", triggers: ["周报", "每周汇报"] };

const message = (id: string, role: "user" | "assistant", content: string, extra: Partial<AiWorkspaceMessage> = {}): AiWorkspaceMessage =>
  ({ id, role, content, time: "10:00", ...(role === "assistant" ? { status: "ready" as const } : {}), ...extra });
const conversation = (id: string, title: string, messages: AiWorkspaceMessage[]): AiWorkspaceConversation => ({ id, title, timeLabel: "刚刚", messages });
const workspaceState = (conversations: AiWorkspaceConversation[]): AiWorkspaceState => ({
  view: "chat", mode: "quick", conversations, projects: [], artifacts: [], drafts: {}, activeConversationId: null, activeProjectId: null, enabledSkillIds: [],
});
const REPORT = conversation("conv-report", "季度汇报", [
  message("m1", "user", "帮我做一个季度汇报模板，要有完成情况、问题和下季度计划"),
  message("m2", "assistant", "季度汇报模板：一、本季度完成情况；二、遇到的问题；三、下季度计划。每部分先写结论再列数据。"),
]);

describe("member history recall and personal skills (service)", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  let workspace: AiWorkspaceRepository;
  let chatBodies: Body[] = [];
  let reviewBodies: Body[] = [];
  let reviewer: (body: Body) => Response;
  const revisions = new Map<string, number>();
  const transport = vi.fn<AiTransport>(async (_url, init) => {
    const body = JSON.parse(init.body!) as Body;
    if (body.messages?.[0]?.content === MEMBER_MEMORY_REVIEW_INSTRUCTIONS) { reviewBodies.push(body); return reviewer(body); }
    chatBodies.push(body);
    return Response.json({ choices: [{ message: { content: "好的，这是整理好的内容。" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  });
  const review = (value: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 } });
  const memory = () => runtime.service.memberMemory;
  const send = (content: string, conversationId: string, member = "member-a"): Promise<AiChatResponse> =>
    runtime.service.chat(member, { requestId: crypto.randomUUID(), mode: "quick", conversationId, messages: [{ role: "user", content }] });
  const systemPrompt = () => chatBodies.at(-1)!.messages[0].content;
  const payload = (index = -1) => JSON.parse(reviewBodies.at(index)!.messages[1].content) as Record<string, unknown>;
  const status = (requestId: string, member = "member-a") => memory().reviewStatuses(member, [requestId])[0];
  const save = async (conversations: AiWorkspaceConversation[], member = "member-a") => {
    const expectedRevision = revisions.get(member) ?? 0;
    const snapshot = await workspace.save(member, { expectedRevision, mutationId: crypto.randomUUID(), state: workspaceState(conversations) });
    revisions.set(member, snapshot.revision);
  };
  const settings = (patch: Record<string, unknown> = {}) => memory().saveAdminSettings({ enabled: true, reviewTier: "quick", pricePoints: 50, ...patch });

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-learning-"));
    chatBodies = []; reviewBodies = []; revisions.clear();
    reviewer = () => review({ operations: [], skill: null });
    transport.mockClear();
    memberMemoryRuntime.startImmediately = true;
    runtime = await createNodeAi(path.join(directory, "db.json"), transport, () => true);
    workspace = new AiWorkspaceRepository(runtime.store.sql);
    workspace.initialize();
    await runtime.service.saveProvider(provider);
    for (const member of ["member-a", "member-b"]) runtime.service.setQuota(member, "admin", { limitTokens: 100_000 });
    settings();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await memberMemoryRuntime.idle();
    runtime.close();
    await rm(directory, { recursive: true });
  });

  it("recalls the member's own earlier conversation into a new one, shows it on the reply, and never across members", async () => {
    await save([REPORT]);
    const reply = await send("上次那个汇报模板再发我看看", "conv-new");
    const prompt = systemPrompt();
    expect(prompt).toMatch(/<member_history id="[0-9a-f]{8}">/);
    expect(prompt).toContain("《季度汇报》");
    expect(prompt).toContain("季度汇报模板：一、本季度完成情况");
    await memberMemoryRuntime.idle();
    expect(status(reply.requestId).activity).toEqual({ recalled: 2, trigger: "reference", skills: [] });
    const detail = memory().recallDetail("member-a", reply.requestId)!;
    expect(detail.snippets.map(snippet => snippet.conversationTitle)).toEqual(["季度汇报", "季度汇报"]);
    expect(memory().state("member-a").recall).toMatchObject({ enabled: true, indexedConversations: 1, indexedMessages: 2, pending: false, recent: [{ requestId: reply.requestId, count: 2 }] });
    // Another member of the organization: no index, no excerpt, no detail.
    await send("上次那个汇报模板再发我看看", "conv-b", "member-b");
    expect(systemPrompt()).not.toContain("member_history");
    expect(memory().recallDetail("member-b", reply.requestId)).toBeNull();
    expect(status(reply.requestId, "member-b")).toEqual({ requestId: reply.requestId, status: "none" });
    // Another organization cannot reach the account at all.
    expect(() => runtime.service.forTenant("org-2").memberMemory.recallDetail("member-a", reply.requestId)).toThrow(expect.objectContaining({ code: "AI_ACCESS_NOT_GRANTED" }));
    // Deleting the source conversation removes it from recall and from the recall log.
    await save([]);
    expect(memory().recallDetail("member-a", reply.requestId)).toBeNull();
    await send("上次那个汇报模板再发我看看", "conv-new");
    expect(systemPrompt()).not.toContain("member_history");
  });

  it("recalls nothing for ordinary messages or from the current conversation; an explicit search admits it found nothing", async () => {
    await save([REPORT]);
    await send("帮我写一封感谢邮件", "conv-new");
    expect(systemPrompt()).not.toContain("历史对话");
    await send("上次那个汇报模板", "conv-report");
    expect(systemPrompt()).not.toContain("member_history");
    const explicit = await send("查一下我之前问过的年会抽奖名单", "conv-new");
    expect(systemPrompt()).toContain("没有找到与“年会抽奖名单”相关的内容");
    await memberMemoryRuntime.idle();
    expect(status(explicit.requestId).activity).toEqual({ recalled: 0, trigger: "explicit", skills: [] });
  });

  it("follows the administrator switches and the member's opt-out, and rebuilds when re-enabled", async () => {
    await save([REPORT]);
    settings({ recallEnabled: false });
    await send("上次那个汇报模板再发我看看", "conv-new");
    expect(systemPrompt()).not.toContain("member_history");
    expect(memory().state("member-a").recall).toMatchObject({ enabled: false, indexedMessages: 0 });
    // Rows are deleted in the background.
    await runtime.service.runBackgroundMemoryCycle();
    expect(runtime.store.sql.all<{ count: number }>("SELECT COUNT(*) AS count FROM ai_member_history_chunks")[0].count).toBe(0);
    settings({ recallEnabled: true });
    expect((await runtime.service.runBackgroundMemoryCycle()).history).toMatchObject({ synced: 1 });
    await send("上次那个汇报模板再发我看看", "conv-new-2");
    expect(systemPrompt()).toContain("季度汇报模板");
    // Member opt-out: no recall, index dropped; opting in again re-indexes.
    memory().setLearning("member-a", { learningEnabled: false });
    await send("上次那个汇报模板再发我看看", "conv-new-3");
    expect(systemPrompt()).not.toContain("member_history");
    memory().setLearning("member-a", { learningEnabled: true });
    await runtime.service.runBackgroundMemoryCycle();
    await send("上次那个汇报模板再发我看看", "conv-new-4");
    expect(systemPrompt()).toContain("季度汇报模板");
  });

  it("clear-all forgets existing history but indexes what comes after", async () => {
    await save([REPORT]);
    memory().clear("member-a");
    await send("上次那个汇报模板再发我看看", "conv-new");
    expect(systemPrompt()).not.toContain("member_history");
    await save([conversation("conv-plan", "季度汇报新版", [message("p1", "user", "新的季度汇报模板要加上预算和人力两部分")]), REPORT]);
    await send("上次那个汇报模板再发我看看", "conv-new");
    const prompt = systemPrompt();
    expect(prompt).toContain("预算和人力");
    expect(prompt).not.toContain("每部分先写结论再列数据");
  });

  it("backfills older conversations in bounded background batches", async () => {
    memory().saveAdminSettings({ enabled: false, reviewTier: "quick", pricePoints: 50 });
    const many = Array.from({ length: 30 }, (_, number) => conversation(`conv-${number}`, `项目 ${number}`, [
      message(`q${number}a`, "user", `第 ${number} 个项目的季度汇报模板怎么写`), message(`a${number}a`, "assistant", `第 ${number} 个项目的季度汇报模板：结论、数据、风险。`),
      message(`q${number}b`, "user", `第 ${number} 个项目还要补充预算`), message(`a${number}b`, "assistant", `预算部分按季度列出。`),
    ]));
    await save(many);
    expect(runtime.store.sql.all<{ count: number }>("SELECT COUNT(*) AS count FROM ai_member_history_chunks")[0].count).toBe(0);
    settings();
    let ticks = 0;
    while (memory().state("member-a").recall!.pending && ticks < 10) { await runtime.service.runBackgroundMemoryCycle(); ticks += 1; }
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(memory().state("member-a").recall).toMatchObject({ indexedConversations: 30, indexedMessages: 120, pending: false });
    // Saves stay incremental afterwards: one new message, one new chunk.
    const before = runtime.store.sql.all<{ count: number }>("SELECT COUNT(*) AS count FROM ai_member_history_chunks")[0].count;
    await save([conversation("conv-30", "项目 30", [message("q30", "user", "新项目的季度汇报模板")]), ...many]);
    expect(runtime.store.sql.all<{ count: number }>("SELECT COUNT(*) AS count FROM ai_member_history_chunks")[0].count).toBe(before + 1);
  });

  it("indexes V2 appends and renames for an activated account", async () => {
    await save([REPORT]);
    const shadow = new AiWorkspaceV2ShadowRepository(runtime.store.sql, workspace);
    const v2 = new AiWorkspaceV2Store(runtime.store.sql, workspace);
    v2.initialize();
    await shadow.stageFromV1("member-a");
    const prepared = (await v2.prepareFromShadow("member-a"))!;
    const stored = tenantStorageKey("default", "member-a");
    runtime.store.sql.exec("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id=? AND user_id=?", new Date().toISOString(), "default", stored);
    runtime.store.sql.exec("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id=? AND user_id=?", "default", stored);
    const conversationRevision = (await v2.readActiveEntity("member-a", "conversation", "conv-report"))!.revision;
    await v2.appendActiveMessages("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), conversationId: "conv-report", expectedRevision: conversationRevision,
      messages: [message("v1", "user", "季度汇报模板再加一个客户反馈部分")] });
    await send("上次那个汇报模板再发我看看", "conv-new");
    expect(systemPrompt()).toContain("客户反馈部分");
    await v2.renameActiveConversation("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), conversationId: "conv-report", expectedRevision: conversationRevision + 1, title: "季度汇报（V2）" });
    await send("上次那个汇报模板再发我看看", "conv-new-2");
    expect(systemPrompt()).toContain("《季度汇报（V2）》");
    // The V2 backfill path finishes the member without re-indexing what it has.
    runtime.store.sql.exec("INSERT OR REPLACE INTO ai_member_history_queue(tenant_id,user_id,reason,due_at,attempts) VALUES('default',?,'reconcile',0,0)", stored);
    await runtime.service.runBackgroundMemoryCycle();
    expect(memory().state("member-a").recall).toMatchObject({ indexedMessages: 3, pending: false });
  });

  it("proposes a skill after repeated requests, bills it like a memory update, and applies it once adopted", async () => {
    await save([
      conversation("conv-w1", "第 37 周周报", [message("w1", "user", "帮我写本周周报，先写结论再列完成事项和数据")]),
      conversation("conv-w2", "第 38 周周报", [message("w2", "user", "帮我写本周周报，先写结论再列完成事项和风险")]),
    ]);
    reviewer = body => {
      const evaluation = (JSON.parse(body.messages[1].content) as { 技能评估: unknown }).技能评估;
      return review(typeof evaluation === "object" ? { operations: [], skill: WEEKLY_SKILL } : { operations: [], skill: null });
    };
    const third = await send("帮我写本周周报，先写结论再列完成事项和下周计划", "conv-w3");
    await memberMemoryRuntime.idle();
    expect(payload()).toMatchObject({ 技能评估: { 原因: expect.stringContaining("共 3 次"), 相似的历史请求: expect.arrayContaining([expect.stringContaining("本周周报")]) } });
    expect(reviewBodies.at(-1)!.max_completion_tokens).toBe(1536);
    expect(status(third.requestId)).toMatchObject({ status: "applied", changes: { added: 0, updated: 0, removed: 0 }, skillProposed: true });
    expect(runtime.service.quota("member-a")).toMatchObject({ usedTokens: 65, reservedTokens: 0 });
    const [proposed] = memory().state("member-a").skills!.items;
    expect(proposed).toMatchObject({ status: "proposed", name: "周报格式", reason: "repeated", evidence: 3 });
    // Nothing applies before adoption.
    await send("帮我写这周的周报", "conv-w4");
    expect(systemPrompt()).not.toContain("member_skills");
    const adopted = memory().updateSkill("member-a", { action: "adopt", id: proposed.id, expectedRevision: proposed.revision });
    expect(adopted.skills!.items[0]).toMatchObject({ status: "adopted" });
    expect(memory().personalSkills("member-a")).toEqual({ enabled: true, skills: [{ id: proposed.id, name: "周报格式", whenToUse: "成员要写每周工作汇报时" }] });
    const used = await send("帮我写这周的周报", "conv-w5");
    expect(systemPrompt()).toContain(`技能「周报格式」（@${proposed.id}）`);
    expect(systemPrompt()).toContain("<member_skills id=");
    await memberMemoryRuntime.idle();
    expect(status(used.requestId).activity?.skills).toEqual([{ id: proposed.id, name: "周报格式", via: "auto" }]);
    expect(memory().state("member-a").skills!.items[0]).toMatchObject({ useCount: 1 });
    // Learning off: no automatic use, but an explicit @ mention still applies.
    memory().setLearning("member-a", { learningEnabled: false });
    await send("帮我写这周的周报", "conv-w6");
    expect(systemPrompt()).not.toContain("member_skills");
    await send(`@${proposed.id} 整理一下这周的工作`, "conv-w7");
    expect(systemPrompt()).toContain("<member_skills id=");
    expect(systemPrompt()).not.toContain("<member_memory");
    // Skills switched off by the administrator: not applied; adoption refused, deletion allowed.
    memory().setLearning("member-a", { learningEnabled: true });
    settings({ skillsEnabled: false });
    await send(`@${proposed.id} 整理一下这周的工作`, "conv-w8");
    expect(systemPrompt()).not.toContain("member_skills");
    expect(memory().personalSkills("member-a")).toEqual({ enabled: false, skills: [] });
    const current = memory().state("member-a").skills!.items[0];
    expect(() => memory().updateSkill("member-a", { action: "update", id: current.id, expectedRevision: current.revision, skill: { name: "周报", whenToUse: "写周报时", instructions: "按固定格式写周报内容。", triggers: ["周报"] } }))
      .toThrow(expect.objectContaining({ status: 403, code: "AI_MEMORY_SKILLS_DISABLED" }));
    expect(memory().updateSkill("member-a", { action: "delete", id: current.id, expectedRevision: current.revision }).skills!.items).toEqual([]);
  });

  it("gives the reviewer related history to avoid duplicates, and skips skill evaluation for ordinary turns", async () => {
    await save([REPORT]);
    await send("记住：季度汇报要按完成情况、问题、下季度计划三部分写", "conv-new");
    await memberMemoryRuntime.idle();
    expect(payload()).toMatchObject({ 相关历史对话: expect.arrayContaining([expect.objectContaining({ 对话: "季度汇报" })]), 技能评估: "本轮不需要评估技能，skill 输出 null" });
    expect(reviewBodies.at(-1)!.max_completion_tokens).toBe(1024);
    // A proposal without an evaluation request is ignored and not billed.
    reviewer = () => review({ operations: [], skill: WEEKLY_SKILL });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const later = await send("帮我整理一下下季度的重点工作安排和负责人", "conv-new");
    await memberMemoryRuntime.idle();
    expect(status(later.requestId)).toMatchObject({ status: "unchanged" });
    expect(memory().state("member-a").skills!.items).toEqual([]);
  });
});
