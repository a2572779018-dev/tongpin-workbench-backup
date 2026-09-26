import { describe, expect, it } from "vitest";
import { parseOpenSquillaRouteDecision } from "../../../../shared/aiOpenSquilla";
import type { OpenSquillaRouterInput, OpenSquillaRouterResult } from "./engine";
import { LightGbmModel, type LightGbmLayout } from "./lightgbm";
import type { GatewayPolicyConfig, TextTier } from "./policy";
import { OpenSquillaInputError, OpenSquillaRoutingService, validateRouteInput } from "./routerService";

const policy = { routing_history_window_seconds: 1800, max_routing_history: 5 } as GatewayPolicyConfig;

function result(tier: TextTier, overrides: Partial<OpenSquillaRouterResult> = {}): OpenSquillaRouterResult {
  const routeClass = (`R${tier.slice(1)}`) as OpenSquillaRouterResult["routeClass"];
  const probabilities: [number, number, number, number] = [0.1, 0.1, 0.1, 0.1];
  probabilities[Number(tier.slice(1))] = 0.7;
  return {
    routeClass, tier, probabilities, confidence: 0.7, margin: 0.6, difficulty: 1.23456789,
    flags: { high_risk: false, long_context: false, debug: true, repo_arch: false, strict_format: false },
    thinkingMode: "T1", promptPolicy: "P1",
    postprocess: {} as OpenSquillaRouterResult["postprocess"],
    gateway: { tier, thinkingMode: "T1", promptPolicy: "P1", confidenceGateApplied: false, complaintTerms: [], complaintUpgradeApplied: false, antiDowngradeApplied: tier === "c3", previousTier: null },
    intermediates: {} as OpenSquillaRouterResult["intermediates"],
    ...overrides,
  };
}

function service(tiers: TextTier[], clock: { now: number }) {
  const seen: OpenSquillaRouterInput[] = [];
  let index = 0;
  const engine = {
    manifest: { gatewayPolicy: policy } as never,
    async route(input: OpenSquillaRouterInput) { seen.push(structuredClone(input)); return result(tiers[Math.min(index++, tiers.length - 1)]); },
  };
  return { router: new OpenSquillaRoutingService(engine, "0123456789ab", () => clock.now), seen };
}

const input = (message: string, extra: Record<string, unknown> = {}) => ({ conversationId: "conversation-a", message, historyUserTexts: [], prevAssistantText: null, prevAssistantOutputTokens: null, ...extra });

describe("desktop OpenSquilla routing session", () => {
  it("returns a bounded decision the server contract accepts", async () => {
    const { router } = service(["c3"], { now: 1_000_000 });
    const decision = await router.route(input("设计一个多租户架构"));
    expect(parseOpenSquillaRouteDecision(decision)).toEqual(decision);
    expect(decision).toMatchObject({ router: "opensquilla", version: "v4.2-phase3", bundle: "0123456789ab", routeClass: "R3", tier: "c3", confidence: 0.7, difficulty: 1.2346, flags: ["debug"], gates: ["anti_downgrade"] });
  });

  it("keeps OpenSquilla's per-conversation history: five entries, 30-minute window, real ages", async () => {
    const clock = { now: 1_000_000 };
    const { router, seen } = service(["c0", "c1", "c2", "c3", "c1", "c0", "c2"], clock);
    for (let turn = 0; turn < 7; turn += 1) { await router.route(input(`turn ${turn}`)); clock.now += 60_000; }
    expect(seen[0].routingHistory).toEqual([]);
    expect(seen[6].routingHistory).toHaveLength(5);
    expect(seen[6].routingHistory.map(entry => entry.finalTier)).toEqual(["c1", "c2", "c3", "c1", "c0"]);
    expect(seen[6].routingHistory.at(-1)).toMatchObject({ routeClass: "R0", finalRouteClass: "R0", ageSeconds: 60, difficulty: 1.23456789 });
    // Another conversation starts cold; an idle conversation expires after 30 minutes.
    await router.route(input("hello", { conversationId: "conversation-b" }));
    expect(seen[7].routingHistory).toEqual([]);
    clock.now += 31 * 60_000;
    await router.route(input("later"));
    expect(seen[8].routingHistory).toEqual([]);
  });

  it("passes OpenSquilla's context fields and only a positive output token count", async () => {
    const { router, seen } = service(["c1"], { now: 5 });
    await router.route(input("继续", { historyUserTexts: ["写一个故事", ""], prevAssistantText: "从前……", prevAssistantOutputTokens: 0 }));
    await router.route(input("继续", { prevAssistantText: "从前……", prevAssistantOutputTokens: 812 }));
    expect(seen[0]).toMatchObject({ historyUserTexts: ["写一个故事"], prevAssistantText: "从前……", prevAssistantUsage: null });
    expect(seen[1].prevAssistantUsage).toEqual({ output_tokens: 812 });
  });

  it("warms up without touching history and serializes concurrent requests", async () => {
    const clock = { now: 0 };
    const { router, seen } = service(["c0", "c2", "c1"], clock);
    await router.warmup();
    const [a, b] = await Promise.all([router.route(input("a")), router.route(input("b"))]);
    expect([a.tier, b.tier]).toEqual(["c2", "c1"]);
    expect(seen[2].routingHistory.map(entry => entry.finalTier)).toEqual(["c2"]);
  });

  it("rejects malformed or oversized input before inference", () => {
    const bad = [
      null, [], input("x", { extra: 1 }), input("x", { conversationId: "../etc" }), input("  "),
      input("x".repeat(24_001)), input("x", { historyUserTexts: ["a", "b", "c", "d", "e"] }),
      input("x", { historyUserTexts: ["y".repeat(8001)] }), input("x", { prevAssistantText: 5 }),
      input("x", { prevAssistantOutputTokens: -1 }), input("x", { prevAssistantOutputTokens: 1.5 }),
    ];
    for (const value of bad) expect(() => validateRouteInput(value)).toThrow(OpenSquillaInputError);
    // Limits are code points, like OpenSquilla's character caps.
    expect(validateRouteInput(input("x", { historyUserTexts: ["\u{1f600}".repeat(8000)] })).historyUserTexts[0]).toHaveLength(16000);
  });
});

