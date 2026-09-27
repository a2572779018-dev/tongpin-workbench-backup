import { describe, expect, it } from "vitest";
import {
  characterIndexForRecipe,
  COORDINATOR_CHARACTER_INDEX,
  COORDINATOR_RECIPE_KEY,
  recipeForWorker,
  WORKER_CHARACTER_INDICES,
} from "./roster";

describe("recipeForWorker", () => {
  it("always returns one of the worker-eligible character indices", () => {
    for (const id of ["w1", "w2", "abc-123", "研究员-4", ""]) {
      expect(WORKER_CHARACTER_INDICES).toContain(recipeForWorker(id));
    }
  });

  it("is stable: the same id always gets the same look", () => {
    const id = "worker-42";
    expect(recipeForWorker(id)).toBe(recipeForWorker(id));
  });

  it("spreads different ids across more than one character (visual variety)", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `worker-${i}`);
    const looks = new Set(ids.map(recipeForWorker));
    expect(looks.size).toBeGreaterThan(1);
  });

  it("never assigns a worker the coordinator's exclusive character", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `worker-${i}`);
    for (const id of ids) expect(recipeForWorker(id)).not.toBe(COORDINATOR_CHARACTER_INDEX);
  });
});

describe("characterIndexForRecipe", () => {
  it("resolves the coordinator key to its reserved character index", () => {
    expect(characterIndexForRecipe(COORDINATOR_RECIPE_KEY)).toBe(COORDINATOR_CHARACTER_INDEX);
  });

  it("passes a worker's character index through unchanged", () => {
    for (const index of WORKER_CHARACTER_INDICES) expect(characterIndexForRecipe(index)).toBe(index);
  });
});
