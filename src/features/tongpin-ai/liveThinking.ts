import type { AiRunEvent, AiWebSearchProgress } from "../../../shared/aiRunEvents";

/** Ephemeral, display-only live state for one in-flight reply. Built solely
 * from real run events; never persisted on the message and never sent back to
 * the model. There is no invented progress text here. The provider-designated
 * public summary keeps flowing through `analysisSummary` as before. This
 * legacy panel shows web_search progress only; code_interpreter progress is
 * shown by the newer reply-process card instead. */
export interface TongpinAILiveThinking {
  /** Reasoning text a chat-completions provider published as reasoning_content. */
  reasoning: string;
  searches: AiWebSearchProgress[];
}

export const EMPTY_LIVE_THINKING: TongpinAILiveThinking = Object.freeze({ reasoning: "", searches: [] }) as TongpinAILiveThinking;

/** Returns the same object when the event carries no thinking state. */
export function applyLiveThinkingEvent(state: TongpinAILiveThinking, event: AiRunEvent): TongpinAILiveThinking {
  if (event.type === "reasoning_delta") return { ...state, reasoning: state.reasoning + event.data.delta };
  if (event.type === "tool_progress" && event.data.tool === "web_search") {
    const progress = event.data;
    const index = state.searches.findIndex(item => item.callId === progress.callId);
    const searches = index < 0 ? [...state.searches, progress] : state.searches.map((item, i) => i === index ? progress : item);
    return { ...state, searches };
  }
  return state;
}

export function hasLiveThinking(state: TongpinAILiveThinking | undefined): state is TongpinAILiveThinking {
  return Boolean(state && (state.reasoning.trim() || state.searches.length));
}

/** Labels describe the provider-reported state only. */
export function searchProgressLabel(progress: AiWebSearchProgress): string {
  if (progress.status === "completed") return progress.sourceCount !== undefined ? `已完成 · ${progress.sourceCount} 个来源` : "已完成";
  if (progress.status === "failed") return "未完成";
  return progress.status === "searching" ? "搜索中" : "已发起";
}
