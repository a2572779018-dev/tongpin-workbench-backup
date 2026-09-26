import { AI_CODE_INTERPRETER_CALL_LIMIT } from "../../shared/ai";
import type { AiProviderConfig } from "../../shared/ai";

/** A local reservation/stream guard, not a promise that a gateway can cancel upstream work.
 * Mirrors searchCallLimit: unlike web_search, code_interpreter is never forced
 * (tool_choice stays "auto"), so the same bound applies to every protocol. */
export function codeInterpreterCallLimit(provider: Pick<AiProviderConfig, "webSearchProtocol">): number {
  void provider;
  return AI_CODE_INTERPRETER_CALL_LIMIT;
}
