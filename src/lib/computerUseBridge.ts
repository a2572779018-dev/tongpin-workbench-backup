import type { ComputerUseBridge } from "../../shared/computerUse";

/**
 * The AI feature receives only the narrow, typed local bridge. Keeping global
 * desktop access here prevents computer-use state from sharing the AI request,
 * credential, quota or persistence boundary.
 */
export function getComputerUseBridge(): ComputerUseBridge | undefined {
  return typeof window === "undefined" ? undefined : window.tongpin?.computerUse;
}
