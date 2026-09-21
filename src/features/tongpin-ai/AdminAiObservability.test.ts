import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("AI administrator observability", () => {
  it("labels alert occurrences as threshold hits instead of an error total", () => {
    const source = readFileSync(new URL("./AdminAiObservability.tsx", import.meta.url), "utf8");
    expect(source).toContain("本轮阈值命中 {alert.occurrences} 次");
    expect(source).not.toContain("{alert.message} · {alert.occurrences} 次");
  });
});
