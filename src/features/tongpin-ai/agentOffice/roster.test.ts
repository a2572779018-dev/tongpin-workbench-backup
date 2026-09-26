import { describe, expect, it } from "vitest";
import { recipeForWorker, WORKER_RECIPE_KEYS } from "./roster";

describe("recipeForWorker", () => {
  it("always returns one of the known worker recipe keys", () => {
    for (const id of ["w1", "w2", "abc-123", "研究员-4", ""]) {
      expect(WORKER_RECIPE_KEYS).toContain(recipeForWorker(id));
    }
  });

  it("is stable: the same id always gets the same look", () => {
    const id = "worker-42";
    expect(recipeForWorker(id)).toBe(recipeForWorker(id));
  });

  it("spreads different ids across more than one recipe (visual variety)", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `worker-${i}`);
    const looks = new Set(ids.map(recipeForWorker));
    expect(looks.size).toBeGreaterThan(1);
  });
});
