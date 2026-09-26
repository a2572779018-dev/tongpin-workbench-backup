import { AI_MAX_SEARCH_CALLS } from "../../shared/ai";
import type { AiProviderConfig } from "../../shared/ai";

/** A local reservation/stream guard, not a promise that a gateway can cancel upstream work. */
export function searchCallLimit(provider: Pick<AiProviderConfig, "webSearchProtocol">): number {
  // Compatible relays cannot take max_tool_calls, so the bound is local. A
  // multi-part question (e.g. weather + air quality) routinely needs 3–4
  // searches; 3 cut real answers off mid-stream. The reserve scales with it
  // and is refunded to actual use.
  return provider.webSearchProtocol === "compatible" ? AI_MAX_SEARCH_CALLS : 1;
}
