import { AI_PERSONA_LIMITS, defaultAiPersonaProfile, isAiPersonaExpression, type AiPersonaProfile, type AiPersonaSnapshot } from "../../shared/aiPersona";
import { AiError } from "./security";
import { AiStore, type AiSql } from "./storage";
import { DEFAULT_AI_TENANT_ID, normalizeAiTenantId, tenantStorageKey } from "./tenant";

export const AI_PERSONA_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_personas (
  user_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}',
  revision INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
`;

function invalid(message: string): never { throw new AiError(400, "AI_PERSONA_INVALID", message); }
function accountId(userId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) invalid("账号标识无效");
}
function record(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("请提交完整的专属 AI 设置");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) invalid("专属 AI 设置包含不支持的字段，请更新客户端");
  return result;
}

export function validateAiPersonaProfile(value: unknown): AiPersonaProfile {
  const profile = record(value, ["name", "tone", "customStyle", "preferences", "onboardingComplete", "expression"]);
  if (typeof profile.name !== "string" || /[\u0000-\u001f\u007f]/.test(profile.name)) invalid("AI 名称不能包含换行或控制字符");
  const name = profile.name.trim();
  if (Array.from(name).length > AI_PERSONA_LIMITS.nameCharacters) invalid("AI 名称最多 40 个字");
  if (typeof profile.tone !== "string" || !["warm", "professional", "concise", "creative"].includes(profile.tone)) invalid("请选择有效的性格风格");
  for (const key of ["customStyle", "preferences"] as const) {
    if (typeof profile[key] !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(profile[key])) invalid("性格或偏好内容格式不正确");
  }
  if ((profile.customStyle as string).length > AI_PERSONA_LIMITS.customStyleCharacters) invalid("自定义性格最多 2000 个字符");
  if ((profile.preferences as string).length > AI_PERSONA_LIMITS.preferencesCharacters) invalid("已确认偏好最多 4000 个字符");
  if (typeof profile.onboardingComplete !== "boolean") invalid("引导状态格式不正确");
  const expression = profile.expression === undefined ? "auto" : profile.expression;
  if (!isAiPersonaExpression(expression)) invalid("请选择有效的表情");
  return {
    name, tone: profile.tone as AiPersonaProfile["tone"], customStyle: (profile.customStyle as string).trim(),
    preferences: (profile.preferences as string).trim(), onboardingComplete: profile.onboardingComplete, expression,
  };
}

/** Only authenticated member ids are accepted by routes; administrators have no read-all endpoint. */
export class AiPersonaRepository {
  constructor(readonly sql: AiSql) {}
  initialize(): void {
    this.sql.exec(AI_PERSONA_SCHEMA);
    const columns = this.sql.all<{ name: string }>("PRAGMA table_info(ai_personas)");
    if (!columns.some(column => column.name === "tenant_id")) this.sql.exec(`ALTER TABLE ai_personas ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}'`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS ai_personas_tenant_user ON ai_personas(tenant_id,user_id)");
  }
  read(userId: string, tenantId: string = DEFAULT_AI_TENANT_ID): AiPersonaSnapshot {
    accountId(userId);
    const tenant = normalizeAiTenantId(tenantId);
    const storedUserId = tenantStorageKey(tenant, userId);
    new AiStore(this.sql, tenant).assertAccess(userId);
    const row = this.sql.all<{ revision: number; schema_version: number; data: string }>("SELECT revision,schema_version,data FROM ai_personas WHERE tenant_id=? AND user_id=?", tenant, storedUserId)[0];
    if (!row) return { revision: 0, profile: defaultAiPersonaProfile() };
    if (row.schema_version !== 1) throw new AiError(409, "AI_PERSONA_VERSION_UNSUPPORTED", "专属 AI 设置版本已更新，请升级客户端");
    return { revision: row.revision, profile: validateAiPersonaProfile(JSON.parse(row.data)) };
  }
  save(userId: string, value: unknown, tenantId: string = DEFAULT_AI_TENANT_ID): AiPersonaSnapshot {
    accountId(userId);
    const tenant = normalizeAiTenantId(tenantId);
    const storedUserId = tenantStorageKey(tenant, userId);
    new AiStore(this.sql, tenant).assertAccess(userId);
    const body = record(value, ["expectedRevision", "profile", "reset"]);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || Number(body.expectedRevision) >= Number.MAX_SAFE_INTEGER) invalid("设置版本无效，请重新加载");
    if (body.reset !== undefined && typeof body.reset !== "boolean") invalid("重置选项格式不正确");
    if (body.reset === true && body.profile !== undefined) invalid("重置时不能同时提交其他设置");
    const profile = body.reset === true ? defaultAiPersonaProfile() : validateAiPersonaProfile(body.profile);
    return this.sql.transaction(() => {
      const current = this.read(userId, tenant);
      if (current.revision !== body.expectedRevision) throw new AiError(409, "AI_PERSONA_CONFLICT", "专属 AI 设置已在其他窗口修改，本次未覆盖，请重新加载后再确认");
      // Older clients omit this visual-only field when saving textual preferences.
      // Preserve an existing choice inside the same CAS transaction; only reset or
      // an explicit expression (including "auto") replaces it.
      if (body.reset !== true && (body.profile as Record<string, unknown>).expression === undefined) {
        profile.expression = current.profile.expression ?? "auto";
      }
      const revision = current.revision + 1;
      this.sql.exec("INSERT INTO ai_personas(user_id,tenant_id,revision,schema_version,updated_at,data) VALUES(?,?,?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET tenant_id=excluded.tenant_id,revision=excluded.revision,schema_version=excluded.schema_version,updated_at=excluded.updated_at,data=excluded.data", storedUserId, tenant, revision, new Date().toISOString(), JSON.stringify(profile));
      return { revision, profile };
    });
  }
}
