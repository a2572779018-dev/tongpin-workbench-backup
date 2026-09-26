import { COMPUTER_AGENT_LIMITS, computerRunLimits, type AiComputerSettings } from "../../shared/computerAgent";
import { JEV_DEFAULT_MODEL, JEV_MODEL_PATTERN } from "./computerJev";
import { AiError, type SecretBox } from "./security";
import type { AiStore } from "./storage";
import { tenantStorageKey } from "./tenant";

/** Server-only record. `encryptedKey` is AES-GCM sealed like every provider key. */
export interface StoredComputerSettings extends Omit<AiComputerSettings, "apiKeyConfigured"> {
  encryptedKey?: string;
  /** Rotates with every new key so a stale verification is never reused. */
  keyVersion?: string;
  verifiedKeyVersion?: string;
}

const SETTING_ID = "computer_jev";
const MAX_POINTS_PER_1K = 10_000_000;

function defaults(): StoredComputerSettings {
  return {
    enabled: false, model: JEV_DEFAULT_MODEL, inputPointsPer1k: 1000, outputPointsPer1k: 1000,
    ...computerRunLimits(undefined), updatedAt: null, verifiedAt: null, availableModels: [],
  };
}

export function readComputerSettings(store: AiStore): StoredComputerSettings {
  const row = store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id=? AND tenant_id=?", tenantStorageKey(store.tenantId, SETTING_ID), store.tenantId)[0];
  if (!row) return defaults();
  const stored = JSON.parse(row.data) as Partial<StoredComputerSettings>;
  return { ...defaults(), ...stored, ...computerRunLimits(stored) };
}

function writeComputerSettings(store: AiStore, value: StoredComputerSettings): void {
  store.sql.exec(
    "INSERT INTO ai_settings(id,tenant_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET tenant_id=excluded.tenant_id,data=excluded.data",
    tenantStorageKey(store.tenantId, SETTING_ID), store.tenantId, JSON.stringify(value),
  );
}

export function publicComputerSettings(value: StoredComputerSettings): AiComputerSettings {
  const { encryptedKey, keyVersion: _version, verifiedKeyVersion: _verified, ...safe } = value;
  const verified = Boolean(encryptedKey && value.verifiedKeyVersion && value.verifiedKeyVersion === value.keyVersion);
  return { ...safe, apiKeyConfigured: Boolean(encryptedKey), verifiedAt: verified ? value.verifiedAt : null, availableModels: verified ? value.availableModels : [] };
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new AiError(400, "AI_COMPUTER_SETTINGS_INVALID", `${label}需为 ${min} 到 ${max} 的整数`);
  return Number(value);
}

/** Admin PUT. A new key is encrypted before persisting; an empty key keeps the saved one. */
export async function saveComputerSettings(store: AiStore, box: () => Promise<SecretBox>, body: unknown): Promise<AiComputerSettings> {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!input) throw new AiError(400, "AI_COMPUTER_SETTINGS_INVALID", "Jev 决策服务配置格式不正确");
  if (typeof input.enabled !== "boolean") throw new AiError(400, "AI_COMPUTER_SETTINGS_INVALID", "请选择是否启用 Jev 决策服务");
  if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw new AiError(400, "AI_COMPUTER_SETTINGS_INVALID", "Jev 密钥格式不正确");
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (apiKey && (apiKey.length < 8 || apiKey.length > 512 || /[\s\p{Cc}\p{Cf}]/u.test(apiKey))) throw new AiError(400, "AI_COMPUTER_SETTINGS_INVALID", "Jev 密钥格式不正确");
  const model = input.model === undefined || input.model === "" ? JEV_DEFAULT_MODEL : input.model;
  if (typeof model !== "string" || !JEV_MODEL_PATTERN.test(model)) throw new AiError(400, "AI_COMPUTER_SETTINGS_INVALID", "Jev 模型名称需以 jev- 开头，例如 jev-latest");
  const inputPointsPer1k = integer(input.inputPointsPer1k, 0, MAX_POINTS_PER_1K, "每千输入 Token 折算同频点");
  const outputPointsPer1k = integer(input.outputPointsPer1k, 0, MAX_POINTS_PER_1K, "每千输出 Token 折算同频点");
  const maxSteps = integer(input.maxSteps ?? COMPUTER_AGENT_LIMITS.defaultMaxSteps, 1, COMPUTER_AGENT_LIMITS.maxStepsCeiling, "单次电脑任务步数上限");
  const maxMinutes = integer(input.maxMinutes ?? COMPUTER_AGENT_LIMITS.defaultMaxMinutes, 1, COMPUTER_AGENT_LIMITS.maxMinutesCeiling, "单次电脑任务时长上限（分钟）");
  const minConfidence = input.minConfidence ?? COMPUTER_AGENT_LIMITS.defaultMinConfidence;
  if (typeof minConfidence !== "number" || !Number.isFinite(minConfidence) || minConfidence < 0.3 || minConfidence > 0.95) throw new AiError(400, "AI_COMPUTER_SETTINGS_INVALID", "最低置信度需在 0.3 到 0.95 之间");
  const encryptedKey = apiKey ? await (await box()).encrypt(apiKey) : undefined;
  return store.sql.transaction(() => {
    const current = readComputerSettings(store);
    if (input.enabled && !encryptedKey && !current.encryptedKey) throw new AiError(400, "AI_COMPUTER_KEY_REQUIRED", "启用前请先填写 Jev（TypeSafe）API 密钥");
    const next: StoredComputerSettings = {
      ...current, enabled: input.enabled as boolean, model, inputPointsPer1k, outputPointsPer1k,
      maxSteps, maxMinutes, minConfidence: Math.round(minConfidence * 100) / 100, updatedAt: new Date().toISOString(),
      ...(encryptedKey ? { encryptedKey, keyVersion: crypto.randomUUID(), verifiedAt: null, availableModels: [] } : {}),
    };
    writeComputerSettings(store, next);
    return publicComputerSettings(next);
  });
}

/** Persist a successful non-generating model listing for the exact saved key. */
export function recordComputerVerification(store: AiStore, keyVersion: string | undefined, models: string[]): AiComputerSettings {
  return store.sql.transaction(() => {
    const current = readComputerSettings(store);
    if (!current.encryptedKey || current.keyVersion !== keyVersion) throw new AiError(409, "AI_CONFIG_CHANGED", "Jev 配置刚刚被修改，请重新检查");
    const next = { ...current, verifiedKeyVersion: keyVersion, verifiedAt: new Date().toISOString(), availableModels: models };
    writeComputerSettings(store, next);
    return publicComputerSettings(next);
  });
}

/** Points for actual usage; admin-set prices are per 1,000 tokens and rounded up. */
export function computerDecisionPoints(settings: Pick<AiComputerSettings, "inputPointsPer1k" | "outputPointsPer1k">, inputTokens: number, outputTokens: number): number {
  return Math.ceil((inputTokens * settings.inputPointsPer1k + outputTokens * settings.outputPointsPer1k) / 1000);
}
