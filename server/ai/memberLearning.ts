import type { AiChatRequest, AiChatResponse } from "../../shared/ai";
import type { AiMemoryAdminSettings } from "../../shared/aiMemory";
import { AI_MEMORY_SKILL_LIMITS, type AiMemoryRecallOverview, type AiMemorySkillsView } from "../../shared/aiMemoryLearning";
import { AiMemberHistoryIndex, historySourceFromConversation, historySourceFromState, MEMBER_HISTORY_LIMITS, memberHistoryEligible } from "./memberHistoryIndex";
import { AiMemberActivityLog, recallMemberHistory, renderMemberRecallPrompt, selectRecallSnippets, type MemberRecall } from "./memberHistoryRecall";
import { historyExcerpt, historyQuery, scoreHistoryText } from "./memberHistoryText";
import { memberMemoryNonce } from "./memberMemoryPrompt";
import { parseMemoryAdminSettings } from "./memberMemoryStore";
import { AiMemberSkillRepository, matchMemberSkills, renderMemberSkillsPrompt, type AppliedMemberSkill } from "./memberSkills";
import type { AiSql } from "./storage";
import { normalizeAiTenantId, tenantStorageKey } from "./tenant";
import { hasAiWorkspaceWriteObserver, setAiWorkspaceWriteObserver } from "./workspaceWriteHooks";

/*
 * Glue between member memory and the two Hermes-derived additions: history
 * recall (answer time) and personal skills (answer time + background review).
 * Everything here fails closed to "no recall / no skill": a learning feature
 * never fails a reply or a workspace save.
 */

/** The member's own words this turn; a "continue" retry recalls for the original question. */
export function memberTurnText(request: Pick<AiChatRequest, "messages" | "retryMode">): string {
  const users = request.messages.filter(message => message.role === "user");
  return (request.retryMode === "continue" ? users.at(-2) : users.at(-1))?.content ?? "";
}

/** Recall and skills shape ordinary answers only (not tool plans, PPT JSON or protocol turns). */
function ordinaryRequest(request: AiChatRequest): boolean {
  return (!request.outputFormat || request.outputFormat === "text" || request.outputFormat === "dispatch") && !request.skillIds?.includes("agent-continuation-v1");
}

type PendingActivity = { tenantId: string; conversationId: string; recall: MemberRecall | null; skills: AppliedMemberSkill[]; at: number };
/** Prepared at request time, persisted only once the reply succeeded (afterReply). */
const pending = new Map<string, PendingActivity>();
const PENDING_TTL_MS = 15 * 60_000;
const PENDING_MAX = 256;
function pendingKey(tenantId: string, userId: string, requestId: string): string { return `${tenantId}\u0000${userId}\u0000${requestId}`; }
function stash(key: string, value: PendingActivity): void {
  const now = Date.now();
  for (const [entry, item] of pending) if (now - item.at > PENDING_TTL_MS || pending.size >= PENDING_MAX) pending.delete(entry); else break;
  pending.set(key, value);
}

export interface MemberSkillEvaluation {
  reason: "repeated" | "multi_step" | "explicit";
  evidence: number;
  examples: string[];
  existing: Array<{ id: string; name: string; whenToUse: string; triggers: string[] }>;
}
export interface MemberReviewContext {
  history: Array<{ 对话: string; 日期: string; 发言方: string; 摘录: string }>;
  skills: MemberSkillEvaluation | null;
}

const FORMAT_WORDS = /格式|模板|步骤|流程|结构|样式|写法|规范|顺序|框架|每次|都按|都用|固定/;

/** Tenant-scoped learning facade used by the member-memory service. */
export class AiMemberLearning {
  readonly tenantId: string;
  readonly history: AiMemberHistoryIndex;
  readonly skills: AiMemberSkillRepository;
  readonly activity: AiMemberActivityLog;
  constructor(readonly sql: AiSql, tenantId: string) {
    this.tenantId = normalizeAiTenantId(tenantId);
    this.history = new AiMemberHistoryIndex(sql, this.tenantId);
    this.skills = new AiMemberSkillRepository(sql, this.tenantId);
    this.activity = new AiMemberActivityLog(sql, this.tenantId);
  }

