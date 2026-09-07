import { useEffect, useState } from "react";
import { TYPEWRITER_FRAME_MS, typewriterDuration, typewriterOffset } from "./chatPerformance";

/** Local reveal of an already received answer, not upstream network streaming. */
export function TypewriterText({ content }: { content: string }) {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const start = performance.now();
    const duration = typewriterDuration(content);
    let timer: number | undefined;
    let stopped = false;
    function tick() {
      if (stopped) return;
      const progress = preference.matches || document.hidden || duration === 0
        ? 1 : Math.min(1, (performance.now() - start) / duration);
      setOffset(typewriterOffset(content, progress));
      if (progress < 1) timer = window.setTimeout(tick, TYPEWRITER_FRAME_MS);
    }
    function finishWhenInactive() {
      if (!document.hidden && !preference.matches) return;
      stopped = true;
      window.clearTimeout(timer);
      setOffset(content.length);
    }
    tick();
    preference.addEventListener("change", finishWhenInactive);
    document.addEventListener("visibilitychange", finishWhenInactive);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      preference.removeEventListener("change", finishWhenInactive);
      document.removeEventListener("visibilitychange", finishWhenInactive);
    };
  }, [content]);
  return <>{content.slice(0, offset)}</>;
}
