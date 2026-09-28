import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiStore, type AiSql } from "../../../server/ai/storage";
import { AiService } from "../../../server/ai/service";
import { createSecretBox } from "../../../server/ai/security";
import type { AiTransport } from "../../../server/ai/provider";
import type { UserRow } from "../platform";
import { handleAiRequest } from "./routes";

describe("Cloudflare admin quota route", () => {
  let database: DatabaseSync;
  let service: AiService;
  const transport = vi.fn<AiTransport>();
  const user = (id: string, role: UserRow["role"]): UserRow => ({ id, name: id, role, status: "active", email: `${id}@example.com`, password_hash: "never-return-password", job_title: "", avatar_seed: 1, avatar_version: 0, avatar_data_url: null, email_verified_at: "2026-09-28T00:00:00Z", last_login_at: null, created_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z" });
  const admin = user("admin", "admin"), member = user("a", "member");
  const put = (body: unknown) => handleAiRequest(new Request("https://tongpin.example.com/api/admin/ai/members/a/quota", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), service, admin, () => [admin, member]);

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T { database.exec("BEGIN"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
    };
    const store = new AiStore(sql); store.initialize();
    service = new AiService(store, () => createSecretBox("cloudflare-quota-route-secret-32-bytes"), transport);
  });
  afterEach(() => { database.close(); });

  it("accepts { addTokens } and applies it to the current limit", async () => {
    expect((await put({ limitTokens: 1000 })).status).toBe(200);
    const added = await put({ addTokens: 250, reason: "管理员追加额度" });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ member: { id: "a", quota: { limitTokens: 1250, remainingTokens: 1250 } } });
    const rejected = await put({ addTokens: 1.5 });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "AI_QUOTA_INVALID" } });
    expect(service.store.usage("a").filter(entry => entry.kind === "quota").map(entry => [entry.limitTokens, entry.reason]))
      .toEqual([[1250, "管理员追加额度"], [1000, "管理员调整额度"]]);
    expect(transport).not.toHaveBeenCalled();
  });
});
