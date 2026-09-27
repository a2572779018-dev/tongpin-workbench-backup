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
  /** How much of the content to render now (UTF-16 units). */
  visible: number;
  /** Still catching up with text that has arrived (the reply renders as live). */
  revealing: boolean;
}

/**
 * One reveal loop per reply: it reads the latest content from a ref, so a new
 * network flush never restarts it, and it stops once caught up. What the
 * reply shows when it mounts is shown at once (it eases in as a whole).
 */
export function useStreamReveal(content: string, streaming: boolean): StreamReveal {
  const streamedRef = useRef(streaming);
  if (streaming) streamedRef.current = true;
  const contentRef = useRef(content);
  contentRef.current = content;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const [shown, setShown] = useState(content.length);
  const shownRef = useRef(shown);
  const timerRef = useRef<number | undefined>(undefined);
  // What was rendered last: a reply rewritten rather than extended (the saved
  // text differs from the streamed one) is shown whole in that same render.
  const renderedRef = useRef({ content, visible: content.length });
  const rewritten = !content.startsWith(renderedRef.current.content.slice(0, Math.min(renderedRef.current.visible, content.length)));

  useEffect(() => () => { window.clearTimeout(timerRef.current); timerRef.current = undefined; }, []);
  useEffect(() => {
    if (!streamedRef.current) return;
    const done = () => { window.clearTimeout(timerRef.current); timerRef.current = undefined; };
    if (rewritten || prefersReducedMotion() || (typeof document !== "undefined" && document.hidden)) {
      done();
      if (shownRef.current !== content.length) { shownRef.current = content.length; setShown(content.length); }
      return;
    }
    if (shownRef.current >= content.length || timerRef.current !== undefined) return;
    const tick = () => {
      const text = contentRef.current;
      const next = nextRevealLength(text, Math.min(shownRef.current, text.length), streamingRef.current);
      shownRef.current = next;
      setShown(next);
      timerRef.current = next < text.length ? window.setTimeout(tick, STREAM_REVEAL_FRAME_MS) : undefined;
    };
    timerRef.current = window.setTimeout(tick, STREAM_REVEAL_FRAME_MS);
  }, [content, streaming, rewritten]);

  const visible = !streamedRef.current || rewritten ? content.length : Math.min(shown, content.length);
  renderedRef.current = { content, visible };
  return { visible, revealing: streamedRef.current && visible < content.length };
}
