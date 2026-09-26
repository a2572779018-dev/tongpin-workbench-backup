import type { AiSql } from "./storage";

/** One additive, idempotent schema step owned by an AI module. */
export interface AiModuleMigration {
  version: number;
  description: string;
  up(sql: AiSql): void;
}

export const AI_SCHEMA_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS ai_schema_migrations (
  module TEXT NOT NULL,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (module, version)
);
`;

/**
 * Numbered migrations for AI modules that share the AI SQLite database (the
 * Durable Object in production, `*.ai.sqlite` for the Express server). Each
 * version runs once, inside its own transaction together with its ledger row,
 * so a failed step is retried on the next start and never half-applied.
 */
export function applyAiModuleMigrations(sql: AiSql, module: string, migrations: readonly AiModuleMigration[]): number[] {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(module)) throw new Error(`Invalid AI migration module: ${module}`);
  sql.exec(AI_SCHEMA_MIGRATIONS_TABLE);
  const applied = new Set(sql.all<{ version: number }>("SELECT version FROM ai_schema_migrations WHERE module=?", module).map(row => row.version));
  const ran: number[] = [];
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) throw new Error(`Invalid AI migration version: ${module}#${migration.version}`);
    if (applied.has(migration.version)) continue;
    sql.transaction(() => {
      migration.up(sql);
      sql.exec("INSERT INTO ai_schema_migrations(module,version,applied_at) VALUES(?,?,?)", module, migration.version, new Date().toISOString());
    });
    ran.push(migration.version);
  }
  return ran;
}
