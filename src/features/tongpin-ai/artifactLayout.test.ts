import { readFileSync } from "node:fs";
import postcss, { type AnyNode } from "postcss";
import { describe, expect, it } from "vitest";

// A stylesheet contract test, not a substitute for browser geometry QA. Read
// the real import order so the 981–1100px drawer/grid breakpoint gap cannot recur.
const sheets = ["tongpin-ai.css", "sidebar-layout.css", "chat-layout.css", "ai-metal-theme.css", "ai-capabilities.css"]
  .map(name => postcss.parse(readFileSync(new URL(name, import.meta.url), "utf8")));

function previewStyles(width: number) {
  const values: Record<string, string> = { position: "static" };
  for (const sheet of sheets) {
    sheet.walkRules(rule => {
      if (!rule.selectors.includes(".tp-ai-preview")) return;
      for (let ancestor: AnyNode | undefined = rule.parent; ancestor; ancestor = ancestor.parent) {
        if (ancestor.type !== "atrule" || ancestor.name !== "media") continue;
        const media = ancestor.params;
        if (/prefers-|hover|pointer/.test(media)) return;
        for (const match of media.matchAll(/\((max|min)-width:\s*(\d+)px\)/g)) {
          if (match[1] === "max" ? width > Number(match[2]) : width < Number(match[2])) return;
        }
      }
      rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
    });
  }
  return values;
}

describe("AI artifact responsive layout", () => {
  it.each([761, 980, 981, 1023, 1100])("keeps the preview outside grid flow at %ipx", width => {
    expect(previewStyles(width)).toMatchObject({ position: "absolute", top: "0", right: "0", bottom: "0" });
  });

  it.each([390, 760])("uses a full-height, full-width drawer at %ipx", width => {
    expect(previewStyles(width)).toMatchObject({ position: "absolute", inset: "0", width: "100%", "min-height": "0" });
  });

  it.each([1101, 1440])("retains the third-column preview on wide screens at %ipx", width => {
    expect(previewStyles(width).position).toBe("static");
  });
});