  /**
   * The recall + skill prompt section for this request ("" when neither
   * applies). With `capture`, what was used is kept for afterReply.
   */
  prepare(userId: string, request: AiChatRequest, context: { settings: AiMemoryAdminSettings; learningEnabled: boolean; memoryText: string; capture: boolean }): string {
    if (!context.settings.enabled || !ordinaryRequest(request)) return "";
    const message = memberTurnText(request);
    if (!message.trim()) return "";
    let recall: MemberRecall | null = null;
    if (context.settings.recallEnabled && context.learningEnabled) {
      try { recall = recallMemberHistory(this.history, userId, { message, ...(request.conversationId ? { conversationId: request.conversationId } : {}), memoryText: context.memoryText }); }
      catch { recall = null; }
    }
    let applied: AppliedMemberSkill[] = [];
    if (context.settings.skillsEnabled) {
      // An explicit @my-… mention is the member's own choice; automatic use needs learning on.
      try { applied = matchMemberSkills(message, this.skills.adopted(userId), { auto: context.learningEnabled }); }
      catch { applied = []; }
    }
    const nonce = memberMemoryNonce(this.tenantId, userId, request.requestId, "learning");
    const block = [renderMemberSkillsPrompt(applied, nonce), recall ? renderMemberRecallPrompt(recall, nonce) : ""].filter(Boolean).join("\n\n");
    if (context.capture && (recall || applied.length)) {
      stash(pendingKey(this.tenantId, userId, request.requestId), { tenantId: this.tenantId, conversationId: request.conversationId ?? "legacy", recall, skills: applied, at: Date.now() });
    }
    return block;
  }

  /** The reply succeeded: record what it used and count skill uses. Never throws. */
  commit(userId: string, requestId: string, _response?: Pick<AiChatResponse, "content">): void {
    const key = pendingKey(this.tenantId, userId, requestId);
    const item = pending.get(key);
    if (!item) return;
    pending.delete(key);
    try {
      this.sql.transaction(() => {
        this.activity.record(userId, { requestId, conversationId: item.conversationId, recall: item.recall, skills: item.skills.map(({ skill, via }) => ({ id: skill.id, name: skill.name, via })) });
        this.skills.recordUse(userId, item.skills.map(({ skill }) => skill.id));
      });
    } catch { /* Activity is informational. */ }
  }

