import { useEffect, useRef, useState } from "react";
import {
  createOrbStateConfiguration,
  resolveOrbStateParams,
} from "./vendor/orb/src/orb-states";
import { stylePresets } from "./vendor/orb/src/presets";

const configuration = createOrbStateConfiguration(
  {
    style: "chromaticMetal",
    ...stylePresets.chromaticMetal,
    colorA: "#1050D1",
    colorB: "#D9E0F2",
    colorD: "#2F0EF1",
    shellInner: "#16205A",
    shellMid: "#396EEA",
    shellEdge: "#0828F7",
    sheenColor: "#0F18CC",
    specColor: "#1B5AEE",
    canvasColor: "#98AAF0",
    glowColor: "#0D4AD9",
  },
  0.65,
  0.22,
);

const stateParams = {
  idle: resolveOrbStateParams(configuration, "idle"),
  thinking: resolveOrbStateParams(configuration, "thinking"),
};

export interface TongpinOrbProps {
  active?: boolean;
  richMotion?: boolean;
  size?: number;
  className?: string;
}

/** Decorative AI identity. Only the caller's real request state activates it. */
export function TongpinOrb({
  active = false,
  richMotion = false,
  size = 48,
  className,
}: TongpinOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const activeRef = useRef(active);
  const [ready, setReady] = useState(false);
  activeRef.current = active;
  const resolvedSize = Number.isFinite(size)
    ? Math.max(16, Math.min(320, size))
    : 48;

  useEffect(() => {
    setReady(false);
    const canvas = canvasRef.current;
    const host = hostRef.current;
    // Capability is not consent: never warm up GPU drivers merely by opening AI.
    if (!richMotion || !canvas || !host || !navigator.gpu) return;

    const motionPreference = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    let mounted = true;
    let failed = false;
    let inViewport = typeof IntersectionObserver === "undefined";
    let generation = 0;
    let starting = false;
    let disposeRenderer: (() => void) | undefined;

    const stop = () => {
      generation += 1;
      starting = false;
      disposeRenderer?.();
      disposeRenderer = undefined;
      if (mounted) setReady(false);
    };

    const syncPlayback = () => {
      const bounds = host.getBoundingClientRect();
      const shouldRun =
        mounted &&
        !failed &&
        inViewport &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        !document.hidden &&
        !motionPreference.matches;
      if (!shouldRun) {
        stop();
        return;
      }
      if (disposeRenderer || starting) return;

      starting = true;
      const renderGeneration = ++generation;
      // The shader and GPU implementation are loaded only for visible, supported clients.
      void import("./vendor/orb/src/orb-renderer")
        .then(({ createOrbRenderer }) => {
          if (!mounted || generation !== renderGeneration) return;
          disposeRenderer = createOrbRenderer({
            canvas,
            getTarget: () => {
              const state = activeRef.current ? "thinking" : "idle";
              return {
                state,
                params: stateParams[state],
                activationDuration: configuration.activationDuration,
                transitionDuration: configuration.transitionDuration,
              };
            },
            onReady: () => {
              if (mounted && generation === renderGeneration) setReady(true);
            },
            onError: (error) => {
              if (!mounted || generation !== renderGeneration) return;
              if (import.meta.env.DEV)
                console.warn("[TongpinOrb] Static fallback:", error.message);
              failed = true;
              stop();
            },
          });
          starting = false;
        })
        .catch(() => {
          if (!mounted || generation !== renderGeneration) return;
          failed = true;
          stop();
        });
    };

    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            ([entry]) => {
              // A zero-sized hidden target can still report an edge intersection.
              inViewport = Boolean(
                entry?.isIntersecting &&
                entry.boundingClientRect.width > 0 &&
                entry.boundingClientRect.height > 0,
              );
              syncPlayback();
            },
            { threshold: 0 },
          );
    observer?.observe(host);
    // Layout-driven hiding need not cross an IntersectionObserver threshold.
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(syncPlayback);
    resizeObserver?.observe(host);
    window.addEventListener("resize", syncPlayback);
    document.addEventListener("visibilitychange", syncPlayback);
    motionPreference.addEventListener("change", syncPlayback);
    syncPlayback();

    return () => {
      mounted = false;
      observer?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncPlayback);
      document.removeEventListener("visibilitychange", syncPlayback);
      motionPreference.removeEventListener("change", syncPlayback);
      stop();
    };
  }, [richMotion]);

  return (
    <span
      ref={hostRef}
      className={["tp-ai-orb", className].filter(Boolean).join(" ")}
      aria-hidden="true"
      data-orb-state={active ? "thinking" : "idle"}
      data-orb-renderer={richMotion && ready ? "webgpu" : "fallback"}
      style={{
        width: resolvedSize,
        height: resolvedSize,
        position: "relative",
        display: "inline-grid",
        flexShrink: 0,
        placeItems: "center",
        pointerEvents: "none",
      }}
    >
      <img
        src="./app-icon.svg"
        alt=""
        draggable={false}
        width={resolvedSize}
        height={resolvedSize}
        style={{
          display: "block",
          position: "absolute",
          width: "76%",
          height: "76%",
          objectFit: "contain",
          opacity: richMotion && ready ? 0 : 1,
        }}
      />
      {richMotion && <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          opacity: ready ? 1 : 0,
        }}
      />}
    </span>
  );
}
