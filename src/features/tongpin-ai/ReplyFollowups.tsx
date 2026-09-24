import { parseReplyFollowups } from "./replyRichBlocks";

/** A followup chip never sends anything and never authorizes a paid tool: it
 * only emits an event that the page turns into composer draft text. The draft
 * merge (append, never overwrite) lives with the composer state. */
const FOLLOWUP_SELECT_EVENT = "tongpin-ai:followup-select";

/** Render at most three suggestion chips from a validated ```followups block.
 * Returns null when the payload has no valid suggestions. */
export function ReplyFollowups({ body }: { body: string }) {
  const chips = parseReplyFollowups(body);
  if (!chips.length) return null;
  return <div className="tp-ai-followups" role="group" aria-label="追问建议">
    {chips.map(chip => (
      <button key={chip} type="button" onClick={() => {
        window.dispatchEvent(new CustomEvent<string>(FOLLOWUP_SELECT_EVENT, { detail: chip }));
      }}>{chip}</button>
    ))}
  </div>;
}