  /**
   * Extra data for the background review: related excerpts from other
   * conversations (avoid duplicate or contradicting memory) and, when this
   * turn looks like a reusable way of working, a skill evaluation request.
   */
  reviewContext(userId: string, input: { settings: AiMemoryAdminSettings; memberText: string; conversationId: string; cue: "none" | "remember" | "forget"; reply: string; result?: Pick<AiChatResponse, "sources" | "usage"> }): MemberReviewContext {
    const context: MemberReviewContext = { history: [], skills: null };
    const query = historyQuery(input.memberText);
    if (input.settings.recallEnabled && query.units.length) {
      try {
        const snippets = selectRecallSnippets(this.history, userId, query, this.history.candidates(userId, query, { excludeConversationId: input.conversationId }), "reference").slice(0, 2);
        let budget = 500;
        for (const snippet of snippets) {
          const excerpt = Array.from(snippet.excerpt).slice(0, Math.max(0, budget)).join("");
          if (Array.from(excerpt).length < 40) break;
          budget -= Array.from(excerpt).length;
          context.history.push({ 对话: snippet.conversationTitle, 日期: snippet.date ?? "日期未知", 发言方: snippet.role === "user" ? "成员" : "同频 AI（不是成员陈述）", 摘录: excerpt });
        }
      } catch { context.history = []; }
    }
    if (!input.settings.skillsEnabled || !this.skills.canPropose(userId)) return context;
    // Repetition: the same kind of request in other conversations (member turns only).
    let evidence = 0;
    const examples: string[] = [];
    if (query.units.length) {
      try {
        const conversations = new Set<string>();
        const ranked = this.history.candidates(userId, query, { excludeConversationId: input.conversationId, roles: ["user"] })
          .map(candidate => ({ candidate, score: scoreHistoryText(query, candidate.body) }))
          .filter(item => item.score.coverage >= 0.6 && item.score.longest >= 2)
          .sort((a, b) => b.score.score - a.score.score);
        for (const { candidate, score } of ranked) {
          if (conversations.has(candidate.conversationId)) continue;
          conversations.add(candidate.conversationId);
          if (examples.length < 3) examples.push(historyExcerpt(candidate.body, score.anchor, 160));
        }
        evidence = conversations.size;
      } catch { evidence = 0; }
    }
    const listLines = input.reply.split("\n").filter(line => /^\s*(?:[-*+]|\d+[.)、]|#{1,6}\s)/.test(line)).length;
    const multiStep = Array.from(input.reply).length >= 1200 || listLines >= 5 || Boolean(input.result?.sources?.length) || Boolean(input.result?.usage?.searchCalls) || Boolean(input.result?.usage?.execCalls);
    const explicit = input.cue === "remember" && FORMAT_WORDS.test(input.memberText);
    const reason = evidence >= 2 ? "repeated" : explicit ? "explicit" : multiStep ? "multi_step" : null;
    if (!reason) return context;
    const existing = this.skills.list(userId).slice(0, AI_MEMORY_SKILL_LIMITS.adopted + AI_MEMORY_SKILL_LIMITS.proposed)
      .map(skill => ({ id: skill.id, name: skill.name, whenToUse: skill.whenToUse, triggers: skill.triggers }));
    context.skills = { reason, evidence: evidence + 1, examples, existing };
    return context;
  }

  /** "AI 对你的了解": index status, recent recalls and skills. */
  view(userId: string, settings: AiMemoryAdminSettings): { recall: AiMemoryRecallOverview; skills: AiMemorySkillsView } {
    const recallEnabled = settings.enabled && settings.recallEnabled;
    const overview = this.history.overview(userId);
    return {
      recall: { enabled: recallEnabled, indexedConversations: overview.indexedConversations, indexedMessages: overview.indexedMessages, pending: recallEnabled && overview.pending, recent: this.activity.recentRecalls(userId) },
      skills: { enabled: settings.enabled && settings.skillsEnabled, items: this.skills.list(userId) },
    };
  }
}

// ---------------------------------------------------------------------------
// Workspace write observer (index on each V1 save / V2 write)
// ---------------------------------------------------------------------------

/**
 * Registered once per database handle by the member-memory service. Keeps the
 * index in step with committed workspace writes, inline and within a small
 * budget; the rest goes to the background queue.
 */
export function registerMemberHistoryObserver(sql: AiSql): void {
  if (hasAiWorkspaceWriteObserver(sql)) return;
  setAiWorkspaceWriteObserver(sql, {
    v1Saved(event) {
      if (!memberHistoryEligible(sql, event.tenantId, event.userId)) return;
      const index = new AiMemberHistoryIndex(sql, event.tenantId);
      const result = index.sync(event.userId, { conversations: historySourceFromState(event.state), full: true, version: 1, revision: event.revision, live: true, budget: MEMBER_HISTORY_LIMITS.liveBudget });
      if (!result.complete) index.enqueue(event.userId, "backfill");
    },
    v2ConversationWritten(event) {
      if (!memberHistoryEligible(sql, event.tenantId, event.userId)) return;
      const index = new AiMemberHistoryIndex(sql, event.tenantId);
      const known = index.generation(event.userId) !== null;
      const result = index.sync(event.userId, { conversations: [historySourceFromConversation(event.conversation, event.revision)], full: false, version: 2, revision: null, live: known, budget: MEMBER_HISTORY_LIMITS.liveBudget });
      // A member seen for the first time on V2 still needs their other conversations.
      if (!known || !result.complete) index.enqueue(event.userId, "backfill");
    },
  });
}

/** Organizations whose administrators have memory and recall on. */
export function recallTenants(sql: AiSql): string[] {
  try {
    return sql.all<{ id: string; tenant_id: string; data: string }>("SELECT id,tenant_id,data FROM ai_settings WHERE id='member_memory' OR id LIKE '@%:member_memory'").flatMap(row => {
      try {
        const tenantId = normalizeAiTenantId(row.tenant_id);
        if (row.id !== tenantStorageKey(tenantId, "member_memory")) return [];
        const settings = parseMemoryAdminSettings(JSON.parse(row.data));
        return settings.enabled && settings.recallEnabled ? [tenantId] : [];
      } catch { return []; }
    });
  } catch { return []; }
}