describe("LightGBM tree evaluator", () => {
  function model(decisionType: number, threshold: number): LightGbmModel {
    // Two classes, one stump each: feature 0 split; class 1 is a constant tree.
    const sections: Array<[keyof LightGbmLayout["sections"], ArrayLike<number>, string, number]> = [
      ["nodeOffsets", [0, 1, 1], "u4", 4], ["leafOffsets", [0, 2, 3], "u4", 4], ["splitFeature", [0], "u2", 2], ["decisionType", [decisionType], "u1", 1],
      ["leftChild", [-1], "i2", 2], ["rightChild", [-2], "i2", 2], ["threshold", [threshold], "f8", 8], ["leafValue", [1, -1, 0], "f8", 8],
    ];
    let offset = 0;
    const layout = { numClass: 2, numFeatures: 2, objective: "multiclass num_class:2", trees: 2, sections: {} } as LightGbmLayout;
    const chunks: Uint8Array[] = [];
    for (const [name, values, dtype, size] of sections) {
      const pad = (8 - (offset % 8)) % 8;
      chunks.push(new Uint8Array(pad)); offset += pad;
      const Ctor = { u4: Uint32Array, u2: Uint16Array, u1: Uint8Array, i2: Int16Array, f8: Float64Array }[dtype as "u4"];
      const array = new Ctor(values as ArrayLike<number>);
      chunks.push(new Uint8Array(array.buffer));
      layout.sections[name] = { offset, length: values.length, dtype };
      offset += values.length * size;
    }
    const bytes = new Uint8Array(offset);
    let cursor = 0;
    for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.length; }
    return new LightGbmModel(bytes, layout);
  }
  const raw = (m: LightGbmModel, value: number) => m.rawScores(Float32Array.of(value, 0))[0];

  it("follows LightGBM NumericalDecision for none, zero and NaN missing types", () => {
    const none = model(0b0010, 0.5);
    expect(raw(none, 0.5)).toBe(1);
    expect(raw(none, 0.50001)).toBe(-1);
    expect(raw(none, Number.NaN)).toBe(1); // NaN → 0.0 when missing type is not NaN
    const zeroRight = model(0b0100, -1); // missing=zero, default right
    expect(raw(zeroRight, 0)).toBe(-1);
    expect(raw(zeroRight, -2)).toBe(1);
    const nanLeft = model(0b1010, -1); // missing=NaN, default left
    expect(raw(nanLeft, Number.NaN)).toBe(1);
    expect(raw(nanLeft, 0)).toBe(-1);
  });

  it("returns the multiclass softmax and rejects categorical splits", () => {
    const probabilities = model(0b0010, 0.5).predict(Float32Array.of(0, 0));
    expect(probabilities[0]).toBeCloseTo(Math.exp(1) / (Math.exp(1) + 1), 12);
    expect(() => model(0b0011, 0.5)).toThrow("categorical");
  });
});
