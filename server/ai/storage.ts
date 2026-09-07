import type { AiChatResponse, AiImageAsset, AiImageMimeType, AiImageResponse, AiMode, AiProviderConfig, AiQuota, AiUsageEntry } from "../../shared/ai";
import { AiError } from "./security";

export interface AiSql {
  exec(query: string, ...bindings: Array<string | number | null>): void;
  all<T>(query: string, ...bindings: Array<string | number | null>): T[];
  transaction<T>(action: () => T): T;
}
export const AI_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_quotas (user_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_requests (user_id TEXT NOT NULL, request_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id, request_id));
CREATE TABLE IF NOT EXISTS ai_usage (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ai_usage_user_time ON ai_usage(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ai_assets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mime_type TEXT NOT NULL, byte_length INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ai_assets_user ON ai_assets(user_id);
CREATE TABLE IF NOT EXISTS ai_asset_chunks (asset_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(asset_id, chunk_index));
`;
export interface StoredProvider extends AiProviderConfig { encryptedKey: string; encryptedImageKey?: string }
export interface StoredRequest {
  requestId: string;
  userId: string;
  hash: string;
  status: "pending" | "completed" | "failed" | "uncertain";
  createdAt: string;
  expiresAt: number;
  inputReserve: number;
  outputReserve: number;
  convertedReserve?: number;
  kind?: "chat" | "image";
  model: string;
  mode: AiMode;
  result?: Omit<AiChatResponse, "quota">;
  imageResult?: Omit<AiImageResponse, "quota">;
  error?: { status: number; code: string; message: string };
}
export function emptyQuota(): AiQuota {
  return { limitTokens: 0, usedTokens: 0, reservedTokens: 0, remainingTokens: 0, inputTokens: 0, outputTokens: 0 };
}
export class AiStore {
  constructor(readonly sql: AiSql) {}
  initialize(): void { this.sql.exec(AI_SCHEMA); }
  provider(): StoredProvider | null {
    const row = this.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id = 'provider'")[0];
    return row ? JSON.parse(row.data) as StoredProvider : null;
  }
  saveProvider(value: StoredProvider): void {
    this.sql.exec("INSERT INTO ai_settings(id,data) VALUES('provider',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", JSON.stringify(value));
  }
  quota(userId: string): AiQuota {
    const row = this.sql.all<{ data: string }>("SELECT data FROM ai_quotas WHERE user_id = ?", userId)[0];
    const q = row ? JSON.parse(row.data) as AiQuota : emptyQuota();
    return { ...q, remainingTokens: Math.max(0, q.limitTokens - q.usedTokens - q.reservedTokens) };
  }
  /** A zero-limit row or an old persona is not an entitlement. Keep prior grants after exhaustion. */
  hasAccess(userId: string): boolean {
    const quota = this.quota(userId);
    if (quota.limitTokens > 0 || quota.usedTokens > 0 || quota.reservedTokens > 0) return true;
    // Read the authoritative ledger, not the UI's bounded latest-200 usage list.
    // This also preserves legacy grants lowered back to zero before any generation.
    return this.sql.all<{ id: string }>("SELECT id FROM ai_usage WHERE user_id=? AND json_extract(data,'$.kind')='quota' AND json_extract(data,'$.limitTokens')>0 LIMIT 1", userId).length > 0;
  }
  assertAccess(userId: string): void {
    if (!this.hasAccess(userId)) throw new AiError(403, "AI_ACCESS_NOT_GRANTED", "管理员尚未为此账号开通 AI，请联系管理员分配额度");
  }
  saveQuota(userId: string, quota: AiQuota): void {
    this.sql.exec("INSERT INTO ai_quotas(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data", userId, JSON.stringify(quota));
  }
  request(userId: string, requestId: string): StoredRequest | undefined {
    const row = this.sql.all<{ data: string }>("SELECT data FROM ai_requests WHERE user_id=? AND request_id=?", userId, requestId)[0];
    return row ? JSON.parse(row.data) as StoredRequest : undefined;
  }
  pending(userId: string): StoredRequest[] {
    return this.sql.all<{ data: string }>("SELECT data FROM ai_requests WHERE user_id=? AND json_extract(data,'$.status')='pending'", userId).map(r => JSON.parse(r.data) as StoredRequest);
  }
  activeImageCount(): number {
    return this.sql.all<{ count: number }>("SELECT COUNT(*) AS count FROM ai_requests WHERE json_extract(data,'$.status')='pending' AND json_extract(data,'$.kind')='image' AND json_extract(data,'$.expiresAt')>?", Date.now())[0]?.count ?? 0;
  }
  saveRequest(value: StoredRequest): void {
    this.sql.exec("INSERT INTO ai_requests(user_id,request_id,data) VALUES(?,?,?) ON CONFLICT(user_id,request_id) DO UPDATE SET data=excluded.data", value.userId, value.requestId, JSON.stringify(value));
  }
  addUsage(value: AiUsageEntry): void {
    this.sql.exec("INSERT INTO ai_usage(id,user_id,created_at,data) VALUES(?,?,?,?)", value.id, value.userId, value.createdAt, JSON.stringify(value));
  }
  /** Called inside the generation settlement transaction. No base64 is stored in a single oversized SQLite row. */
  saveAsset(userId: string, mimeType: AiImageMimeType, base64: string, byteLength: number): AiImageResponse["images"][number] {
    this.assertAssetCapacity(userId, byteLength);
    const assetId = crypto.randomUUID();
    this.sql.exec("INSERT INTO ai_assets(id,user_id,mime_type,byte_length,created_at) VALUES(?,?,?,?,?)", assetId, userId, mimeType, byteLength, new Date().toISOString());
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < base64.length; offset += chunkSize) {
      this.sql.exec("INSERT INTO ai_asset_chunks(asset_id,chunk_index,data) VALUES(?,?,?)", assetId, offset / chunkSize, base64.slice(offset, offset + chunkSize));
    }
    return { assetId, mimeType };
  }
  assertAssetCapacity(userId: string, incomingBytes: number): void {
    const used = this.sql.all<{ bytes: number }>("SELECT COALESCE(SUM(byte_length),0) AS bytes FROM ai_assets WHERE user_id=?", userId)[0]?.bytes ?? 0;
    if (incomingBytes > 4 * 1024 * 1024 || used + incomingBytes > 50 * 1024 * 1024) throw new AiError(409, "AI_ASSET_CAPACITY", "图片存储空间不足，请删除不需要的图片后重试");
  }
  asset(userId: string, assetId: string): AiImageAsset | null {
    const row = this.sql.all<{ mime_type: AiImageMimeType }>("SELECT mime_type FROM ai_assets WHERE id=? AND user_id=?", assetId, userId)[0];
    if (!row) return null;
    const chunks = this.sql.all<{ data: string }>("SELECT data FROM ai_asset_chunks WHERE asset_id=? ORDER BY chunk_index", assetId);
    return { assetId, mimeType: row.mime_type, base64: chunks.map(chunk => chunk.data).join("") };
  }
  deleteAsset(userId: string, assetId: string): void {
    this.sql.transaction(() => {
      const row = this.sql.all<{ id: string }>("SELECT id FROM ai_assets WHERE id=? AND user_id=?", assetId, userId)[0];
      if (!row) throw new AiError(404, "AI_ASSET_NOT_FOUND", "图片不存在或已删除");
      this.sql.exec("DELETE FROM ai_asset_chunks WHERE asset_id=?", assetId);
      this.sql.exec("DELETE FROM ai_assets WHERE id=? AND user_id=?", assetId, userId);
    });
  }
  usage(userId?: string): AiUsageEntry[] {
    const rows = userId
      ? this.sql.all<{ data: string }>("SELECT data FROM ai_usage WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 200", userId)
      : this.sql.all<{ data: string }>("SELECT data FROM ai_usage ORDER BY created_at DESC, rowid DESC LIMIT 200");
    return rows.map(row => JSON.parse(row.data) as AiUsageEntry);
  }
}
