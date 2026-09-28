import type { AiObservabilityCapability } from "../../shared/ai";

/** End-to-end media generation includes provider queue/render time. Planning
 * still invokes a text model, so it always uses the text latency thresholds. */
export const AI_LATENCY_THRESHOLDS = {
  text: { warningMs: 60_000, criticalMs: 120_000 },
  image: { warningMs: 3 * 60_000, criticalMs: 6 * 60_000 },
  video: { warningMs: 15 * 60_000, criticalMs: 30 * 60_000 },
} as const;

export function aiLatencyThresholds(capability: AiObservabilityCapability, operation: string) {
  return operation === "execution" && (capability === "image" || capability === "video")
    ? AI_LATENCY_THRESHOLDS[capability]
    : AI_LATENCY_THRESHOLDS.text;
}
