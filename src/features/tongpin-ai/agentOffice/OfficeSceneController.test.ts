import { Container } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { OfficeSceneController, type SceneEnvelope, type SceneFigure, type SceneHost } from "./OfficeSceneController";
import type { EmployeeFigureOptions } from "./EmployeeFigure";
import type { AgentOfficeSnapshot } from "./types";

// Pixi's real Container.addChild() expects an actual display-object-shaped
// child at runtime (it wires up parent/emit internals), so a fake figure's
// `container` needs to be a real (but otherwise empty and DOM-free) Pixi
// Container — constructing one needs no canvas/WebGL/DOM, unlike Text.

// Real EmployeeFigure/backdrop construction needs a loaded sprite-texture
// cache (see spriteSheets.ts) and, for EmployeeFigure's Text labels, a DOM to
// measure on (this repo's vitest runs in a plain Node environment, no
// jsdom). So these tests exercise the controller's own orchestration —
// mount/update/dispose, idempotent snapshots, one-shot animation events —
// against fake figures, a fake backdrop and a fake host, never a real
// Application/canvas/WebGL context or loaded textures.

function fakeHost() {
  const tickHandlers = new Set<() => void>();
  const stageChildren: unknown[] = [];
  let destroyed = false;
  const host: SceneHost = {
    stage: {
      addChild: (child) => { stageChildren.push(child); },
      removeChild: (child) => {
        const i = stageChildren.indexOf(child);
        if (i >= 0) stageChildren.splice(i, 1);
      },
    },
    ticker: {
      add: (cb) => { tickHandlers.add(cb); },
      remove: (cb) => { tickHandlers.delete(cb); },
      start: vi.fn(() => {}),
      stop: vi.fn(() => {}),
    },
    resize: vi.fn(() => {}),
    destroy: vi.fn(() => { destroyed = true; }),
  };
  return { host, tickHandlers, stageChildren, isDestroyed: () => destroyed };
}

function fakeFigure(_opts?: EmployeeFigureOptions): SceneFigure & { destroy: ReturnType<typeof vi.fn> } {
  return {
    container: new Container(),
    applyVisualState: vi.fn(),
    setCaption: vi.fn(),
    setBubble: vi.fn(),
    setLabel: vi.fn(),
    getAnchor: vi.fn(() => ({ x: 0, y: 0 })),
    playFlourish: vi.fn(),
    update: vi.fn(),
    destroy: vi.fn(() => {}),
  };
}

function fakeEnvelope(): SceneEnvelope & { destroy: ReturnType<typeof vi.fn> } {
  return { container: new Container(), update: vi.fn(() => true), destroy: vi.fn(() => {}) };
}

/** A plain empty Pixi Container stands in for the real sprite-based backdrop
 *  (buildOfficeBackdrop) — same reasoning as fakeFigure/fakeEnvelope's
 *  `.container` above, just for the one the controller builds itself. */
const fakeBackdrop = () => new Container();

function snap(overrides: Partial<AgentOfficeSnapshot> = {}): AgentOfficeSnapshot {
  return {
    runId: "run-1",
    phase: "working",
    coordinator: { name: "Pro 协调", status: "working" },
    workers: [],
    updatedAt: 1,
    ...overrides,
  };
}

