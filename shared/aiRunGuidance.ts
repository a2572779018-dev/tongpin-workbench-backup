/**
 * Mid-run guidance ("steer"): text a member adds while a multi-step AI run is
 * still working. The server keeps it pending for that run until the run's step
 * loop takes it right before its next model call. Browser-safe contract only.
 */
export const AI_RUN_GUIDANCE_LIMITS = Object.freeze({
  /** Accepted (pending or delivered) items per run. */
  itemsPerRun: 5,
  /** Unicode characters per item after trimming. */
  characters: 2000,
});

export type AiRunGuidanceStatus = "pending" | "delivered" | "cancelled";

/** POST /api/ai/requests/:requestId/guidance body. `id` is client-generated and
 * makes a retried POST idempotent. */
export interface AiRunGuidanceInput {
  id: string;
  text: string;
}

/** Public projection. The text itself is never echoed back. */
export interface AiRunGuidanceItem {
  id: string;
  status: AiRunGuidanceStatus;
  createdAt: number;
  deliveredAt?: number;
}
