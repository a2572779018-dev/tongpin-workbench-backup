import { createElement, useEffect, useMemo, useState, type ReactNode } from "react";
import type { HighlightNode } from "./replyCodeHighlight";

/**
 * Lazy syntax highlighting for reply code blocks.
 *
 * Adapted from LibreChat v0.8.7, commit
 * 9e74cc0e57b395926122bd4062c1fcedc48ed465:
 * client/src/components/Chat/Messages/Content/Parts/useLazyHighlight.ts
 * (MIT, Copyright (c) 2026 LibreChat). As upstream, the highlighter is
 * imported on first use, code renders as plain text until it is ready, and
 * later blocks highlight synchronously from the cached module. Tongpin
 * changes: a curated grammar set without auto-detection, `code === null` keeps
 * a still-streaming fence plain (no per-token re-colouring) while the chunk
 * preloads, and the hast -> React conversion only emits text and `span`s.
 */
type HighlightModule = typeof import("./replyCodeHighlight");

let highlighter: HighlightModule | null = null;
let loading: Promise<HighlightModule | null> | null = null;

/** Load (once) the highlighter chunk. Resolves null if the chunk cannot be
 * loaded; code then simply stays plain. */
export function loadReplyHighlighter(): Promise<HighlightModule | null> {
  if (highlighter) return Promise.resolve(highlighter);
  loading ??= import("./replyCodeHighlight").then(module => (highlighter = module), () => null);
  return loading;
}

function classNames(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string").join(" ") || undefined;
}

/** Text stays text (React escapes it); every element becomes a `span`. */
export function highlightNodesToReact(nodes: readonly HighlightNode[]): ReactNode[] {
  return nodes.map((node, index) => node.type === "text"
    ? node.value
    : createElement("span", { key: index, className: classNames(node.properties?.className) }, highlightNodesToReact(node.children)));
}

/**
 * Highlighted children for `code`, or null to render the plain text:
 * pass `code = null` while the block is still streaming or being revealed.
 * The grammar chunk is preloaded as soon as a labelled block appears.
 */
export function useReplyHighlight(code: string | null, language: string): ReactNode[] | null {
  const [loaded, setLoaded] = useState(highlighter);
  const active = loaded ?? highlighter;
  useEffect(() => {
    if (active || !language) return;
    let cancelled = false;
    void loadReplyHighlighter().then(module => { if (!cancelled && module) setLoaded(module); });
    return () => { cancelled = true; };
  }, [active, language]);
  return useMemo(() => {
    if (!active || code === null || !language) return null;
    const tree = active.highlightReplyTree(code, language);
    return tree ? highlightNodesToReact(tree) : null;
  }, [active, code, language]);
}
