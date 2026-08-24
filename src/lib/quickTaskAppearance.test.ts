import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("../quick-task.css", import.meta.url)),
  "utf8",
);
const normalizedCss = css.replace(/\r\n/g, "\n");
const component = readFileSync(
  fileURLToPath(new URL("../components/QuickTaskPanel.tsx", import.meta.url)),
  "utf8",
);

const colors = {
  p0: { card: "#ff7770", label: "#ff5e57" },
  p1: { card: "#ffd7d4", label: "#ffbfbb" },
  p2: { card: "#fff1ad", label: "#ffe56b" },
  p3: { card: "#e2efff", label: "#bcd9ff" },
  p4: { card: "#ebe7df", label: "#d8d1c5" },
} as const;

describe("quick task priority appearance", () => {
  it("keeps the horizontal selector yellow with a black selected state", () => {
    expect(component).toContain(
      'className={priority === option ? "is-selected" : ""}',
    );
    expect(normalizedCss).toContain("background: rgba(255, 253, 248, 0.56);");
    expect(normalizedCss).toContain(
      ".quick-task-priorities button.is-selected {\n  background: #171717;\n  color: #fffdf8;",
    );
  });

  it("keeps the task card and badge mapped to all five priorities", () => {
    for (const [priority, palette] of Object.entries(colors)) {
      expect(normalizedCss).toContain(
        `.quick-task-item.priority-${priority} {\n  background: ${palette.card};`,
      );
      expect(normalizedCss).toContain(
        `.quick-task-item.priority-${priority} .quick-task-priority-label {\n  background: ${palette.label};`,
      );
    }
    expect(normalizedCss).toContain(
      ".quick-task-item.is-done {\n  background: #c9f3b2;",
    );
  });
});
