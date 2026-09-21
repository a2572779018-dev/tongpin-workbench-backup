import type { AiHarnessConfig, AiHarnessProviderInput } from "../../../shared/ai";
import { normalizeAiBaseUrl } from "./adminAiForms";

export function filterAiModels(models: readonly string[], query: string): string[] {
  const needle = query.trim().toLocaleLowerCase();
  return [...new Set(models)].filter(model => model.toLocaleLowerCase().includes(needle))
    .sort((a, b) => Number(b.toLocaleLowerCase().startsWith(needle)) - Number(a.toLocaleLowerCase().startsWith(needle)) || a.localeCompare(b));
}

/** A changed address must never send the previously stored credential to a new host. */
export function planModelDiscovery(provider: AiHarnessProviderInput, key: string, saved: AiHarnessConfig | null):
  { path: string; body?: { target: "chat"; baseUrl: string; apiKey?: string }; error?: never } | { error: string; path?: never; body?: never } {
  let baseUrl: string;
  try { baseUrl = normalizeAiBaseUrl(provider.baseUrl); }
  catch { return { error: "请先填写有效的 HTTPS API 地址。" }; }
  const previous = saved?.providers.find(item => item.id === provider.id);
  const sameAddress = previous && normalizeAiBaseUrl(previous.baseUrl) === baseUrl;
  if (key.trim()) return { path: "/api/admin/ai/provider/test", body: { target: "chat", baseUrl, apiKey: key.trim() } };
  if (!previous?.apiKeyConfigured) return { error: "请先填写这个服务的 API Key。" };
  if (!sameAddress) return { error: "API 地址已修改，请填写新地址对应的 API Key 后读取模型。" };
  return { path: `/api/admin/ai/harness/providers/${encodeURIComponent(provider.id)}/discover` };
}
