import { Container } from "pixi.js";
import { Camera } from "./Camera";
import { diffSnapshots, coordinatorCaptionText } from "./diff";
import { EmployeeFigure, type EmployeeFigureOptions } from "./EmployeeFigure";
import { MessageEnvelope, type EnvelopeKind } from "./MessageEnvelope";
import { bubbleTextForWorker, visualStateForStatus, type VisualState } from "./visualState";
import type { BubbleKind } from "./ToolBubble";
import { recipeForWorker, COORDINATOR_RECIPE_KEY } from "./roster";
import { chooseCameraScale, computeLayout, computeWorldWidth, WORLD_HEIGHT, WORLD_WIDTH } from "./seating";
import { buildOfficeBackdrop } from "./sceneDraw";
import type { AgentOfficeSnapshot } from "./types";

// Re-exported so AgentOfficeView's single dynamic `import("./OfficeSceneController")`
// can also reach the (async) texture loader — see spriteSheets.ts — without a
// second dynamic-import call site. AgentOfficeView awaits this right after
// the Pixi Application initializes and before constructing this controller,
// which is what makes every synchronous `getOfficeTextures()` call below (via
// EmployeeFigure -> Desk/CharacterSprite, and sceneDraw's buildOfficeBackdrop)
// safe.
export { loadOfficeTextures } from "./spriteSheets";

/**
 * The Pixi-facing half of the scene, decoupled from both `pixi.js`'s
 * `Application` type and React so it is unit-testable with a plain fake host
 * (see OfficeSceneController.test.ts) — no canvas, no WebGL, no jsdom.
 * `AgentOfficeView` adapts a real `Application` to this shape.
 */
export interface SceneTicker {
  add(cb: () => void): void;
  remove(cb: () => void): void;
  start(): void;
  stop(): void;
}
export interface SceneHost {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stage: { addChild(child: any): void; removeChild(child: any): void; sortableChildren?: boolean };
  ticker: SceneTicker;
  canvas?: EventTarget;
  resize(width: number, height: number): void;
  destroy(): void;
}

/** What the controller needs from one seated figure (coordinator or
 *  worker) — exactly EmployeeFigure's public surface, kept as its own
 *  interface so a test can inject a plain mock instead of a real one. Real
 *  EmployeeFigure construction needs a DOM (pixi Text measures on a scratch
 *  canvas; the bust texture comes from an actual <canvas>), which the
 *  render/DOM-fallback split means this controller must not assume. */
export interface SceneFigure {
  readonly container: unknown;
  applyVisualState(state: VisualState): void;
  setCaption(text: string | null, instant: boolean): void;
  setBubble(bubble: { kind: BubbleKind; text: string } | null, instant: boolean): void;
  setLabel(text: string): void;
  getAnchor(): { x: number; y: number };
  playFlourish(kind: "success" | "failure", reducedMotion: boolean): void;
  /** `cameraScale` is the camera's current on-screen scale (see Camera.ts's
   *  own `scale` getter) — used to counter-scale the name label/activity
   *  bubble so their text stays a constant, readable CSS size regardless of
   *  camera zoom (see EmployeeFigure.update()). */
  update(dt: number, reducedMotion: boolean, cameraScale: number): void;
  destroy(): void;
}
export interface SceneEnvelope {
  readonly container: unknown;
  update(dt: number): boolean;
  destroy(): void;
}
export interface OfficeSceneDeps {
  createFigure(opts: EmployeeFigureOptions): SceneFigure;
  createEnvelope(start: { x: number; y: number }, end: { x: number; y: number }, kind: EnvelopeKind, instant: boolean): SceneEnvelope;
  /** Builds the static floor/wall/decor backdrop. Its real implementation
   *  (buildOfficeBackdrop) reads sliced sprite textures synchronously (see
   *  spriteSheets.ts), so — like createFigure/createEnvelope — it is
   *  injectable purely so a test can supply a plain empty Container instead
   *  and never need a loaded texture, a canvas or WebGL. */
  createBackdrop(worldWidth: number): Container;
}
const defaultDeps: OfficeSceneDeps = {
  createFigure: (opts) => new EmployeeFigure(opts),
  createEnvelope: (start, end, kind, instant) => new MessageEnvelope(start, end, kind, instant),
  createBackdrop: (worldWidth) => buildOfficeBackdrop(worldWidth),
};

