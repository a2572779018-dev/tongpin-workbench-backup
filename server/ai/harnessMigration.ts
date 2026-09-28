import { AI_BUSINESS_TIERS, type AiHarnessTierRoute, type AiMode } from "../../shared/ai";
import { videoModel } from "../../shared/aiVideoModels";
import { BAI_QUICK_MODELS, isTongpinQuickAgent } from "../../shared/aiAuto";
import type { AiStore, StoredHarnessConfig, StoredHarnessProvider } from "./storage";
import { tenantStorageKey } from "./tenant";

/** Read-only migration draft. Credentials stay encrypted and the existing
 * routing stays active until the administrator saves the four-tier settings. */
export function legacyHarnessDraft(store: AiStore): StoredHarnessConfig | null {
  const legacy = store.provider();
  if (!legacy) return null;
  function connection(id: string, name: string, baseUrl: string, encryptedKey: string,
    version: string, keyVersion: string, verified: boolean, models: unknown, verifiedAt: string | null): StoredHarnessProvider {
    return {
      id, name, baseUrl, encryptedKey, protocol: legacy!.protocol, enabled: legacy!.enabled,
      apiKeyConfigured: Boolean(encryptedKey), configVersion: version, keyVersion,
      modelsVerified: verified, availableModels: verified && Array.isArray(models) ? models.filter((value): value is string => typeof value === "string") : [],
      modelsVerifiedAt: verified ? verifiedAt : null,
      ...(verified ? { verifiedConfigVersion: version, verifiedKeyVersion: keyVersion } : {}),
    };
  }
  const version = legacy.modelConfigVersion ?? `legacy:${legacy.updatedAt ?? "initial"}`;
  const keyVersion = legacy.modelKeyVersion ?? version;
  const verified = Boolean(legacy.modelConfigVersion && legacy.modelKeyVersion
    && legacy.verifiedModelConfigVersion === legacy.modelConfigVersion && legacy.verifiedModelKeyVersion === legacy.modelKeyVersion);
  const providers = [connection("legacy", legacy.name, legacy.baseUrl, legacy.encryptedKey,
    version, keyVersion, verified, legacy.verifiedModels, legacy.verifiedModelsAt ?? null)];
  const wasAuto = isTongpinQuickAgent(legacy.quickModel);
  const quickModel = wasAuto ? BAI_QUICK_MODELS.find(model => providers[0].availableModels.includes(model)) ?? "" : legacy.quickModel;
  const imageProviderId = legacy.imageBaseUrl ? "legacy-image" : "legacy";
  const hasImage = Boolean(legacy.imageModel && (legacy.imageBaseUrl ? legacy.encryptedImageKey : legacy.encryptedKey));
  if (hasImage && legacy.imageBaseUrl) {
    providers.push(connection(imageProviderId, "图片服务", legacy.imageBaseUrl, legacy.encryptedImageKey!, version, keyVersion, false, [], null));
  }
  const row = store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE tenant_id=? AND id=?",
    store.tenantId, tenantStorageKey(store.tenantId, "video"))[0];
  const video = row ? JSON.parse(row.data) as {
    enabled?: boolean; encryptedKey?: string; defaultModel?: string; configVersion?: string; keyVersion?: string;
    verifiedConfigVersion?: string; verifiedKeyVersion?: string; verifiedModels?: unknown;
  } : null;
  const hasVideo = Boolean(video?.encryptedKey);
  if (hasVideo) {
    const videoVersion = video!.configVersion ?? "legacy-video";
    const videoKeyVersion = video!.keyVersion ?? videoVersion;
    const videoVerified = Boolean(video!.configVersion && video!.keyVersion && video!.verifiedConfigVersion === video!.configVersion && video!.verifiedKeyVersion === video!.keyVersion);
    providers.push({ ...connection("legacy-video", "视频服务", "https://www.75api.com/v1", video!.encryptedKey!,
      videoVersion, videoKeyVersion, videoVerified, video!.verifiedModels, null), protocol: "chat_completions", enabled: true });
  }
  const tiers = Object.fromEntries(AI_BUSINESS_TIERS.map(tier => {
    const protocol = wasAuto ? (tier === "quick" || tier === "standard" ? "chat_completions" : "responses") : legacy.protocol;
    // Hosted search runs only on a Responses text route; the four-tier settings reject it elsewhere.
    const hostedTools = protocol === "responses" && legacy.webSearchEnabled ? ["web_search"] : [];
    return [tier, {
      providerId: "legacy", modelId: tier === "quick" || tier === "standard" ? quickModel : legacy.deepModel,
      protocol, maxOutputTokens: legacy.maxOutputTokens,
      reasoningEffort: tier === "deep" || tier === "pro" ? legacy.reasoningEffort : "",
      enabled: legacy.enabled,
      capabilities: ["chat", "presentation", ...(legacy.visionEnabled ? ["vision"] : []),
        ...hostedTools, ...(hasImage ? ["image"] : []), ...(hasVideo && video!.enabled ? ["video"] : [])],
      ...(hasImage ? { imageProviderId, imageModelId: legacy.imageModel } : {}),
      ...(hasVideo ? { videoProviderId: "legacy-video", videoModelId: videoModel(video!.defaultModel)?.id ?? "minimax_h3" } : {}),
    }];
  })) as Record<AiMode, AiHarnessTierRoute>;
  return { providers, tiers, policy: { strategy: "direct", maxToolSteps: 1, requireApproval: true, autoWebSearch: true },
    updatedAt: legacy.updatedAt, migratedFromLegacy: true };
}
