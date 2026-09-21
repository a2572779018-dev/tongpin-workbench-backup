import { AiError } from "./security";

/**
 * Existing desktop and single-company installs have no organization record yet.
 * Keeping their stable scope explicit avoids a data move while tenant-aware auth
 * is introduced incrementally.
 */
export const DEFAULT_AI_TENANT_ID = "default";

const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export function normalizeAiTenantId(value: unknown): string {
  const tenantId = value === undefined || value === null || value === ""
    ? DEFAULT_AI_TENANT_ID
    : value;
  if (typeof tenantId !== "string" || !TENANT_ID.test(tenantId)) {
    throw new AiError(403, "AI_TENANT_INVALID", "AI 组织范围无效，请重新登录");
  }
  return tenantId;
}

/** Only consume server-authenticated principal fields; tenant headers are never trusted. */
export function aiTenantIdFromPrincipal(principal: unknown): string {
  if (!principal || typeof principal !== "object") return DEFAULT_AI_TENANT_ID;
  const value = principal as Record<string, unknown>;
  const candidates = [value.tenantId, value.tenant_id, value.orgId, value.org_id]
    .filter(candidate => candidate !== undefined && candidate !== null && candidate !== "");
  if (candidates.length > 1 && candidates.some(candidate => candidate !== candidates[0])) {
    throw new AiError(403, "AI_TENANT_AMBIGUOUS", "AI 组织范围冲突，请重新登录");
  }
  return normalizeAiTenantId(candidates[0]);
}

/**
 * Legacy default rows keep their original keys. Non-default tenants receive a
 * length-delimited key so equal user/request ids can coexist without collisions.
 */
export function tenantStorageKey(tenantId: string, value: string): string {
  const normalized = normalizeAiTenantId(tenantId);
  return normalized === DEFAULT_AI_TENANT_ID ? value : `@${normalized.length}:${normalized}:${value}`;
}

/** Reverse only keys produced by tenantStorageKey(). Background maintenance
 * uses this to recover an authenticated user id from a persisted run while
 * retaining the tenant boundary selected by the row itself. */
export function tenantStorageValue(tenantId: string, stored: string): string {
  const normalized = normalizeAiTenantId(tenantId);
  if (normalized === DEFAULT_AI_TENANT_ID) return stored;
  const prefix = `@${normalized.length}:${normalized}:`;
  if (!stored.startsWith(prefix) || stored.length === prefix.length) {
    throw new AiError(500, "AI_TENANT_STORAGE_INVALID", "AI 组织数据索引无效，已停止后台续跑");
  }
  return stored.slice(prefix.length);
}
