import { filterBaiAgentModels, type BaiAgentModel } from "../../shared/aiAuto";
import type { StoredProvider } from "./storage";

/** Returns null for absent/stale verification and [] for a verified empty intersection. */
export function verifiedBaiAgentModels(provider: StoredProvider): BaiAgentModel[] | null {
  if (!provider.modelConfigVersion || !provider.modelKeyVersion
    || provider.verifiedModelConfigVersion !== provider.modelConfigVersion
    || provider.verifiedModelKeyVersion !== provider.modelKeyVersion
    || !Array.isArray(provider.verifiedModels)) return null;
  return filterBaiAgentModels(provider.verifiedModels.filter((model): model is string => typeof model === "string"));
}
