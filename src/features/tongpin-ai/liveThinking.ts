import type { AiRunEvent, AiToolProgress } from "../../../shared/aiRunEvents";

/** Ephemeral, display-only live state for one in-flight reply. Built solely
 * from real run events; never persisted on the message and never sent back to
 * the model. There is no invented progress text here. The provider-designated
 * public summary keeps flowing through `analysisSummary` as before. */
export interface TongpinAILiveThinking {
  /** Reasoning text a chat-completions provider published as reasoning_content. */
  reasoning: string;
  searches: AiToolProgress[];
}

export const EMPTY_LIVE_THINKING: TongpinAILiveThinking = Object.freeze({ reasoning: "", searches: [] }) as TongpinAILiveThinking;

/** Returns the same object when the event carries no thinking state. */
export function applyLiveThinkingEvent(state: TongpinAILiveThinking, event: AiRunEvent): TongpinAILiveThinking {
  if (event.type === "reasoning_delta") return { ...state, reasoning: state.reasoning + event.data.delta };
  if (event.type === "tool_progress") {
    const index = state.searches.findIndex(item => item.callId === event.data.callId);
    const searches = index < 0 ? [...state.searches, event.data] : state.searches.map((item, i) => i === index ? event.data : item);
    return { ...state, searches };
  }
  return state;
}

export function hasLiveThinking(state: TongpinAILiveThinking | undefined): state is TongpinAILiveThinking {
  return Boolean(state && (state.reasoning.trim() || state.searches.length));
}

/** Labels describe the provider-reported state only. */
export function searchProgressLabel(progress: AiToolProgress): string {
  if (progress.status === "completed") return progress.sourceCount !== undefined ? `已完成 · ${progress.sourceCount} 个来源` : "已完成";
  if (progress.status === "failed") return "未完成";
  return progress.status === "searching" ? "搜索中" : "已发起";
}