export interface OfficeSceneOptions {
  reducedMotion?: boolean;
  onHover?: (id: string | null) => void;
  onSelect?: (id: string) => void;
  /** Injectable for tests; defaults to Date.now(). */
  now?: () => number;
  /** Injectable for tests; defaults to the real Pixi-backed EmployeeFigure/MessageEnvelope. */
  deps?: Partial<OfficeSceneDeps>;
}

const ENVELOPE_LIFT = 6; // world px above a desk's anchor an envelope departs/arrives from

export class OfficeSceneController {
  private readonly host: SceneHost;
  private readonly deps: OfficeSceneDeps;
  private readonly world: Container;
  private backdrop: Container;
  private readonly camera: Camera;
  /** World width actually built into the current backdrop/layout — starts at
   *  the fixed fallback and is replaced by setSize()'s own measurement-driven
   *  choice (see computeWorldWidth) the first time it differs, rebuilding the
   *  backdrop and every figure at the new width (see rebuildWorld()). */
  private worldWidth = WORLD_WIDTH;
  private readonly now: () => number;
  private readonly onHover?: (id: string | null) => void;
  private readonly onSelect?: (id: string) => void;

  private coordinatorFigure: SceneFigure | null = null;
  private workerFigures = new Map<string, SceneFigure>();
  private workerIdsSignature = "";
  private envelopes: SceneEnvelope[] = [];

  private prevSnapshot: AgentOfficeSnapshot | null = null;
  private reducedMotion: boolean;
  private lastTick: number;
  private disposed = false;
  private readonly tickHandler = () => this.onTick();

  constructor(host: SceneHost, options: OfficeSceneOptions = {}) {
    this.host = host;
    this.deps = { ...defaultDeps, ...options.deps };
    this.reducedMotion = options.reducedMotion ?? false;
    this.now = options.now ?? (() => Date.now());
    this.onHover = options.onHover;
    this.onSelect = options.onSelect;

    this.world = new Container();
    this.world.sortableChildren = true;
    this.backdrop = this.deps.createBackdrop(this.worldWidth);
    this.backdrop.zIndex = -1;
    this.world.addChild(this.backdrop);
    host.stage.addChild(this.world);

    this.camera = new Camera(this.world, this.worldWidth, WORLD_HEIGHT);
    this.lastTick = this.now();
    host.ticker.add(this.tickHandler);
  }

  setSize(width: number, height: number): void {
    const desiredScale = chooseCameraScale(width);
    const desiredWorldWidth = computeWorldWidth(width, desiredScale);
    if (desiredWorldWidth !== this.worldWidth) this.rebuildWorld(desiredWorldWidth);
    this.camera.setViewSize(width, height);
    if (this.reducedMotion) this.camera.snapToFit();
  }

