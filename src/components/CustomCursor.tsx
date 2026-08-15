import { useEffect, useRef } from "react";

const CURSOR_SIZE = 20;

function nearestRotation(current: number, target: number): number {
  const delta = ((target - current + 540) % 360) - 180;
  return current + delta;
}

export function CustomCursor() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const cursor = cursorRef.current;
    const arrow = arrowRef.current;
    if (!cursor || !arrow) return;

    const root = document.documentElement;
    const finePointer = window.matchMedia("(pointer: fine)");
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;
    let previousX = 0;
    let previousY = 0;
    let rotation = 0;
    let hasPosition = false;

    const hide = () => {
      cursor.classList.remove("custom-cursor--visible");
    };

    const paint = () => {
      frame = 0;
      if (!finePointer.matches) return;

      if (!hasPosition) {
        previousX = pointerX;
        previousY = pointerY;
        hasPosition = true;
      }

      const deltaX = pointerX - previousX;
      const deltaY = pointerY - previousY;
      if (!reducedMotion.matches && Math.hypot(deltaX, deltaY) > 0.5) {
        const targetRotation =
          (Math.atan2(deltaY, deltaX) * 180) / Math.PI + 90;
        rotation = nearestRotation(rotation, targetRotation);
        arrow.style.transform = `rotate(${rotation}deg)`;
      } else if (reducedMotion.matches) {
        arrow.style.transform = "rotate(0deg)";
      }

      cursor.style.transform = `translate3d(${
        pointerX - CURSOR_SIZE / 2
      }px, ${pointerY}px, 0)`;
      cursor.classList.add("custom-cursor--visible");
      previousX = pointerX;
      previousY = pointerY;
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (!frame) frame = window.requestAnimationFrame(paint);
    };

    const handlePointerLeave = (event: PointerEvent) => {
      if (event.relatedTarget === null) hide();
    };

    const syncCapabilities = () => {
      const enabled = finePointer.matches;
      root.classList.toggle("custom-cursor-enabled", enabled);
      root.classList.toggle(
        "custom-cursor-reduced-motion",
        enabled && reducedMotion.matches,
      );
      cursor.hidden = !enabled;
      hasPosition = false;
      if (!enabled) hide();
    };

    const handleVisibility = () => {
      if (document.hidden) hide();
    };

    syncCapabilities();
    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    document.addEventListener("pointerout", handlePointerLeave);
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", handleVisibility);
    finePointer.addEventListener("change", syncCapabilities);
    reducedMotion.addEventListener("change", syncCapabilities);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerout", handlePointerLeave);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", handleVisibility);
      finePointer.removeEventListener("change", syncCapabilities);
      reducedMotion.removeEventListener("change", syncCapabilities);
      root.classList.remove(
        "custom-cursor-enabled",
        "custom-cursor-reduced-motion",
      );
    };
  }, []);

  return (
    <div
      ref={cursorRef}
      className="custom-cursor"
      data-custom-cursor="arrow-pointer"
      hidden
      aria-hidden="true"
    >
      <svg
        ref={arrowRef}
        className="custom-cursor__arrow"
        viewBox="0 0 32 32"
      >
        <path
          d="M25,30a5.82,5.82,0,0,1-1.09-.17l-.2-.07-7.36-3.48a.72.72,0,0,0-.35-.08.78.78,0,0,0-.33.07L8.24,29.54a.66.66,0,0,1-.2.06,5.17,5.17,0,0,1-1,.15,3.6,3.6,0,0,1-3.29-5L12.68,4.2a3.59,3.59,0,0,1,6.58,0l9,20.74A3.6,3.6,0,0,1,25,30Z"
          fill="#f2f5f8"
        />
        <path
          d="M16,3A2.59,2.59,0,0,1,18.34,4.6l9,20.74A2.59,2.59,0,0,1,25,29a5.42,5.42,0,0,1-.86-.15l-7.37-3.48a1.84,1.84,0,0,0-.77-.17,1.69,1.69,0,0,0-.73.16l-7.4,3.31a5.89,5.89,0,0,1-.79.12,2.59,2.59,0,0,1-2.37-3.62L13.6,4.6A2.58,2.58,0,0,1,16,3m0-2h0A4.58,4.58,0,0,0,11.76,3.8L2.84,24.33A4.58,4.58,0,0,0,7,30.75a6.08,6.08,0,0,0,1.21-.17,1.87,1.87,0,0,0,.4-.13L16,27.18l7.29,3.44a1.64,1.64,0,0,0,.39.14A6.37,6.37,0,0,0,25,31a4.59,4.59,0,0,0,4.21-6.41l-9-20.75A4.62,4.62,0,0,0,16,1Z"
          fill="#111920"
        />
      </svg>
    </div>
  );
}

