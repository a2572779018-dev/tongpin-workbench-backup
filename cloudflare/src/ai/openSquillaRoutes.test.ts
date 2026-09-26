import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENSQUILLA_ROUTING } from "../../../shared/aiOpenSquilla";
import type { AiTransport } from "../../../server/ai/provider";
import { createSecretBox } from "../../../server/ai/security";
import { AiService } from "../../../server/ai/service";
import { AiStore, type AiSql } from "../../../server/ai/storage";
import type { UserRow } from "../platform";
import { handleAiRequest } from "./routes";

const mapping = { enabled: true, applyPromptPolicy: false, tiers: { c0: "direct", c1: "search", c2: "reasoning", c3: "suggest_upgrade" } };

describe("OpenSquilla admin routes (Cloudflare Worker)", () => {
  const transport = vi.fn<AiTransport>();
  let database: DatabaseSync;
  let service: AiService;
  const user = (id: string, role: UserRow["role"]): UserRow => ({ id, name: id, role, status: "active", email: `${id}@example.com`, password_hash: "never-return-password", job_title: "", avatar_seed: 1, avatar_version: 0, avatar_data_url: null, email_verified_at: "2026-09-05T00:00:00Z", last_login_at: null, created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z" });
  const admin = user("admin", "admin"), member = user("member", "member");
  const invoke = (method: string, actor: UserRow, body?: unknown) => handleAiRequest(new Request("https://tongpin.example.com/api/admin/ai/opensquilla", {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), service, actor, () => [admin, member]);
  beforeEach(() => {
    transport.mockReset();
    database = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T { database.exec("BEGIN"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
    };
    const store = new AiStore(sql); store.initialize();
    service = new AiService(store, () => createSecretBox("opensquilla-worker-route-secret-32-bytes"), transport);
  });
  afterEach(() => database.close());

  it("serves the same settings contract behind the admin gate", async () => {
    expect(await (await invoke("GET", admin)).json()).toEqual({ settings: { ...DEFAULT_OPENSQUILLA_ROUTING, updatedAt: null } });
    const saved = await invoke("PUT", admin, mapping);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ settings: mapping });
    expect(await (await invoke("GET", admin)).json()).toMatchObject({ settings: mapping });
    const invalid = await invoke("PUT", admin, { ...mapping, unexpected: true });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "AI_OPENSQUILLA_SETTINGS_INVALID" } });
    expect((await invoke("GET", member)).status).toBe(403);
    expect((await invoke("PUT", member, mapping)).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });
});
