import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { OpenSquillaRouterEngine, OpenSquillaRouterInput, OpenSquillaRouterResult } from "./engine";
import { loadOpenSquillaRouter } from "./nodeRuntime";
import type { RoutingHistoryEntry } from "./policy";

/*
 * Parity against scripts/opensquilla-router/make_reference.py: OpenSquilla's
 * own Python runtime (V4Phase3Strategy + RoutingPolicyEngine, onnxruntime
 * 1.30.0 on x86-64) over every routed turn of the reference conversations
 * (scripts/opensquilla-router/reference_cases.py; `fixture.turnCount`).
 */

const BUNDLE = fileURLToPath(new URL("../../../../electron/opensquilla-router/bundle", import.meta.url));
const UPSTREAM_COMMIT = "d27ba0e7ac452392b7c8e38f2f7f43cd5d6912c6";

interface FixtureTurn {
  routed: boolean;
  input: {
    message: string; historyUserTexts: string[]; prevAssistantText: string | null; prevAssistantUsage: Record<string, number> | null;
    routingHistory: Array<{ routeClass: RoutingHistoryEntry["routeClass"]; finalRouteClass: RoutingHistoryEntry["finalRouteClass"]; finalTier: RoutingHistoryEntry["finalTier"]; difficulty: number; margin: number; ageSeconds: number }>;
  };
  output?: {
    tokens: { current: number[]; history: number[]; assistant: number[] };
    historyText: string;
    features: string; rawBge: string;
    pMain: number[]; pAux: number[]; mlpLogits: number[]; pMlp: number[]; fused: number[];
    decision: { routeClass: string; margin: number; difficulty: number; flags: Record<string, boolean>; thinkingMode: string; promptPolicy: string };
    policy: { tier: string; thinkingMode: string; promptPolicy: string; confidenceGateApplied: boolean; complaintUpgradeApplied: boolean; antiDowngradeApplied: boolean; complaintTerms: string[] };
  };
}
interface Fixture { generator: { packages: Record<string, string>; bundleSha256: Record<string, string> }; turnCount: number; cases: Array<{ id: string; turns: FixtureTurn[] }> }

const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/reference-v4.2.json", import.meta.url), "utf8")) as Fixture;
const turns = fixture.cases.flatMap(item => item.turns.filter(turn => turn.routed).map(turn => ({ id: item.id, ...turn, output: turn.output! })));

