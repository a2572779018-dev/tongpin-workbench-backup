import { useEffect, useMemo, useRef, useState } from "react";
import type { Application } from "pixi.js";
import type { OfficeSceneController, SceneHost } from "./OfficeSceneController";
import { attemptLoadPixi } from "./loadStrategy";
import { installContextLossRecovery, planInitFailure, type InitFailurePlan } from "./glRecovery";
import { prefersReducedMotion } from "./motionPlan";
import { paletteHex } from "./palette";
import { buildFallbackRows } from "./fallbackModel";
import { AgentOfficeFallback } from "./AgentOfficeFallback";
import type { AgentOfficeSnapshot } from "./types";
import "./agentOffice.css";

export interface AgentOfficeViewProps {
  snapshot: AgentOfficeSnapshot;
  height?: number;
}

/**
 * The AI-employee office: a small Pixi.js scene of the coordinator and its
 * workers, seated at procedurally-drawn desks. pixi.js is loaded lazily (a
 * dynamic import, alongside the scene controller) so members who never open
 * a Pro multi-agent reply never pay for it in the main bundle. Falls back to
 * a static list (AgentOfficeFallback) when WebGL isn't available or its
 * context is lost and recovery gives up — see glRecovery.ts / loadStrategy.ts.
 *
 * Follows the same lazy-mount idiom as this feature's TongpinOrb.tsx:
 * IntersectionObserver + ResizeObserver + document.hidden pause the ticker
 * when the reply scrolls off-screen or the window is hidden, and a mount-id
 * guard discards any async result from a mount the effect has since torn
 * down.
 */
