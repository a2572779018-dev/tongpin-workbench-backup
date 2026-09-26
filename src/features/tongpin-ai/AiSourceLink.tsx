import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { AiSource } from "../../../shared/ai";
import { aiMotionRef } from "./motion";
import { displaySources, sourceLabel } from "./sourceDisplay";

export function AiSourceLink({ source }: { source: AiSource }) {
  return <li><AiSourceAnchor href={source.url}>{sourceLabel(source)}</AiSourceAnchor></li>;
}

/** Deduplicated citation list; beyond the first few, the rest fold away. */
export function AiSourceList({ sources }: { sources: readonly AiSource[] | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const { visible, folded } = displaySources(sources);
  if (!visible.length) return null;
  const shown = expanded ? [...visible, ...folded] : visible;
  return <div className="tp-ai-message-sources-block">
    <ul className="tp-ai-message-sources" aria-label="参考来源" ref={aiMotionRef}>
      {shown.map((source, index) => <AiSourceLink key={`${source.url}-${index}`} source={source} />)}
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