  /** Rebuilds the backdrop and every figure at `newWorldWidth` — needed
   *  because desk/decor positions (see seating.ts) are computed from the
   *  world's own width, not just measured and centered within it. Reapplies
   *  the last snapshot immediately after, so a live resize never drops
   *  visual state (status, bubbles, labels) — only their desk positions
   *  actually change. */
  private rebuildWorld(newWorldWidth: number): void {
    this.world.removeChild(this.backdrop);
    this.backdrop.destroy({ children: true });
    this.backdrop = this.deps.createBackdrop(newWorldWidth);
    this.backdrop.zIndex = -1;
    this.world.addChild(this.backdrop);

    this.coordinatorFigure?.destroy();
    this.coordinatorFigure = null;
    for (const figure of this.workerFigures.values()) figure.destroy();
    this.workerFigures.clear();
    this.workerIdsSignature = "";

    this.worldWidth = newWorldWidth;
    this.camera.setWorldSize(newWorldWidth, WORLD_HEIGHT);

    if (this.prevSnapshot) this.applySnapshot(this.prevSnapshot);
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) this.camera.snapToFit();
  }

  setPaused(paused: boolean): void {
    if (paused) this.host.ticker.stop();
    else this.host.ticker.start();
  }

  private ensureCoordinator(): SceneFigure {
    if (this.coordinatorFigure) return this.coordinatorFigure;
    const layout = computeLayout([], this.worldWidth);
    const figure = this.deps.createFigure({
      id: "__coordinator__",
      kind: "coordinator",
      recipe: COORDINATOR_RECIPE_KEY,
      // The on-desk label is always "协调员" per spec; the run's own
      // coordinator.name (whatever the multi-agent adapter calls it)
      // surfaces in the hover/click detail card instead, not here.
      label: "协调员",
      rect: layout.coordinator,
      onHover: this.onHover,
      onSelect: this.onSelect,
    });
    this.world.addChild(figure.container as never);
    this.coordinatorFigure = figure;
    return figure;
  }

  private ensureWorkers(next: AgentOfficeSnapshot): void {
    const ids = next.workers.map((w) => w.id);
    const signature = ids.join("|");
    if (signature === this.workerIdsSignature) return;

    for (const figure of this.workerFigures.values()) figure.destroy();
    this.workerFigures.clear();

    const layout = computeLayout(ids, this.worldWidth);
    for (const worker of next.workers) {
      const rect = layout.workers.get(worker.id);
      if (!rect) continue; // beyond the 6-worker layout budget; not rendered
      const figure = this.deps.createFigure({
        id: worker.id,
        kind: "worker",
        recipe: recipeForWorker(worker.id),
        label: worker.role,
        rect,
        onHover: this.onHover,
        onSelect: this.onSelect,
      });
      this.world.addChild(figure.container as never);
      this.workerFigures.set(worker.id, figure);
    }
    this.workerIdsSignature = signature;
  }

  private spawnEnvelope(kind: EnvelopeKind, workerId: string): void {
    const worker = this.workerFigures.get(workerId);
    const coordinator = this.coordinatorFigure;
    if (!worker || !coordinator) return;
    const c = coordinator.getAnchor();
    const w = worker.getAnchor();
    const start = kind === "dispatch" ? { x: c.x, y: c.y - ENVELOPE_LIFT } : { x: w.x, y: w.y - ENVELOPE_LIFT };
    const end = kind === "dispatch" ? { x: w.x, y: w.y - ENVELOPE_LIFT } : { x: c.x, y: c.y - ENVELOPE_LIFT };
    const envelope = this.deps.createEnvelope(start, end, kind, this.reducedMotion);
    this.world.addChild(envelope.container as never);
    this.envelopes.push(envelope);
  }

  /** Feed the latest run data in. Idempotent for repeated/identical
   *  snapshots: with nothing changed, diffSnapshots produces no events and
   *  every figure's applyVisualState()/setBubble() call is itself a no-op
   *  redraw of already-current state. */
  applySnapshot(next: AgentOfficeSnapshot): void {
    if (this.disposed) return;
    const coordinator = this.ensureCoordinator();
    this.ensureWorkers(next);

    const events = diffSnapshots(this.prevSnapshot, next);
    for (const event of events) {
      if (event.type === "dispatch") this.spawnEnvelope("dispatch", event.workerId);
      else if (event.type === "synthesize") this.spawnEnvelope("synthesize", event.workerId);
      else if (event.type === "workerFlourish") this.workerFigures.get(event.workerId)?.playFlourish(event.kind, this.reducedMotion);
      else if (event.type === "celebrate") for (const figure of this.workerFigures.values()) figure.playFlourish("success", this.reducedMotion);
    }

    coordinator.applyVisualState(visualStateForStatus(next.coordinator.status));
    coordinator.setCaption(coordinatorCaptionText(next.phase, next.coordinator.activity), this.reducedMotion);

    for (const worker of next.workers) {
      const figure = this.workerFigures.get(worker.id);
      if (!figure) continue;
      figure.applyVisualState(visualStateForStatus(worker.status));
      figure.setLabel(worker.role);
      figure.setBubble(bubbleTextForWorker(worker.status, worker.activity, worker.resultSummary), this.reducedMotion);
    }

    this.prevSnapshot = next;
  }

  private onTick(): void {
    const now = this.now();
    const dt = Math.min(0.25, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;

    this.camera.update();
    const cameraScale = this.camera.scale;
    this.coordinatorFigure?.update(dt, this.reducedMotion, cameraScale);
    for (const figure of this.workerFigures.values()) figure.update(dt, this.reducedMotion, cameraScale);

    for (let i = this.envelopes.length - 1; i >= 0; i--) {
      if (this.envelopes[i].update(dt)) {
        this.envelopes[i].destroy();
        this.envelopes.splice(i, 1);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host.ticker.remove(this.tickHandler);
    for (const envelope of this.envelopes) envelope.destroy();
    this.envelopes = [];
    for (const figure of this.workerFigures.values()) figure.destroy();
    this.workerFigures.clear();
    this.coordinatorFigure?.destroy();
    this.coordinatorFigure = null;
    this.backdrop.destroy({ children: true });
    this.world.destroy({ children: true });
    this.host.destroy();
  }
}
