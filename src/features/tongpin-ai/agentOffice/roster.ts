// Assigns each worker a visual "look" — original, generic office-staff
// recipes (see portraitEngine.ts), independent of the Chinese role label the
// run data supplies. The assignment is a pure hash of the worker id, so the
// same worker keeps the same face across re-renders and snapshot updates
// without the office needing to remember anything.

export type WorkerRecipeKey = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h";
export const WORKER_RECIPE_KEYS: readonly WorkerRecipeKey[] = ["a", "b", "c", "d", "e", "f", "g", "h"];
export const COORDINATOR_RECIPE_KEY = "coordinator" as const;
export type RecipeKey = WorkerRecipeKey | typeof COORDINATOR_RECIPE_KEY;

/** Small, stable string hash (FNV-1a-ish) — deterministic across platforms,
 *  which is all this needs (no cryptographic property required). */
function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function recipeForWorker(id: string): WorkerRecipeKey {
  const index = hashString(id) % WORKER_RECIPE_KEYS.length;
  return WORKER_RECIPE_KEYS[index];
}
