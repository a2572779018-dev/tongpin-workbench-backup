// Assigns each worker one of the office's 6 CC0 character sprites (see
// spriteSheets.ts), independent of the Chinese role label the run data
// supplies. The assignment is a pure hash of the worker id, so the same
// worker keeps the same look across re-renders and snapshot updates without
// the office needing to remember anything.
//
// The coordinator gets its own, exclusive character — never handed to a
// worker — the same way the previous procedural-portrait roster reserved a
// distinct "coordinator" recipe outside the worker set (see
// THIRD_PARTY_NOTICES.md's Munder Difflin entry for that history). With only
// 6 sprites total, "its own" means one is set aside for the coordinator and
// workers hash across the remaining 5.

export type CharacterIndex = 0 | 1 | 2 | 3 | 4 | 5;
export const CHARACTER_COUNT = 6;

/** Character sprites available to workers — index 5 is reserved for the coordinator. */
export const WORKER_CHARACTER_INDICES: readonly CharacterIndex[] = [0, 1, 2, 3, 4];
export const COORDINATOR_CHARACTER_INDEX: CharacterIndex = 5;

export const COORDINATOR_RECIPE_KEY = "coordinator" as const;
export type RecipeKey = CharacterIndex | typeof COORDINATOR_RECIPE_KEY;

/** Resolve a RecipeKey (as stored on an EmployeeFigure) to the character
 *  sprite index it should render with. */
export function characterIndexForRecipe(recipe: RecipeKey): CharacterIndex {
  return recipe === COORDINATOR_RECIPE_KEY ? COORDINATOR_CHARACTER_INDEX : recipe;
}

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

export function recipeForWorker(id: string): CharacterIndex {
  const index = hashString(id) % WORKER_CHARACTER_INDICES.length;
  return WORKER_CHARACTER_INDICES[index];
}
