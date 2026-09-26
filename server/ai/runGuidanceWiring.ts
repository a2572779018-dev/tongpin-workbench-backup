import { COMPUTER_AGENT_LIMITS } from "../../shared/computerAgent";
import { computerRunGuidanceTarget, setComputerRunGuidanceHook } from "./computerExecutor";
import { MULTI_AGENT_GUIDANCE_LIMITS, setMultiAgentPendingGuidance } from "./multiAgentRun";
import { registerRunGuidanceTarget, takePendingGuidance } from "./runGuidance";
import type { AiStore } from "./storage";

/*
 * Connects the mid-run guidance store (steer, runGuidance.ts) to the two step
 * loops that were built separately from it: the Pro 多 Agent 协作 run and the
 * unified computer executor. Called wherever an AI service is created — the
 * Express server (createNodeAi) and the Worker (createWorkerAi) — with that
 * service's root store, so both runtimes behave the same.
 *
 * - A multi-agent run is keyed by its chat request id, whose harness run stays
 *   "running" until it settles, so the guidance route already treats it as an
 *   active target. At each checkpoint the run takes at most what it can carry
 *   (3 items, 600 characters in total).
 * - A computer run (`cr_…`) is neither a harness run nor a chat request:
 *   `computerRunGuidanceTarget` makes the route accept guidance while the run
 *   is planned/running. Each Jev decision takes at most 3 items of at most 300
 *   characters. Guidance refines the goal only; it never widens the desktop
 *   consent grant.
 *
 * Items a loop cannot carry whole stay pending: the steer client withdraws
 * them when the run ends and sends them as the follow-up turn instead, so a
 * supplement is never marked delivered after being cut short.
 */

const codePoints = (text: string) => Array.from(text).length;

/** Multi-agent: at most 3 items and 600 characters per checkpoint. */
export function multiAgentGuidanceFits(texts: readonly string[]): boolean {
  return texts.length <= MULTI_AGENT_GUIDANCE_LIMITS.items
    && texts.reduce((total, text) => total + codePoints(text), 0) <= MULTI_AGENT_GUIDANCE_LIMITS.codePoints;
}

/** Computer run: at most 3 items per decision, each within the per-item bound. */
export function computerGuidanceFits(texts: readonly string[]): boolean {
  return texts.length <= COMPUTER_AGENT_LIMITS.maxGuidance && texts.every(text => codePoints(text) <= COMPUTER_AGENT_LIMITS.maxGuidanceChars);
}

let computerTargetRegistered = false;

/** Registers the guidance hooks (and the computer-run guidance target) for `store`. */
export function wireRunGuidance(store: AiStore): void {
  setMultiAgentPendingGuidance(({ checkpoint, tenantId, userId, requestId }) =>
    takePendingGuidance(store.forTenant(tenantId), userId, requestId, { deliveredTo: `${requestId}:${checkpoint}`, fits: multiAgentGuidanceFits })
      .map(item => item.text));
  setComputerRunGuidanceHook(({ store: scoped, userId, runId, step }) =>
    takePendingGuidance(scoped, userId, runId, { deliveredTo: `${runId}_d${step}`, fits: computerGuidanceFits })
      .map(item => item.text));
  if (!computerTargetRegistered) {
    registerRunGuidanceTarget(computerRunGuidanceTarget);
    computerTargetRegistered = true;
  }
}
