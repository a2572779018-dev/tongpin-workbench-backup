import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("../quick-task.css", import.meta.url)),
  "utf8",
);
const component = readFileSync(
  fileURLToPath(new URL("../components/QuickTaskPanel.tsx", import.meta.url)),
  "utf8",
);

const colors = {
  p0: { button: "#ff6b64", card: "#ff7770", label: "#ff5e57" },
  p1: { button: "#ffd3d0", card: "#ffd7d4", label: "#ffbfbb" },
  p2: { button: "#fff0a8", card: "#fff1ad", label: "#ffe56b" },
  p3: { button: "#dcecff", card: "#e2efff", label: "#bcd9ff" },
  p4: { button: "#ebe7df", card: "#ebe7df", label: "#d8d1c5" },
} as const;

describe("quick task priority appearance", () => {
  it("attaches the priority class to every horizontal selector button", () => {
    expect(component).toContain("className={`priority-${option}${");
  });

  it("keeps the selector, task card, and badge mapped to all five priorities", () => {
    for (const [priority, palette] of Object.entries(colors)) {
      expect(css).toContain(
        `.quick-task-priorities button.priority-${priority} {\n  background: ${palette.button};`,
      );
      expect(css).toContain(
        `.quick-task-item.priority-${priority} {\n  background: ${palette.card};`,
      );
      expect(css).toContain(
        `.quick-task-item.priority-${priority} .quick-task-priority-label {\n  background: ${palette.label};`,
      );
    }
    expect(css).toContain(
      ".quick-task-item.is-done {\n  background: #c9f3b2;",
    );
  });
});
