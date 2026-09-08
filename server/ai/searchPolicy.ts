import type { AiProviderConfig } from "../../shared/ai";

/** A local reservation/stream guard, not a promise that a gateway can cancel upstream work. */
export function searchCallLimit(provider: Pick<AiProviderConfig, "webSearchProtocol">): number {
  return provider.webSearchProtocol === "compatible" ? 3 : 1;
}
