import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * Syntax highlighting for fenced code in AI replies. This module is only ever
 * loaded through `import()` (see useReplyHighlight.ts) so highlight.js stays
 * out of the chat page chunk until a reply actually contains code.
 *
 * Only a curated set of common grammars is registered (instead of the ~37
 * "common" or ~190 "all" grammars) to keep the chunk small. Grammar-defined
 * aliases come along automatically (js/jsx, ts/tsx, py, sh/zsh, html/svg,
 * yml, md, patch, golang, rs, jsonc...). Unknown or unlabelled fences are
 * rendered as plain text: there is deliberately no auto-detection, which is
 * slow and often wrong on logs or prose.
 */
const GRAMMARS = { bash, css, diff, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml };
/** Info strings models commonly use that the grammars do not declare. */
const EXTRA_ALIASES: Readonly<Record<keyof typeof GRAMMARS, readonly string[]>> = {
  bash: ["shell"], css: [], diff: [], go: [], java: [], javascript: [], json: [], markdown: [], python: [], rust: [],
  sql: ["mysql", "postgresql", "postgres", "sqlite"], typescript: [], xml: [], yaml: [],
};

/** Highlighting cost grows with input size; very large blocks stay plain. */
export const MAX_HIGHLIGHT_LENGTH = 40_000;
export const REPLY_HIGHLIGHT_GRAMMARS: readonly string[] = Object.freeze(Object.keys(GRAMMARS));

const lowlight = createLowlight(GRAMMARS);
lowlight.registerAlias(EXTRA_ALIASES);

/** Minimal hast shapes produced by lowlight (text and `span` elements). */
export type HighlightNode =
  | { type: "text"; value: string }
  | { type: "element"; tagName: string; properties?: { className?: unknown }; children: HighlightNode[] };

/** Whether `language` (a name or alias, any case) has a registered grammar. */
export function isReplyHighlightLanguage(language: string): boolean {
  return Boolean(language) && lowlight.registered(language.toLowerCase());
}

/** Highlight `code` as `language`. Returns null (render plain text) for an
 * unregistered language, oversized input or a grammar error; never throws. */
export function highlightReplyTree(code: string, language: string): HighlightNode[] | null {
  const name = language.toLowerCase();
  if (!code || code.length > MAX_HIGHLIGHT_LENGTH || !isReplyHighlightLanguage(name)) return null;
  try {
    return lowlight.highlight(name, code).children as HighlightNode[];
  } catch {
    return null;
  }
}
