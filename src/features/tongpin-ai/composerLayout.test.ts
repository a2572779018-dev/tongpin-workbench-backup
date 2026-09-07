import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import postcss, { type AnyNode } from "postcss";
import { describe, expect, it } from "vitest";
import { ChatWorkspace } from "./ChatWorkspace";

const sheets = ["chat-layout.css", "generated-content.css"].map(name =>
  postcss.parse(readFileSync(new URL(name, import.meta.url), "utf8")),
);

// CSS contracts and rendered semantics only; browser focus/geometry QA is separate.
function styles(selector: string, width = 1280) {
  const values: Record<string, string> = {};
  for (const sheet of sheets) {
    sheet.walkRules(rule => {
      if (!rule.selectors.includes(selector)) return;
      for (let ancestor: AnyNode | undefined = rule.parent; ancestor; ancestor = ancestor.parent) {
        if (ancestor.type !== "atrule" || ancestor.name !== "media") continue;
        if (/prefers-|hover|pointer/.test(ancestor.params)) return;
        for (const match of ancestor.params.matchAll(/\((max|min)-width:\s*(\d+)px\)/g)) {
          if (match[1] === "max" ? width > Number(match[2]) : width < Number(match[2])) return;
        }
      }
      rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
    });
  }
  return values;
}

const noop = () => {};
function renderComposer(overrides: Partial<Parameters<typeof ChatWorkspace>[0]> = {}) {
  return renderToStaticMarkup(createElement(ChatWorkspace, {
    artifactById: new Map(), composerFocusRequest: 0, draft: "", enabledSkills: [],
    messages: [], mode: "quick", notificationUnread: 0, quotaInsufficient: false,
    responding: false, onDraftChange: noop, onModeChange: noop, onOpenArtifact: noop,
    onSubmit: noop, ...overrides,
  }));
}

describe("composer spacing and mode focus", () => {
  it.each([320, 390, 760, 1280])("insets capability chips with the input text at %ipx", width => {
    const composer = styles(".tp-ai-composer", width);
    const chips = styles(".tp-ai-composer > .tp-ai-composer-capabilities", width);
    const textarea = styles(".tp-ai-composer textarea", width);
    expect(composer["--tp-ai-composer-inset"]).toBe(width <= 760 ? "0.875rem" : "1rem");
    expect(chips.padding).toBe("0.875rem var(--tp-ai-composer-inset, 1rem) 0");
    expect(textarea.padding).toBe("1rem var(--tp-ai-composer-inset) 0.5rem");
    expect(chips).toMatchObject({ "flex-wrap": "wrap", "min-width": "0", margin: "0" });
    expect(styles(".tp-ai-composer-capabilities button")).toMatchObject({
      "max-width": "100%", "min-height": "32px", "overflow-wrap": "anywhere",
    });
  });

  it("replaces the native select focus box with a rounded keyboard-only ring", () => {
    expect(styles(".tp-ai-mode-select select")).toMatchObject({
      appearance: "none", "-webkit-appearance": "none", "border-radius": "999px",
    });
    expect(styles(".tp-ai-page .tp-ai-mode-select select:focus")).toMatchObject({
      outline: "none", "box-shadow": "none",
    });
    expect(styles(".tp-ai-page .tp-ai-mode-select:has(select:focus-visible)")).toMatchObject({
      outline: "2px solid #8b7028", "outline-offset": "2px",
    });
    expect(styles(".tp-ai-mode-select")["border-radius"]).toBe("999px");
    expect(styles(".tp-ai-page .tp-ai-mode-select:focus-within").outline).toBeUndefined();
  });

  it.each(["quick", "deep"] as const)("retains the accessible native %s mode selection", mode => {
    const markup = renderComposer({ mode });
    expect(markup).toContain('<select aria-label="思考模式">');
    expect(markup).toContain(`<option value="${mode}" selected="">`);
    expect(markup).not.toContain('tabindex="-1"');
  });

  it("keeps the capability chip dismissible and mode selection disabled during generation", () => {
    const markup = renderComposer({ webSearch: true, webSearchEnabled: true, responding: true });
    expect(markup).toContain('class="tp-ai-composer-capabilities" aria-label="当前生成设置"');
    expect(markup).toContain('aria-label="关闭联网搜索"');
    expect(markup).toContain('<select aria-label="思考模式" disabled="">');
  });
});
