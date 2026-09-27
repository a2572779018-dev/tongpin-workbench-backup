import type { AiModuleMigration } from "./aiMigrations";
import type { AiSql } from "./storage";

/*
 * Schema for member history recall (v2) and personal skills (v3), appended
 * to the `member_memory` module ledger. A leaf module on purpose: storage.ts
 * reaches it through memberMemoryStore.ts during initialization, so it must
 * not import services, repositories or the workspace code.
 */

export const MEMBER_HISTORY_FTS_TABLE = "ai_member_history_fts";

/**
 * Contentless trigram FTS5 index (substring matching for CJK text without a
 * word segmenter; rows deleted by rowid). Text lives once, in
 * ai_member_history_chunks. Verified on the Durable Object SQLite build and
 * node:sqlite; when a runtime lacks FTS5/trigram the index falls back to a
 * bounded per-member substring scan.
 */
export const MEMBER_HISTORY_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMBER_HISTORY_FTS_TABLE} USING fts5(owner, body, content='', contentless_delete=1, tokenize='trigram')`;

export const MEMBER_LEARNING_MIGRATIONS: readonly AiModuleMigration[] = [{
  version: 2,
  description: "member history recall: per-member conversation index, sync state, backfill queue and purge queue",
  up(sql) {
    sql.exec(`
CREATE TABLE IF NOT EXISTS ai_member_history_state (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'sync',
  complete INTEGER NOT NULL DEFAULT 0,
  source_version INTEGER NOT NULL DEFAULT 1,
  source_revision INTEGER NOT NULL DEFAULT -1,
  conversations TEXT NOT NULL DEFAULT '{}',
  indexed_chars INTEGER NOT NULL DEFAULT 0,
  indexed_chunks INTEGER NOT NULL DEFAULT 0,
  indexed_messages INTEGER NOT NULL DEFAULT 0,
  indexed_conversations INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE IF NOT EXISTS ai_member_history_conversations (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  title TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  source_revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  messages TEXT NOT NULL DEFAULT '[]',
  last_at INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS ai_member_history_chunks (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_member_history_chunks_member ON ai_member_history_chunks(tenant_id, user_id, generation, conversation_id);
CREATE INDEX IF NOT EXISTS ai_member_history_chunks_message ON ai_member_history_chunks(tenant_id, user_id, conversation_id, message_id);
CREATE TABLE IF NOT EXISTS ai_member_history_queue (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS ai_member_history_queue_due ON ai_member_history_queue(due_at);
CREATE TABLE IF NOT EXISTS ai_member_history_purges (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  below_generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
`);
    createMemberHistoryFts(sql);
  },
}, {
  version: 3,
  description: "personal skills (proposals and adopted), per-reply recall/skill activity, review skill link",
  up(sql) {
    sql.exec(`
CREATE TABLE IF NOT EXISTS ai_member_skills (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  status TEXT NOT NULL,
  name TEXT NOT NULL,
  when_to_use TEXT NOT NULL,
  instructions TEXT NOT NULL,
  triggers TEXT NOT NULL DEFAULT '[]',
  replaces_id TEXT,
  origin TEXT NOT NULL,
  reason TEXT,
  evidence INTEGER NOT NULL DEFAULT 0,
  source_request_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  adopted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, skill_id)
);
CREATE INDEX IF NOT EXISTS ai_member_skills_status ON ai_member_skills(tenant_id, user_id, status);
CREATE TABLE IF NOT EXISTS ai_member_activity (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  trigger TEXT,
  recalled INTEGER NOT NULL DEFAULT 0,
  snippets TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, request_id)
);
CREATE INDEX IF NOT EXISTS ai_member_activity_time ON ai_member_activity(tenant_id, user_id, created_at DESC);
`);
    if (!sql.all<{ name: string }>("PRAGMA table_info(ai_member_memory_reviews)").some(column => column.name === "skill_id")) {
      sql.exec("ALTER TABLE ai_member_memory_reviews ADD COLUMN skill_id TEXT");
    }
  },
}];

/** Best effort: a runtime without FTS5/trigram keeps working on the substring scan. */
export function createMemberHistoryFts(sql: AiSql): boolean {
  try { sql.exec(MEMBER_HISTORY_FTS_DDL); return true; } catch { return false; }
}
