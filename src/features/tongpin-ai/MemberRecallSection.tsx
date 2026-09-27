import { History } from "lucide-react";
import { useId, useState } from "react";
import type { AiMemoryRecallOverview } from "../../../shared/aiMemoryLearning";
import { recallDateLabel } from "./memberLearningClient";

/**
 * 「历史回忆」: how much of the member's own history can be recalled, and the
 * last few replies that used it (with the excerpts they were given).
 */
export function MemberRecallSection({ recall }: { recall: AiMemoryRecallOverview }) {
  const headingId = useId();
  const [open, setOpen] = useState<string | null>(null);
  return <section className="tp-ai-memory-store tp-ai-recall-store" aria-labelledby={headingId}>
    <header>
      <span><h3 id={headingId}><History size={15} aria-hidden="true" />历史回忆</h3><small>你问到以前聊过的内容时（比如“上次那个方案”），AI 会从你自己的其他对话里找出相关片段参考，并在回复下方注明。</small></span>
      <span className="tp-ai-memory-usage">{recall.indexedConversations.toLocaleString("zh-CN")} 段对话可回忆</span>
    </header>
    {!recall.enabled ? <p className="tp-ai-memory-empty">管理员未开启历史回忆。</p>
      : recall.pending ? <p className="tp-ai-memory-empty" role="status">正在整理你更早的对话，整理完成前可能回忆不全。</p> : null}
    {recall.recent.length ? <ul className="tp-ai-memory-entries tp-ai-recall-list" aria-label="最近的回忆">
      {recall.recent.map(event => {
        const titles = [...new Set(event.snippets.map(snippet => `《${snippet.conversationTitle}》`))].join("");
        const expanded = open === event.requestId;
        return <li key={event.requestId}>
          <button type="button" className="tp-ai-recall-event" aria-expanded={expanded} disabled={!event.snippets.length} onClick={() => setOpen(expanded ? null : event.requestId)}>
            <span>{recallDateLabel(new Date(Date.parse(event.at) + 8 * 60 * 60_000).toISOString().slice(0, 10))}</span>
            <strong>{event.count ? `找到 ${event.count} 段` : "没有找到相关对话"}</strong>
            {titles ? <small>{titles}</small> : null}
          </button>
          {expanded ? <ol className="tp-ai-recall-excerpts">
            {event.snippets.map((snippet, index) => <li key={index}>
              <small>《{snippet.conversationTitle}》· {recallDateLabel(snippet.date)} · {snippet.role === "user" ? "你说" : "同频 AI 回复"}</small>
              <p>{snippet.excerpt}</p>
            </li>)}
          </ol> : null}
        </li>;
      })}
    </ul> : recall.enabled ? <p className="tp-ai-memory-empty">还没有回忆过。可以试试问：“上次那个汇报模板再发我一下”。</p> : null}
  </section>;
}
