import {
  Check,
  Clipboard,
  Download,
  FileText,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TongpinAIArtifact } from "./types";
import { GeneratedArtifact } from "./GeneratedArtifact";
import { validatePresentation } from "./presentation";
import { ImageArtifact } from "./ImageArtifact";
import type { AiImageMimeType } from "../../../shared/ai";

interface ArtifactPreviewProps {
  artifact: TongpinAIArtifact;
  onClose: () => void;
  onImageDeleted?: (assetId: string) => void;
}

export function ArtifactPreview({ artifact, onClose, onImageDeleted }: ArtifactPreviewProps) {
  let presentation: ReturnType<typeof validatePresentation> | undefined;
  let presentationError = "";
  if (artifact.data?.presentation) {
    try { presentation = validatePresentation(artifact.data.presentation); }
    catch (caught) { presentationError = caught instanceof Error ? caught.message : "PPT 内容无效"; }
  }
  const images = Array.isArray(artifact.data?.images) ? artifact.data.images.flatMap(value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.assetId !== "string") return [];
    return [{ assetId: value.assetId, deleted: value.deleted === true, mimeType: ["image/png", "image/jpeg", "image/webp"].includes(String(value.mimeType)) ? value.mimeType as AiImageMimeType : undefined }];
  }) : [];
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const [exportState, setExportState] = useState<"idle" | "started" | "error">(
    "idle",
  );
  const copyTimerRef = useRef<number | null>(null);
  const exportTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setCopyState("idle");
    setExportState("idle");
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    if (exportTimerRef.current !== null) {
      window.clearTimeout(exportTimerRef.current);
      exportTimerRef.current = null;
    }
  }, [artifact.id]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      if (exportTimerRef.current !== null) {
        window.clearTimeout(exportTimerRef.current);
      }
    },
    [],
  );

  async function copyArtifact() {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    try {
      const text = [
        artifact.title,
        artifact.summary,
        ...artifact.sections.flatMap((section) => [
          section.heading,
          ...section.lines.map((line) => `- ${line}`),
        ]),
      ].join("\n");
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      copyTimerRef.current = null;
    }, 1_800);
  }

  function downloadArtifact() {
    if (exportTimerRef.current !== null) {
      window.clearTimeout(exportTimerRef.current);
      exportTimerRef.current = null;
    }

    let href: string | null = null;
    let anchor: HTMLAnchorElement | null = null;
    try {
      const text = [
        `# ${artifact.title}`,
        "",
        artifact.summary,
        "",
        ...artifact.sections.flatMap((section) => [
          `## ${section.heading}`,
          "",
          ...section.lines.map((line) => `- ${line}`),
          "",
        ]),
      ].join("\n");
      href = URL.createObjectURL(
        new Blob([text], { type: "text/markdown;charset=utf-8" }),
      );
      anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "tongpin-ai-result.md";
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      setExportState("started");
    } catch {
      setExportState("error");
    } finally {
      anchor?.remove();
      if (href !== null) {
        const objectUrl = href;
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      }
    }

    exportTimerRef.current = window.setTimeout(() => {
      setExportState("idle");
      exportTimerRef.current = null;
    }, 1_800);
  }

  return (
    <aside className="tp-ai-preview" aria-label="成果预览">
      <header className="tp-ai-preview__header">
        <span>
          <FileText size={17} />
          <strong>成果预览</strong>
        </span>
        <div>
          <button
            type="button"
            aria-label="关闭成果预览"
            title="关闭成果预览"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
      </header>

      <div
        className="tp-ai-preview__paper"
        role="document"
        aria-label={`成果：${artifact.title}`}
      >
        <div className="tp-ai-preview__meta">
          <span>{artifact.kind}</span>
          <time>{artifact.updatedLabel}</time>
        </div>
        <h2>{artifact.title}</h2>
        <p className="tp-ai-preview__summary">{artifact.summary}</p>
        {presentation ? <GeneratedArtifact key={artifact.id} presentation={presentation} /> : null}
        {presentationError ? <p role="alert">{presentationError}</p> : null}
        {images.map(image => image.deleted ? <p key={image.assetId}>图片已删除。</p> : <ImageArtifact key={image.assetId} {...image} title={artifact.title} onDeleted={onImageDeleted} />)}
        <div className="tp-ai-preview__rule" />
        <div className="tp-ai-preview__sections">
          {artifact.sections.map((section) => (
            <section key={section.heading}>
              <h3>{section.heading}</h3>
              <ul>
                {section.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>

      <footer className="tp-ai-preview__footer">
        <button
          type="button"
          aria-live="polite"
          onClick={() => void copyArtifact()}
        >
          {copyState === "copied" ? (
            <Check size={16} />
          ) : copyState === "error" ? (
            <TriangleAlert size={16} />
          ) : (
            <Clipboard size={16} />
          )}
          {copyState === "copied"
            ? "已复制"
            : copyState === "error"
              ? "复制失败"
              : "复制"}
        </button>
        <button
          type="button"
          className="is-primary"
          aria-live="polite"
          onClick={downloadArtifact}
        >
          {exportState === "started" ? (
            <Check size={16} />
          ) : exportState === "error" ? (
            <TriangleAlert size={16} />
          ) : (
            <Download size={16} />
          )}
          {exportState === "started"
            ? "已开始导出"
            : exportState === "error"
              ? "导出失败"
              : "导出 Markdown"}
        </button>
      </footer>
    </aside>
  );
}
