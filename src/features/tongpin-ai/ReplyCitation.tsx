import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { AiSource } from "../../../shared/ai";
import { citationSourceViews, markerNumbers, nextCitationFocus, type CitationFocusRequest, type CitationSourceView } from "./replyCitations";
import "./reply-citations.css";

/**
 * Superscript source markers and their hover card. Adapted from LibreChat
 * v0.8.7, commit 9e74cc0e57b395926122bd4062c1fcedc48ed465:
 * client/src/components/Web/Citation.tsx, SourceHovercard.tsx and Context.tsx
 * (MIT, Copyright (c) 2026 LibreChat). Tongpin keeps the per-reply context
 * and hover-card idea, drops Ariakit and remote favicons (display never
 * fetches third-party resources), and makes a marker jump to its numbered
 * entry in the reply's own source list instead of opening the page.
 */

interface CitationSources { sources: readonly CitationSourceView[]; activate: (n: number) => void }
const CitationSourcesContext = createContext<CitationSources | null>(null);
/** The latest marker activation of this reply, consumed by AiSourceList. */
export const CitationFocusContext = createContext<CitationFocusRequest | null>(null);

/** Per-reply scope shared by the answer's markers and its source list. */
export function ReplyCitationScope({ sources, children }: { sources: readonly AiSource[] | undefined; children?: ReactNode }) {
  const views = useMemo(() => citationSourceViews(sources), [sources]);
  const [request, setRequest] = useState<CitationFocusRequest | null>(null);
  const activate = useCallback((n: number) => setRequest(current => nextCitationFocus(current, n)), []);
  const value = useMemo(() => ({ sources: views, activate }), [views, activate]);
  if (!views.length) return <>{children}</>;
  return <CitationSourcesContext.Provider value={value}>
    <CitationFocusContext.Provider value={request}>{children}</CitationFocusContext.Provider>
  </CitationSourcesContext.Provider>;
}

const CARD_WIDTH = 288;
const CARD_GAP = 6;
const CARD_ROOM = 104;

/** Fixed-position placement below the marker, flipped above near the bottom
 * edge and kept inside the viewport horizontally. */
export function citationCardPosition(anchor: { left: number; top: number; bottom: number }, viewport: { width: number; height: number }): CSSProperties {
  const width = Math.min(CARD_WIDTH, Math.max(0, viewport.width - 16));
  const left = Math.round(Math.min(Math.max(8, anchor.left - 12), Math.max(8, viewport.width - width - 8)));
  return anchor.bottom + CARD_GAP + CARD_ROOM > viewport.height && anchor.top > CARD_ROOM
    ? { left, width, bottom: Math.round(viewport.height - anchor.top + CARD_GAP) }
    : { left, width, top: Math.round(anchor.bottom + CARD_GAP) };
}

function CitationCard({ id, anchor, source, onDismiss }: { id: string; anchor: RefObject<HTMLButtonElement | null>; source: CitationSourceView; onDismiss: () => void }) {
  const [position, setPosition] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setPosition(citationCardPosition(rect, { width: window.innerWidth, height: window.innerHeight }));
  }, [anchor]);
  useEffect(() => {
    // A fixed card would detach from its marker; any scroll or resize closes it.
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => { window.removeEventListener("scroll", onDismiss, true); window.removeEventListener("resize", onDismiss); };
  }, [onDismiss]);
  return createPortal(<div id={id} role="tooltip" className="tp-ai-cite-card" style={position ?? { visibility: "hidden" }}>
    <span className="tp-ai-cite-card__meta"><b>{source.n}</b>{source.host}</span>
    <strong>{source.label}</strong>
  </div>, document.body);
}

function CitationChip({ n }: { n: number }) {
  const scope = useContext(CitationSourcesContext);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const cardId = useId();
  const close = useCallback(() => setOpen(false), []);
  const source = scope?.sources[n - 1];
  if (!scope || !source) return null;
  return <>
    <button ref={anchor} type="button" className="tp-ai-cite" data-n={n}
      aria-label={`来源 ${n}：${source.label}（${source.host}），查看来源列表`}
      aria-describedby={open ? cardId : undefined}
      onMouseEnter={() => setOpen(true)} onMouseLeave={close}
      onFocus={() => setOpen(true)} onBlur={close}
      onKeyDown={event => { if (event.key === "Escape") close(); }}
      onClick={() => { close(); scope.activate(n); }}>{n}</button>
    {open ? <CitationCard id={cardId} anchor={anchor} source={source} onDismiss={close} /> : null}
  </>;
}

/** Renders the `tongpin-cite` element produced by the reply citation plugins.
 * Children hold only the model's own "[n]" text, shown when no source resolves. */
export function ReplyCitationMarker({ node, children }: { node?: { properties?: Record<string, unknown> }; children?: ReactNode }) {
  const scope = useContext(CitationSourcesContext);
  const numbers = markerNumbers(node?.properties?.dataNumbers).filter(n => scope?.sources[n - 1]);
  if (!numbers.length) return <>{children}</>;
  return <sup className="tp-ai-cite-group">{numbers.map(n => <CitationChip key={n} n={n} />)}</sup>;
}