function f32(base64: string): Float32Array {
  const bytes = Buffer.from(base64, "base64");
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
function input(turn: FixtureTurn): OpenSquillaRouterInput {
  return {
    message: turn.input.message,
    historyUserTexts: turn.input.historyUserTexts,
    prevAssistantText: turn.input.prevAssistantText,
    prevAssistantUsage: turn.input.prevAssistantUsage,
    routingHistory: turn.input.routingHistory.map(entry => ({ ...entry })),
  };
}
function maxAbs(a: ArrayLike<number>, b: ArrayLike<number>, from = 0, to = a.length): number {
  let max = 0;
  for (let index = from; index < to; index += 1) max = Math.max(max, Math.abs(a[index] - b[index]));
  return max;
}
function sameDecision(result: OpenSquillaRouterResult, expected: NonNullable<FixtureTurn["output"]>): boolean {
  return result.postprocess.routeClass === expected.decision.routeClass
    && result.tier === expected.policy.tier
    && result.thinkingMode === expected.policy.thinkingMode
    && result.promptPolicy === expected.policy.promptPolicy
    && JSON.stringify(result.flags) === JSON.stringify(expected.decision.flags)
    && result.gateway.confidenceGateApplied === expected.policy.confidenceGateApplied
    && result.gateway.complaintUpgradeApplied === expected.policy.complaintUpgradeApplied
    && result.gateway.antiDowngradeApplied === expected.policy.antiDowngradeApplied;
}
/** Distance of a reference decision to the nearest OpenSquilla threshold its
 * rules compare the fused distribution against (argmax, margin_upgrade 0.10,
 * r1_rescue 0.10, under_routing_safety 0.45, T1/P0 margin 0.4, T0 margin 0.5,
 * P0 difficulty 0.8, confidence gate 0.5 / 0.45). */
function boundaryDistance(fused: number[], routeClass: string): number {
  const sorted = [...fused].sort((a, b) => b - a);
  const margin = sorted[0] - sorted[1];
  const difficulty = fused[1] + 2 * fused[2] + 3 * fused[3];
  const confidence = fused[["R0", "R1", "R2", "R3"].indexOf(routeClass)];
  return Math.min(margin, Math.abs(margin - 0.10), Math.abs(margin - 0.4), Math.abs(margin - 0.5),
    Math.abs(fused[0] - fused[1] - 0.10), Math.abs(fused[2] + fused[3] - 0.45), Math.abs(difficulty - 0.8),
    Math.abs(confidence - 0.5), Math.abs(confidence - 0.45));
}

let engine: OpenSquillaRouterEngine;
beforeAll(async () => {
  engine = (await loadOpenSquillaRouter(BUNDLE)).engine;
}, 120_000);

describe("OpenSquilla V4.2 bundle provenance", () => {
  it("ships byte-identical upstream graphs and a manifest-verified converted bundle", () => {
    const manifest = JSON.parse(readFileSync(`${BUNDLE}/manifest.json`, "utf8"));
    expect(manifest.router).toMatchObject({ version: "v4.2", phase: "phase3", upstreamCommit: UPSTREAM_COMMIT, license: "Apache-2.0" });
    for (const [name, file] of Object.entries(manifest.files as Record<string, { sha256: string; bytes: number }>)) {
      const bytes = readFileSync(`${BUNDLE}/${name}`);
      expect(bytes.byteLength, name).toBe(file.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(file.sha256);
    }
    // The reference fixture was produced from the same upstream artifacts.
    for (const [converted, upstream] of [["bge.onnx", "bge_onnx/model.onnx"], ["mlp.onnx", "mlp/model.onnx"], ["tokenizer.json", "bge_onnx/tokenizer.json"]]) {
      expect(manifest.files[converted].sha256).toBe(fixture.generator.bundleSha256[upstream]);
      expect(manifest.router.upstreamSha256[upstream]).toBe(fixture.generator.bundleSha256[upstream]);
    }
    expect(fixture.generator.packages.onnxruntime).toBe("1.30.0");
    expect(fixture.turnCount).toBe(turns.length);
    expect(turns.length).toBeGreaterThanOrEqual(180);
  });
});

describe("OpenSquilla V4.2 TypeScript port — deterministic stages", () => {
  it("tokenizes every current, history and assistant text exactly like tokenizers 0.23.2", () => {
    for (const turn of turns) {
      expect(engine.tokenize(turn.input.message), turn.id).toEqual(turn.output.tokens.current);
      expect(engine.tokenize(turn.output.historyText), turn.id).toEqual(turn.output.tokens.history);
      expect(engine.tokenize(turn.input.prevAssistantText ?? ""), turn.id).toEqual(turn.output.tokens.assistant);
    }
  });

  it("reproduces features, both LightGBM heads and every decision when fed the reference embeddings", async () => {
    let maxPca = 0, maxFused = 0, maxMlp = 0, maxMain = 0, maxAux = 0;
    for (const turn of turns) {
      const result = await engine.route(input(turn), { rawEmbeddings: f32(turn.output.rawBge) });
      const expected = f32(turn.output.features);
      // Hand-crafted, TF-IDF/SVD, context, history, assistant, continuation and
      // reasoning channels are bit-exact; the PCA channel differs only by
      // float32 summation order.
      expect(maxAbs(result.intermediates.features, expected, 0, 179), turn.id).toBe(0);
      expect(maxAbs(result.intermediates.features, expected, 371, 390), turn.id).toBe(0);
      expect(result.intermediates.historyText).toBe(turn.output.historyText);
      maxPca = Math.max(maxPca, maxAbs(result.intermediates.features, expected, 179, 371));
      maxMain = Math.max(maxMain, maxAbs(result.intermediates.pMain, turn.output.pMain));
      maxAux = Math.max(maxAux, maxAbs(result.intermediates.pAux!, turn.output.pAux));
      maxMlp = Math.max(maxMlp, maxAbs(result.intermediates.pMlp, turn.output.pMlp));
      maxFused = Math.max(maxFused, maxAbs(result.intermediates.fused, turn.output.fused));
      expect(sameDecision(result, turn.output), turn.id).toBe(true);
    }
    expect(maxPca).toBeLessThan(5e-6);
    expect(maxMain).toBeLessThan(1e-9);
    expect(maxAux).toBeLessThan(1e-9);
    expect(maxMlp).toBeLessThan(5e-6);
    expect(maxFused).toBeLessThan(5e-6);
  }, 120_000);
});

describe("OpenSquilla V4.2 TypeScript port — end to end with onnxruntime-web", () => {
  it("agrees with OpenSquilla's Python runtime; every disagreement is a boundary case of the INT8 BGE numerics", async () => {
    let routeAgree = 0, tierAgree = 0, decisionAgree = 0, maxFused = 0, minCos = 1, cosSum = 0, cosCount = 0, nearBoundary = 0;
    const errors: number[] = [], mismatches: string[] = [];
    for (const turn of turns) {
      const result = await engine.route(input(turn));
      expect(result.intermediates.tokens[0]).toEqual(turn.output.tokens.current);
      const reference = f32(turn.output.rawBge);
      for (let text = 0; text < 3; text += 1) {
        let dot = 0;
        for (let k = 0; k < 512; k += 1) dot += reference[text * 512 + k] * result.intermediates.rawBge[text * 512 + k];
        minCos = Math.min(minCos, dot); cosSum += dot; cosCount += 1;
      }
      const error = maxAbs(result.intermediates.fused, turn.output.fused);
      errors.push(error); maxFused = Math.max(maxFused, error);
      const distance = boundaryDistance(turn.output.fused, turn.output.decision.routeClass);
      if (distance < 0.12) nearBoundary += 1;
      if (result.postprocess.routeClass === turn.output.decision.routeClass) routeAgree += 1;
      if (result.tier === turn.output.policy.tier) tierAgree += 1;
      if (sameDecision(result, turn.output)) decisionAgree += 1;
      else {
        mismatches.push(`${turn.id}: ${result.postprocess.routeClass}/${result.tier}/${result.thinkingMode}/${result.promptPolicy} vs ${turn.output.decision.routeClass}/${turn.output.policy.tier}/${turn.output.policy.thinkingMode}/${turn.output.policy.promptPolicy} (boundary ${distance.toFixed(3)})`);
        // Disagreements must sit next to a threshold: the embedding noise moves
        // the fused distribution by at most ~0.15 and far less on most turns.
        expect(distance, `${turn.id} is not a boundary case`).toBeLessThan(0.12);
      }
    }
    errors.sort((a, b) => a - b);
    const summary = {
      turns: turns.length, routeClassAgreement: routeAgree / turns.length, finalTierAgreement: tierAgree / turns.length,
      fullDecisionAgreement: decisionAgree / turns.length, medianFusedError: errors[Math.floor(errors.length / 2)],
      p95FusedError: errors[Math.floor(errors.length * 0.95)], maxFusedError: maxFused, meanEmbeddingCosine: cosSum / cosCount, minEmbeddingCosine: minCos,
      referenceTurnsNearABoundary: nearBoundary, mismatches,
    };
    console.info(`OpenSquilla parity ${JSON.stringify(summary)}`);
    expect(summary.routeClassAgreement).toBeGreaterThanOrEqual(0.95);
    expect(summary.finalTierAgreement).toBeGreaterThanOrEqual(0.97);
    expect(summary.meanEmbeddingCosine).toBeGreaterThan(0.998);
    expect(summary.minEmbeddingCosine).toBeGreaterThan(0.98);
    expect(summary.medianFusedError).toBeLessThan(0.01);
  }, 300_000);
});
