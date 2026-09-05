import { useRef, useState, type MouseEvent } from "react";
import type { AiSource } from "../../../shared/ai";

export function AiSourceLink({ source }: { source: AiSource }) {
  const [error, setError] = useState("");
  const pending = useRef(false);
  let url: URL;
  try {
    url = new URL(source.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
  } catch { return null; }

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

  return <li>
    <a href={url.href} title={url.hostname} target="_blank" rel="noopener noreferrer"
      onClick={event => void openSource(event)}
      onAuxClick={event => { if (event.button === 1) void openSource(event); }}>
      {source.title || url.hostname}
    </a>
    {error ? <span className="tp-ai-source-error" role="alert">{error}</span> : null}
  </li>;
}
