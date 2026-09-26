import { CheckCircle2, Globe, LoaderCircle, TriangleAlert } from "lucide-react";
import { aiMotionRef } from "./motion";
import { searchProgressLabel, type TongpinAILiveThinking } from "./liveThinking";

/** Real tool progress and provider-published reasoning for the in-flight
 * reply. Rendered only from run events; nothing here is synthesized. */
export function LiveThinkingPanel({ thinking }: { thinking: TongpinAILiveThinking }) {
  const reasoning = thinking.reasoning.trim();
  return <div className="tp-ai-live-thinking" aria-live="polite" ref={aiMotionRef}>
    {thinking.searches.length ? <ol className="tp-ai-live-thinking__tools" aria-label="联网搜索进度" ref={aiMotionRef}>
      {thinking.searches.map(search => <li key={search.callId} className={`is-${search.status}`}>
        {search.status === "completed" ? <CheckCircle2 size={14} aria-hidden="true" />
          : search.status === "failed" ? <TriangleAlert size={14} aria-hidden="true" />
          : <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />}
        <Globe size={14} aria-hidden="true" />
        <span>联网搜索{search.query ? <>：<q>{search.query}</q></> : null}</span>
        <small>{searchProgressLabel(search)}</small>
      </li>)}
    </ol> : null}
    {reasoning ? <details className="tp-ai-analysis-summary tp-ai-live-thinking__reasoning">
      <summary>思考摘要</summary>
      <p>{reasoning}</p>
    </details> : null}
  </div>;
}
