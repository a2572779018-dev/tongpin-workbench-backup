import { useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { AiSource } from "../../../shared/ai";
import { aiMotionRef } from "./motion";
import { CitationFocusContext } from "./ReplyCitation";
import { citationListTarget } from "./replyCitations";
import { displaySources, sourceLabel } from "./sourceDisplay";

const CITED_HIGHLIGHT_MS = 1800;

export function AiSourceLink({ source, number, cited, itemRef }: { source: AiSource; number?: number; cited?: boolean; itemRef?: (element: HTMLLIElement | null) => void }) {
  return <li ref={itemRef} className={cited ? "is-cited" : undefined}>
    {number === undefined ? null : <span className="tp-ai-message-sources__n">{number}</span>}
    <AiSourceAnchor href={source.url}>{sourceLabel(source)}</AiSourceAnchor>
  </li>;
}

function revealCitedSource(item: HTMLLIElement): void {
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  item.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  item.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
}

/** Numbered, deduplicated citation list; beyond the first few, the rest fold
 * away. A marker in the answer unfolds, scrolls to and highlights its entry. */
export function AiSourceList({ sources }: { sources: readonly AiSource[] | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const [cited, setCited] = useState<number | null>(null);
  const request = useContext(CitationFocusContext);
  const items = useRef(new Map<number, HTMLLIElement>());
  const handled = useRef(0);
  const { visible, folded } = displaySources(sources);
  useEffect(() => {
    if (!request || request.token === handled.current) return;
    handled.current = request.token;
    const target = citationListTarget(request.n, visible.length, folded.length);
    if (!target) return;
    if (target.needsExpand) setExpanded(true);
    setCited(request.n);
  }, [request, visible.length, folded.length]);
  useEffect(() => {
    if (cited === null) return;
    const item = items.current.get(cited);
    if (item) revealCitedSource(item);
    const timer = window.setTimeout(() => setCited(null), CITED_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [cited, request?.token]);
  if (!visible.length) return null;
  const shown = expanded ? [...visible, ...folded] : visible;
  return <div className="tp-ai-message-sources-block">
    <ul className="tp-ai-message-sources" aria-label="参考来源" ref={aiMotionRef}>
      {shown.map((source, index) => <AiSourceLink key={`${source.url}-${index}`} source={source} number={index + 1} cited={cited === index + 1}
        itemRef={element => { if (element) items.current.set(index + 1, element); else items.current.delete(index + 1); }} />)}
    </ul>
    {folded.length ? <button type="button" className="tp-ai-message-sources__toggle" aria-expanded={expanded}
      onClick={() => setExpanded(current => !current)}>{expanded ? "收起来源" : `展开其余 ${folded.length} 个来源`}</button> : null}
  </div>;
}

/** Both inline citations and the source list use the desktop's existing URL policy. */
export function AiSourceAnchor({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const [error, setError] = useState("");
  const pending = useRef(false);
  let url: URL;
  try {
    url = new URL(href);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return <>{children}</>;
  } catch { return <>{children}</>; }

  async function openSource(event: MouseEvent<HTMLAnchorElement>) {
    // Web previews use a normal browser link; desktop citations use the narrow
    // main-process policy instead of weakening the global popup deny handler.
    if (!window.tongpin) return;
    event.preventDefault();
    if (pending.current) return;
    if (!window.tongpin.openAiSource) {
      setError("请更新或重启同频后打开参考来源。");
      return;
    }
    pending.current = true;
    setError("");
    try {
      const result = await window.tongpin.openAiSource(url.href);
      if (result === "blocked") setError("该来源链接不符合安全要求，未打开。");
      if (result === "failed") setError("无法打开默认浏览器，请稍后重试。");
      if (result === "busy") setError("请先处理已经打开的来源确认窗口。");
    } catch {
      setError("无法打开参考来源，请稍后重试。");
    } finally {
      pending.current = false;
    }
  }

  return <>
    <a className={className} href={url.href} title={url.href} target="_blank" rel="noopener noreferrer"
      onClick={event => void openSource(event)}
      onAuxClick={event => { if (event.button === 1) void openSource(event); }}>
      {children || url.hostname}
    </a>
    {error ? <span className="tp-ai-source-error" role="alert">{error}</span> : null}
  </>;
}
