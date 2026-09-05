import { Download, Presentation } from "lucide-react";
import { useRef, useState } from "react";
import { downloadPresentation, type PresentationDocument } from "./presentation";
import "./generated-content.css";

export function GeneratedArtifact({ presentation }: { presentation: PresentationDocument }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  async function download() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try { await downloadPresentation(presentation); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "PPTX 导出失败，请重试"); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <section className="tp-ai-generated-deck" aria-label={`PPT 成果：${presentation.title}`}>
    <header><Presentation size={22} aria-hidden="true" /><span><strong>{presentation.title}</strong><small>{presentation.slides.length} 页 · 可编辑 PPTX</small></span>
      <button type="button" disabled={busy} onClick={() => void download()}><Download size={16} />{busy ? "正在导出…" : "下载 PPTX"}</button>
    </header>
    {error ? <p className="tp-ai-generated-error" role="alert">{error}</p> : null}
    <details><summary>查看幻灯片内容</summary><ol>
      {presentation.slides.map((slide, index) => <li key={index}><strong>{slide.title}</strong>
        <ul>{slide.bullets.map((bullet, point) => <li key={point}>{bullet}</li>)}</ul>
        {slide.notes ? <details><summary>演讲备注</summary><p>{slide.notes}</p></details> : null}
      </li>)}
    </ol></details>
  </section>;
}
