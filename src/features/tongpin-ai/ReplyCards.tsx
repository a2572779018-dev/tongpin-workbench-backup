import { useMemo } from "react";
import { parseReplyCards, type ReplyCardTrend } from "./replyRichBlocks";

const TREND_LABELS: Record<ReplyCardTrend, string> = { up: "上升", down: "下降", flat: "持平" };

/** Direction glyph. Colour stays neutral on purpose: the block cannot say
 * whether "up" is good (revenue) or bad (cost), and red/green read in opposite
 * ways across markets, so direction is carried by shape + sign + text. */
function TrendMark({ trend }: { trend: ReplyCardTrend }) {
  const path = trend === "up" ? "M6 2.5 10 8.5H2z" : trend === "down" ? "M6 9.5 2 3.5h8z" : "M2 5.2h8v1.6H2z";
  return <svg className="tp-ai-card__trend" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d={path} /></svg>;
}

/** KPI / info cards from a validated ```cards block (at most six). Invalid
 * payloads never reach this component; MarkdownReply shows them as code. */
export function ReplyCards({ body }: { body: string }) {
  const cards = useMemo(() => parseReplyCards(body), [body]);
  if (!cards) return null;
  // The frame is a size container, so the grid can follow the reply column.
  return <div className="tp-ai-cards-frame"><ul className="tp-ai-cards" aria-label="指标卡片" data-count={cards.length}>
    {cards.map((card, index) => <li key={`${index}-${card.title}`} className="tp-ai-card">
      <span className="tp-ai-card__title">{card.title}</span>
      <span className="tp-ai-card__figure">
        <strong className="tp-ai-card__value">{card.value}</strong>
        {card.unit ? <span className="tp-ai-card__unit">{card.unit}</span> : null}
      </span>
      {card.delta || card.trend ? <span className={`tp-ai-card__delta${card.trend ? ` is-${card.trend}` : ""}`}>
        {card.trend ? <><TrendMark trend={card.trend} /><span className="sr-only">{TREND_LABELS[card.trend]}</span></> : null}
        {card.delta ? <span>{card.delta}</span> : null}
      </span> : null}
      {card.note ? <span className="tp-ai-card__note">{card.note}</span> : null}
    </li>)}
  </ul></div>;
}
