import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./motion";

/**
 * Smooth reveal of a streaming reply. Answer deltas reach the page in bursts
 * (the server coalesces up to 256 characters or 80 ms, the page flushes every
 * 60 ms, some providers send whole paragraphs), so rendering each flush as it
 * lands makes the text jump. While a reply streams, the text on screen catches
 * up with what has arrived at a steady pace instead: a share of the backlog per
 * frame, with a small floor, finishing faster once the stream has ended.
 * History (a reply that was never seen streaming) is shown whole at once.
 */

export const STREAM_REVEAL_FRAME_MS = 32;
/** Share of the not-yet-shown text revealed per frame while the stream runs / after it ended. */
export const STREAM_REVEAL_SHARE = 0.22;
export const STREAM_FINISH_SHARE = 0.4;
const MIN_STEP = 2;

function highSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** The next revealed length (UTF-16 units): never splits a surrogate pair. */
export function nextRevealLength(content: string, shown: number, streaming: boolean): number {
  const backlog = content.length - shown;
  if (backlog <= 0) return content.length;
  const step = Math.max(MIN_STEP, Math.ceil(backlog * (streaming ? STREAM_REVEAL_SHARE : STREAM_FINISH_SHARE)));
  let next = Math.min(content.length, shown + step);
  if (next < content.length && highSurrogate(content.charCodeAt(next - 1))) next += 1;
  return next;
}

export interface StreamReveal {
  /** The text to render now. */
  text: string;
  /** Still catching up with text that has arrived (the reply renders as live). */
  revealing: boolean;
}

export function useStreamReveal(content: string, streaming: boolean): StreamReveal {
  const streamedRef = useRef(streaming);
  if (streaming) streamedRef.current = true;
  // What has already arrived when the reply mounts shows at once (it eases in
  // as a whole); only text that arrives afterwards is revealed.
  const [shown, setShown] = useState(content.length);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const previousRef = useRef(content);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = content;
    if (!streamedRef.current) return;
    // A reply rewritten rather than extended (e.g. the saved text differs from
    // the streamed one) is not replayed: show it as it is.
    if (!content.startsWith(previous.slice(0, Math.min(shownRef.current, content.length))) || shownRef.current >= content.length
      || prefersReducedMotion() || (typeof document !== "undefined" && document.hidden)) {
      if (shownRef.current !== content.length) { shownRef.current = content.length; setShown(content.length); }
      return;
    }
    let timer = window.setTimeout(function tick() {
      const next = nextRevealLength(content, shownRef.current, streaming);
      shownRef.current = next;
      setShown(next);
      if (next < content.length) timer = window.setTimeout(tick, STREAM_REVEAL_FRAME_MS);
    }, STREAM_REVEAL_FRAME_MS);
    return () => window.clearTimeout(timer);
  }, [content, streaming]);

  const visible = Math.min(shown, content.length);
  return { text: visible >= content.length ? content : content.slice(0, visible), revealing: streamedRef.current && visible < content.length };
}
