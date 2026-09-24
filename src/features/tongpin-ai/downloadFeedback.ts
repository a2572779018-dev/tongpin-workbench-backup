export const AI_DOWNLOAD_FEEDBACK_EVENT = "tongpin-ai:download-feedback";

export interface AiDownloadFeedback {
  state: "saved" | "started" | "cancelled" | "error";
  filename: string;
  message: string;
}

interface WritableFileHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }>;
}

type SaveFilePicker = (options: {
  suggestedName: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<WritableFileHandle>;

function emit(feedback: AiDownloadFeedback) {
  window.dispatchEvent(new CustomEvent<AiDownloadFeedback>(AI_DOWNLOAD_FEEDBACK_EVENT, { detail: feedback }));
  return feedback;
}

function extension(filename: string): string {
  const match = /(\.[A-Za-z0-9]{1,12})$/.exec(filename);
  return match?.[1].toLowerCase() ?? "";
}

/**
 * Prefer the native/browser file picker because it can truthfully confirm that bytes were written.
 * The anchor fallback can only confirm that the browser accepted the download, so its wording stays explicit.
 */
export async function saveBlobWithFeedback(blob: Blob, filename: string): Promise<AiDownloadFeedback> {
  if (window.tongpin?.saveAiFile) {
    try {
      const result = await window.tongpin.saveAiFile({ filename, bytes: await blob.arrayBuffer() });
      if (result.state === "cancelled") return emit({ state: "cancelled", filename, message: `已取消保存“${filename}”。` });
      if (result.state === "busy") return emit({ state: "error", filename, message: "已有文件正在保存，请稍后再试。" });
      if (result.state !== "saved" || !result.filePath) throw new Error("保存结果无效");
      return emit({ state: "saved", filename, message: `已保存到 ${result.filePath}` });
    } catch {
      // A failed desktop save must never silently start a second browser download.
      return emit({ state: "error", filename, message: `“${filename}”保存失败，请重试。` });
    }
  }
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (picker) {
    let writable: Awaited<ReturnType<WritableFileHandle["createWritable"]>> | undefined;
    try {
      const suffix = extension(filename);
      const handle = await picker({
        suggestedName: filename,
        ...(suffix ? { types: [{ description: "同频 AI 文件", accept: { [blob.type || "application/octet-stream"]: [suffix] } }] } : {}),
      });
      writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return emit({ state: "saved", filename, message: `已保存“${filename}”到你选择的位置。` });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return emit({ state: "cancelled", filename, message: `已取消保存“${filename}”。` });
      }
      try { await writable?.abort?.(); } catch { /* best-effort close after a failed write */ }
      return emit({ state: "error", filename, message: `“${filename}”保存失败，请重试。` });
    }
  }

  let url = "";
  let anchor: HTMLAnchorElement | undefined;
  try {
    url = URL.createObjectURL(blob);
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    return emit({ state: "started", filename, message: `已开始下载“${filename}”，请在浏览器下载记录中查看保存位置。` });
  } catch {
    return emit({ state: "error", filename, message: `“${filename}”下载未启动，请重试。` });
  } finally {
    anchor?.remove();
    if (url) window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