export function AgentOfficeView({ snapshot, height = 320 }: AgentOfficeViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<OfficeSceneController | null>(null);
  const appRef = useRef<Application | null>(null);
  const mountIdRef = useRef(0);
  const initRetriesRef = useRef(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const [mode, setMode] = useState<"canvas" | "fallback">("canvas");
  const [glGeneration, setGlGeneration] = useState(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "canvas") return;
    const host = hostRef.current;
    if (!host) return;

    const mountId = ++mountIdRef.current;
    let cancelled = false;
    let removeGlRecovery: (() => void) | undefined;
    let observer: IntersectionObserver | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const motionPreference = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    let inViewport = typeof IntersectionObserver === "undefined";

    const syncPaused = () => {
      const controller = controllerRef.current;
      if (!controller) return;
      const bounds = host.getBoundingClientRect();
      const visible = inViewport && bounds.width > 0 && bounds.height > 0 && !document.hidden;
      controller.setPaused(!visible);
    };
    const syncReducedMotion = () => {
      controllerRef.current?.setReducedMotion(prefersReducedMotion());
    };
    const syncSize = () => {
      const controller = controllerRef.current;
      if (!controller) return;
      const rect = host.getBoundingClientRect();
      controller.setSize(rect.width || 640, rect.height || height);
    };
    const scheduleRebuild = (delayMs: number, attempt: number) => {
      initRetriesRef.current = attempt;
      setTimeout(() => { if (mountIdRef.current === mountId) setGlGeneration((n) => n + 1); }, delayMs);
    };
    const applyPlan = (plan: InitFailurePlan): boolean => {
      // Returns true when the caller should stop (either retrying later or
      // having already fallen back) rather than continue booting.
      if (plan.action === "retry") { scheduleRebuild(plan.delayMs, plan.attempt); return true; }
      setMode("fallback");
      return true;
    };

    const loadPixi = () => Promise.all([import("pixi.js"), import("./OfficeSceneController")]);

    const boot = async () => {
      const attempt = await attemptLoadPixi(loadPixi, initRetriesRef.current);
      if (cancelled || mountIdRef.current !== mountId) return;
      if (!attempt.ok) { applyPlan(attempt.plan); return; }

      const [pixiModule, controllerModule] = attempt.module as [
        typeof import("pixi.js"),
        typeof import("./OfficeSceneController"),
      ];

      const app = new pixiModule.Application();
      try {
        await app.init({
          background: paletteHex.paper,
          antialias: false,
          roundPixels: true,
          resolution: Math.max(window.devicePixelRatio || 1, 2),
          autoDensity: true,
          width: host.clientWidth || 640,
          height: host.clientHeight || height,
        });
      } catch (err) {
        if (cancelled || mountIdRef.current !== mountId) return;
        applyPlan(planInitFailure(err, initRetriesRef.current));
        return;
      }
      if (cancelled || mountIdRef.current !== mountId) {
        try { app.destroy(true, { children: true }); } catch { /* noop */ }
        return;
      }

      appRef.current = app;
      while (host.firstChild) host.removeChild(host.firstChild);
      host.appendChild(app.canvas);

      removeGlRecovery = installContextLossRecovery(app.canvas, {
        onRebuild: () => { if (mountIdRef.current === mountId) setGlGeneration((n) => n + 1); },
        onGiveUp: () => { if (mountIdRef.current === mountId) setMode("fallback"); },
      });

      const sceneHost: SceneHost = {
        stage: app.stage,
        ticker: {
          add: (cb) => { app.ticker.add(cb); },
          remove: (cb) => { app.ticker.remove(cb); },
          start: () => app.ticker.start(),
          stop: () => app.ticker.stop(),
        },
        canvas: app.canvas,
        resize: (w, h) => app.renderer.resize(w, h),
        destroy: () => app.destroy(true, { children: true }),
      };
      const controller = new controllerModule.OfficeSceneController(sceneHost, {
        reducedMotion: prefersReducedMotion(),
        onHover: (id) => setHoveredId(id),
        onSelect: (id) => setSelectedId((current) => (current === id ? null : id)),
      });
      controllerRef.current = controller;
      initRetriesRef.current = 0;
      syncSize();
      controller.applySnapshot(snapshotRef.current);
      syncPaused();
    };

    void boot();

    observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(
      ([entry]) => {
        inViewport = Boolean(
          entry?.isIntersecting && entry.boundingClientRect.width > 0 && entry.boundingClientRect.height > 0,
        );
        syncPaused();
      },
      { threshold: 0 },
    );
    observer?.observe(host);
    resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      syncSize();
      syncPaused();
    });
    resizeObserver?.observe(host);
    document.addEventListener("visibilitychange", syncPaused);
    motionPreference?.addEventListener("change", syncReducedMotion);

    return () => {
      cancelled = true;
      mountIdRef.current++;
      observer?.disconnect();
      resizeObserver?.disconnect();
      document.removeEventListener("visibilitychange", syncPaused);
      motionPreference?.removeEventListener("change", syncReducedMotion);
      removeGlRecovery?.();
      if (controllerRef.current) {
        controllerRef.current.dispose(); // also destroys the Application via SceneHost.destroy()
        controllerRef.current = null;
      } else if (appRef.current) {
        try { appRef.current.ticker?.stop(); } catch { /* noop */ }
        try { appRef.current.destroy(true, { children: true }); } catch { /* noop */ }
      }
      appRef.current = null;
      while (host.firstChild) host.removeChild(host.firstChild);
    };
    // `snapshot` is deliberately excluded — the effect below feeds updates to
    // the already-mounted controller instead of remounting the whole scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, glGeneration, height]);

  useEffect(() => {
    controllerRef.current?.applySnapshot(snapshot);
  }, [snapshot]);

  const rows = useMemo(() => buildFallbackRows(snapshot), [snapshot]);
  const activeId = hoveredId ?? selectedId;
  const activeRow = activeId ? rows.find((row) => row.id === activeId) ?? null : null;

  if (mode === "fallback") {
    return <AgentOfficeFallback snapshot={snapshot} reason="no-webgl" />;
  }

  return (
    <div className="tp-ai-office">
      <div className="tp-ai-office__canvas-host" style={{ height }} ref={hostRef} />
      {activeRow ? (
        <div className="tp-ai-office-card" role="note">
          <div className="tp-ai-office-card__head">
            <strong>{activeRow.label}</strong>
            <span>{activeRow.statusText}</span>
            {activeRow.elapsedText ? <span className="tp-ai-office-card__elapsed">{activeRow.elapsedText}</span> : null}
          </div>
          {activeRow.task ? <p className="tp-ai-office-card__task">{activeRow.task}</p> : null}
          {activeRow.resultSummary ? (
            <p className="tp-ai-office-card__result">
              {activeRow.resultSummary}
              {typeof activeRow.sourceCount === "number" ? `（来源 ${activeRow.sourceCount} 条）` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