describe("OfficeSceneController", () => {
  it("wires exactly one ticker handler on construction", () => {
    const { host, tickHandlers } = fakeHost();
    const controller = new OfficeSceneController(host, { deps: { createBackdrop: fakeBackdrop, createFigure: fakeFigure, createEnvelope: fakeEnvelope } });
    expect(tickHandlers.size).toBe(1);
    controller.dispose();
  });

  it("creates the coordinator once and reuses it across snapshots", () => {
    const { host } = fakeHost();
    const createFigure = vi.fn(fakeFigure);
    const controller = new OfficeSceneController(host, { deps: { createBackdrop: fakeBackdrop, createFigure, createEnvelope: fakeEnvelope } });
    controller.applySnapshot(snap());
    controller.applySnapshot(snap({ updatedAt: 2 }));
    const coordinatorCalls = createFigure.mock.calls.filter(([opts]) => opts?.kind === "coordinator");
    expect(coordinatorCalls).toHaveLength(1);
    controller.dispose();
  });

  it("creates one figure per worker, and only recreates them when the id set changes", () => {
    const { host } = fakeHost();
    const createFigure = vi.fn(fakeFigure);
    const controller = new OfficeSceneController(host, { deps: { createBackdrop: fakeBackdrop, createFigure, createEnvelope: fakeEnvelope } });
    const workers: AgentOfficeSnapshot["workers"] = [
      { id: "w1", role: "研究员", task: "t", status: "queued" },
      { id: "w2", role: "分析员", task: "t", status: "queued" },
    ];
    controller.applySnapshot(snap({ workers }));
    controller.applySnapshot(snap({ workers, updatedAt: 2 })); // same ids → no rebuild
    const workerCalls = createFigure.mock.calls.filter(([opts]) => opts?.kind === "worker");
    expect(workerCalls).toHaveLength(2);
    controller.dispose();
  });

  it("is idempotent for a repeated, identical snapshot: no duplicate envelopes or flourishes", () => {
    const { host } = fakeHost();
    const createEnvelope = vi.fn(fakeEnvelope);
    const controller = new OfficeSceneController(host, { deps: { createBackdrop: fakeBackdrop, createFigure: fakeFigure, createEnvelope } });
    const workers: AgentOfficeSnapshot["workers"] = [{ id: "w1", role: "研究员", task: "t", status: "queued" }];
    const first = snap({ phase: "dispatching", workers });
    controller.applySnapshot(first);
    expect(createEnvelope).toHaveBeenCalledTimes(1); // dispatch envelope for w1

    const second = snap({ phase: "dispatching", workers, updatedAt: 2 });
    controller.applySnapshot(second);
    expect(createEnvelope).toHaveBeenCalledTimes(1); // not fired again

    controller.applySnapshot(second); // literally the same object again
    expect(createEnvelope).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("spawns a dispatch envelope for a newly-appearing worker", () => {
    const { host } = fakeHost();
    const createEnvelope = vi.fn(fakeEnvelope);
    const controller = new OfficeSceneController(host, { deps: { createBackdrop: fakeBackdrop, createFigure: fakeFigure, createEnvelope } });
    controller.applySnapshot(snap({ phase: "dispatching", workers: [{ id: "w1", role: "研究员", task: "t", status: "queued" }] }));
    expect(createEnvelope).toHaveBeenCalledWith(expect.anything(), expect.anything(), "dispatch", false);
    controller.dispose();
  });

  it("celebrates every current worker exactly once on entering the done phase", () => {
    const { host } = fakeHost();
    const coordinatorFigure = fakeFigure();
    const workerFigures = new Map([["w1", fakeFigure()], ["w2", fakeFigure()]]);
    const createFigure = vi.fn((opts: EmployeeFigureOptions) =>
      opts.kind === "coordinator" ? coordinatorFigure : workerFigures.get(opts.id)!);
    const controller = new OfficeSceneController(host, { deps: { createBackdrop: fakeBackdrop, createFigure, createEnvelope: fakeEnvelope } });
    const workers: AgentOfficeSnapshot["workers"] = [
      { id: "w1", role: "研究员", task: "t", status: "done" },
      { id: "w2", role: "撰稿员", task: "t", status: "done" },
    ];
    controller.applySnapshot(snap({ phase: "synthesizing", workers }));
    controller.applySnapshot(snap({ phase: "done", workers, updatedAt: 2 }));
    for (const figure of workerFigures.values()) expect(figure.playFlourish).toHaveBeenCalledWith("success", false);
    expect(coordinatorFigure.playFlourish).not.toHaveBeenCalled(); // only workers celebrate
    controller.dispose();
  });

  it("respects reducedMotion: envelopes and flourishes are created/played as instant", () => {
    const { host } = fakeHost();
    const createEnvelope = vi.fn(fakeEnvelope);
    const controller = new OfficeSceneController(host, { reducedMotion: true, deps: { createBackdrop: fakeBackdrop, createFigure: fakeFigure, createEnvelope } });
    controller.applySnapshot(snap({ phase: "dispatching", workers: [{ id: "w1", role: "研究员", task: "t", status: "queued" }] }));
    expect(createEnvelope).toHaveBeenCalledWith(expect.anything(), expect.anything(), "dispatch", true);
    controller.dispose();
  });

  it("dispose() cleans up: ticker handler removed, every figure and envelope destroyed exactly once, host destroyed", () => {
    const { host, tickHandlers, isDestroyed } = fakeHost();
    const figure = fakeFigure();
    const envelope = fakeEnvelope();
    let envelopeReturned = false;
    const createEnvelope = vi.fn(() => { envelopeReturned = true; return envelope; });
    const createFigure = vi.fn(() => figure);
    const controller = new OfficeSceneController(host, { deps: { createBackdrop: fakeBackdrop, createFigure, createEnvelope } });
    controller.applySnapshot(snap({ phase: "dispatching", workers: [{ id: "w1", role: "研究员", task: "t", status: "queued" }] }));
    expect(envelopeReturned).toBe(true);

    controller.dispose();

    expect(tickHandlers.size).toBe(0);
    expect(figure.destroy).toHaveBeenCalledTimes(2); // coordinator + w1, same fake instance here
    expect(envelope.destroy).toHaveBeenCalledTimes(1);
    expect(isDestroyed()).toBe(true);
  });

  it("dispose() is idempotent and a post-dispose snapshot is a safe no-op", () => {
    const { host } = fakeHost();
    const createFigure = vi.fn(fakeFigure);
    const controller = new OfficeSceneController(host, { deps: { createBackdrop: fakeBackdrop, createFigure, createEnvelope: fakeEnvelope } });
    controller.applySnapshot(snap());
    controller.dispose();
    const callsBeforeSecondDispose = createFigure.mock.calls.length;
    expect(() => controller.dispose()).not.toThrow();
    expect(() => controller.applySnapshot(snap({ updatedAt: 99 }))).not.toThrow();
    expect(createFigure.mock.calls.length).toBe(callsBeforeSecondDispose); // no new figures after disposal
  });

  it("many controllers mounting and unmounting leak nothing: every created figure/envelope is destroyed", () => {
    const createdFigures: ReturnType<typeof fakeFigure>[] = [];
    const createdEnvelopes: ReturnType<typeof fakeEnvelope>[] = [];
    for (let i = 0; i < 8; i++) {
      const { host, tickHandlers } = fakeHost();
      const controller = new OfficeSceneController(host, {
        deps: {
          createBackdrop: fakeBackdrop,
          createFigure: () => { const f = fakeFigure(); createdFigures.push(f); return f; },
          createEnvelope: () => { const e = fakeEnvelope(); createdEnvelopes.push(e); return e; },
        },
      });
      controller.applySnapshot(snap({
        phase: "dispatching",
        workers: [{ id: `w${i}`, role: "研究员", task: "t", status: "queued" }],
      }));
      controller.dispose();
      expect(tickHandlers.size).toBe(0);
    }
    expect(createdFigures.length).toBeGreaterThan(0);
    for (const f of createdFigures) expect(f.destroy).toHaveBeenCalledTimes(1);
    for (const e of createdEnvelopes) expect(e.destroy).toHaveBeenCalledTimes(1);
  });

  it("passes the camera's current scale into every figure's update() on tick", () => {
    const { host, tickHandlers } = fakeHost();
    const figure = fakeFigure();
    const createFigure = vi.fn(() => figure);
    const controller = new OfficeSceneController(host, { deps: { createBackdrop: fakeBackdrop, createFigure, createEnvelope: fakeEnvelope } });
    controller.applySnapshot(snap({ workers: [{ id: "w1", role: "研究员", task: "t", status: "queued" }] }));
    for (const cb of tickHandlers) cb();
    expect(figure.update).toHaveBeenCalledWith(expect.any(Number), false, expect.any(Number));
    controller.dispose();
  });

  it("rebuilds the backdrop and every figure when setSize's measured width changes the chosen world width", () => {
    const { host } = fakeHost();
    const createBackdrop = vi.fn(fakeBackdrop);
    const createFigure = vi.fn(fakeFigure);
    const controller = new OfficeSceneController(host, { deps: { createBackdrop, createFigure, createEnvelope: fakeEnvelope } });
    const workers: AgentOfficeSnapshot["workers"] = [{ id: "w1", role: "研究员", task: "t", status: "queued" }];
    controller.applySnapshot(snap({ workers }));
    const backdropCallsBefore = createBackdrop.mock.calls.length;
    const figureCallsBefore = createFigure.mock.calls.length;

    controller.setSize(696, 510); // 696 CSS px → world width 688, different from the 640 default
    expect(createBackdrop.mock.calls.length).toBeGreaterThan(backdropCallsBefore);
    expect(createFigure.mock.calls.length).toBeGreaterThan(figureCallsBefore); // coordinator + w1 recreated

    const workerCalls = createFigure.mock.calls.filter(([opts]) => opts?.kind === "worker");
    expect(workerCalls).toHaveLength(2); // once before the rebuild, once after
    controller.dispose();
  });

  it("does not rebuild when setSize's measured width doesn't change the chosen world width", () => {
    const { host } = fakeHost();
    const createBackdrop = vi.fn(fakeBackdrop);
    const controller = new OfficeSceneController(host, { deps: { createBackdrop, createFigure: fakeFigure, createEnvelope: fakeEnvelope } });
    const callsAfterConstruction = createBackdrop.mock.calls.length;
    controller.setSize(640, 510); // matches the constructor's own default world width (640) exactly
    expect(createBackdrop.mock.calls.length).toBe(callsAfterConstruction);
    controller.dispose();
  });

  it("setPaused starts/stops the host ticker", () => {
    const { host } = fakeHost();
    const controller = new OfficeSceneController(host, { deps: { createBackdrop: fakeBackdrop, createFigure: fakeFigure, createEnvelope: fakeEnvelope } });
    controller.setPaused(true);
    expect(host.ticker.stop).toHaveBeenCalledTimes(1);
    controller.setPaused(false);
    expect(host.ticker.start).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});
