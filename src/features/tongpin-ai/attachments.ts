import type { AiAttachment } from "../../../shared/ai";
import type { AiWorkspaceDocument, AiWorkspaceMedia } from "../../../shared/aiWorkspace";
import { AI_WORKSPACE_LIMITS } from "../../../shared/aiWorkspace";
import { AI_IMAGE_ACCEPT, AI_VIDEO_ACCEPT, AI_MEDIA_LIMITS, mediaFrameByteLength } from "../../../shared/aiMedia";

/** Files are source material, not privileged instructions or executable skills. */
export interface AiTextAttachment {
  name: string;
  text: string;
  mediaType: string;
  media?: AiWorkspaceMedia;
}

export interface ExtractedAttachment extends AiTextAttachment {
  warnings: string[];
}

export const TEXT_ATTACHMENT_ACCEPT = ".txt,.md,.markdown,.csv,.json,.pdf,.docx";
export const ATTACHMENT_ACCEPT = `${TEXT_ATTACHMENT_ACCEPT},${AI_IMAGE_ACCEPT},${AI_VIDEO_ACCEPT}`;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_CHARACTERS = 24_000;
export const MAX_ATTACHMENT_TOTAL_BYTES = 48_000;
export const MAX_ATTACHMENT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 256 * 1024;
const MAX_PDF_PAGES = 60;

export class AttachmentError extends Error {
  constructor(message: string) { super(message); this.name = "AttachmentError"; }
}

export class WorkspaceCapacityError extends AttachmentError {
  constructor(readonly phase: "attachment" | "reply" | "video") {
    super(phase === "attachment"
      ? "工作台附件保存空间不足，请先导出备份并整理不再需要的历史对话；本次附件未添加，原记录保持不变"
      : "当前云端对话资料空间不足，无法保存下一条回复。请先导出备份并整理历史对话；草稿已保留，本次未发送、未扣费");
    this.name = "WorkspaceCapacityError";
  }
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

export function validateAttachments(attachments: readonly AiTextAttachment[]): void {
  if (attachments.length > MAX_ATTACHMENTS) throw new AttachmentError("每次最多添加 5 个附件");
  let total = 0;
  let frames = 0;
  let visualBytes = 0;
  for (const attachment of attachments) {
    if (!attachment.name.trim() || attachment.name.length > 160 || /[\u0000-\u001f\u007f]/.test(attachment.name)) throw new AttachmentError("文件名过长或含无效字符，请重命名后再添加");
    if (!attachment.text.trim() && !attachment.media) throw new AttachmentError(`${attachment.name} 没有可读取的文字`);
    if (attachment.text.length > MAX_ATTACHMENT_CHARACTERS) throw new AttachmentError(`${attachment.name} 文字过长，每个附件最多 24,000 字符，请拆分文件`);
    total += utf8Length(attachment.text);
    if (attachment.media) {
      const media = attachment.media;
      if (!["image", "video"].includes(media.kind) || !media.frames.length || media.frames.length > (media.kind === "image" ? 1 : AI_MEDIA_LIMITS.videoFrames)) throw new AttachmentError("图片或视频采样内容无效，请重新添加");
      if (media.kind === "video" && (!Number.isFinite(media.durationSeconds) || !media.durationSeconds || media.durationSeconds > AI_MEDIA_LIMITS.videoSeconds)) throw new AttachmentError("视频时长无效，请重新添加");
      for (const frame of media.frames) {
        const bytes = mediaFrameByteLength(frame.dataUrl);
        if (bytes > AI_MEDIA_LIMITS.frameBytes) throw new AttachmentError("图片压缩结果过大或无效，请重新添加");
        if (media.kind === "video" && (!Number.isFinite(frame.timeSeconds) || frame.timeSeconds! < 0 || frame.timeSeconds! >= media.durationSeconds!)) throw new AttachmentError("视频采样时间无效，请重新添加");
        visualBytes += bytes;
        frames += 1;
      }
    }
  }
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new AttachmentError("附件文字合计过长，请减少附件或精简内容后再发送");
  if (frames > AI_MEDIA_LIMITS.requestFrames) throw new AttachmentError("每次最多分析 5 张图片或视频采样帧，请减少本次添加的画面；历史画面会按最近顺序自动选取");
  if (visualBytes > AI_MEDIA_LIMITS.requestBytes) throw new AttachmentError("图片内容合计过大，请减少附件");
}

function cleanText(text: string): string {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(normalized)) {
    throw new AttachmentError("文件含有二进制内容或不支持的编码，请另存为 UTF-8 文本");
  }
  return normalized;
}

export function decodeUtf8Attachment(bytes: Uint8Array): string {
  try { return cleanText(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError("文件不是有效的 UTF-8 编码，请另存为 UTF-8 后上传");
  }
}

/** Bound expanded DOCX size before Mammoth opens its XML. No archive entry is executed. */
export function validateDocxArchive(bytes: Uint8Array): void {
  if (bytes.byteLength < 22) throw new AttachmentError("DOCX 文件已损坏");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength) { end = offset; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new AttachmentError("不支持此 DOCX 压缩格式");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  const directoryEnd = offset + directorySize;
  if (count < 1 || count > 2_048 || count !== view.getUint16(end + 8, true) || directoryEnd !== end) throw new AttachmentError("DOCX 内容过多或压缩结构无效");
  let expanded = 0;
  let hasDocument = false;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) throw new AttachmentError("DOCX 压缩目录已损坏");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const next = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (next > directoryEnd || flags & 1 || ![0, 8].includes(method) || size > 8 * 1024 * 1024) throw new AttachmentError("DOCX 已加密、过大或使用了不支持的压缩格式");
    expanded += size;
    if (expanded > 20 * 1024 * 1024) throw new AttachmentError("DOCX 解压后过大，请拆分后上传");
    const entryName = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (entryName === "word/document.xml") hasDocument = true;
    offset = next;
  }
  if (offset !== directoryEnd || !hasDocument) throw new AttachmentError("文件不是有效的 DOCX 文档");
}

async function extractPdf(bytes: Uint8Array, signal?: AbortSignal): Promise<{ text: string; warnings: string[] }> {
  signal?.throwIfAborted();
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: bytes, useSystemFonts: false, disableFontFace: true, enableXfa: false, useWasm: false });
  let destruction: Promise<void> | undefined;
  const destroy = () => destruction ??= task.destroy();
  const abort = () => { void destroy().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const document = await task.promise;
    if (document.numPages > MAX_PDF_PAGES) throw new AttachmentError("PDF 最多支持 60 页，请拆分后上传");
    const pages: string[] = [];
    let characters = 0;
    let emptyPages = 0;
    for (let number = 1; number <= document.numPages; number += 1) {
      signal?.throwIfAborted();
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        signal?.throwIfAborted();
        const text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
        characters += text.length + 2;
        if (characters > MAX_ATTACHMENT_CHARACTERS) throw new AttachmentError("PDF 文字过长，请拆分后上传");
        if (!text) emptyPages += 1;
        pages.push(text);
      } finally { page.cleanup(); }
    }
    const text = cleanText(pages.join("\n\n"));
    if (!text) throw new AttachmentError("这个 PDF 没有可提取的文字，可能是扫描件。OCR 尚未接入，请提供文字版 PDF 或粘贴文字");
    return { text, warnings: emptyPages ? [`${emptyPages} 页没有可提取文字，图片和扫描内容未识别`] : [] };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof AttachmentError) throw error;
    if (error instanceof Error && error.name === "PasswordException") throw new AttachmentError("PDF 已加密，请先解除密码后上传");
    throw new AttachmentError("PDF 读取失败，请检查文件是否损坏或另存为文字版 PDF");
  } finally { signal?.removeEventListener("abort", abort); await destroy(); }
}

export async function extractAttachment(file: File, options: { signal?: AbortSignal; allowMedia?: boolean } = {}): Promise<ExtractedAttachment> {
  options.signal?.throwIfAborted();
  if (!file.size) throw new AttachmentError("不能添加空文件");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "mp4", "webm", "mov", "m4v"].includes(extension ?? "")) {
    if (options.allowMedia === false) throw new AttachmentError("请在对话中添加图片或视频，项目资料目前支持文字文档");
    const { extractMediaAttachment } = await import("./mediaAttachments");
    return extractMediaAttachment(file, options.signal);
  }
  if (file.size > MAX_ATTACHMENT_FILE_BYTES) throw new AttachmentError("单个附件最大 5 MB，请压缩或拆分后上传");
  if (file.name.length > 160) throw new AttachmentError("文件名过长，请缩短后再添加");
  if (!["txt", "md", "markdown", "csv", "json", "pdf", "docx"].includes(extension ?? "")) throw new AttachmentError("支持 TXT、Markdown、CSV、JSON、PDF 和 DOCX 文件");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  let mediaType: string;
  let warnings: string[] = [];
  if (extension === "pdf") {
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new AttachmentError("文件内容不是 PDF");
    ({ text, warnings } = await extractPdf(bytes, options.signal));
    mediaType = "application/pdf";
  } else if (extension === "docx") {
    validateDocxArchive(bytes);
    try {
      // Vite honors Mammoth's browser mappings. Use lockfile dependencies instead
      // of its prebundled standalone script and never convert unsanitized HTML.
      const { default: mammoth } = await import("mammoth");
      const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer as ArrayBuffer });
      text = cleanText(result.value);
      if (result.messages.some(message => message.type === "warning")) warnings = ["文档的部分格式未保留，仅提取可读取文字"];
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError("DOCX 读取失败，请检查文件是否损坏");
    }
    mediaType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  } else {
    if (bytes.length > MAX_TEXT_FILE_BYTES) throw new AttachmentError("文本文件过大，请拆分后上传");
    text = decodeUtf8Attachment(bytes);
    if (extension === "json") {
      try { JSON.parse(text); } catch { throw new AttachmentError("JSON 格式不正确，请修正后上传"); }
    }
    mediaType = extension === "json" ? "application/json" : extension === "csv" ? "text/csv" : extension === "txt" ? "text/plain" : "text/markdown";
  }
  const attachment = { name: file.name, text, mediaType, warnings };
  options.signal?.throwIfAborted();
  validateAttachments([attachment]);
  return attachment;
}

/** Use this boundary when sending: local extraction warnings are not part of the API contract. */
export function attachmentPayload(attachment: AiTextAttachment): AiTextAttachment {
  return { name: attachment.name, text: attachment.text, mediaType: attachment.mediaType, ...(attachment.media ? { media: attachment.media } : {}) };
}

export function workspaceAttachment(document: AiWorkspaceDocument): AiTextAttachment {
  return { name: document.name, text: document.content, mediaType: document.mimeType, ...(document.media ? { media: document.media } : {}) };
}

/** Expand sampled video frames into the existing, validated image API contract. */
export function documentAttachments(documents: readonly AiWorkspaceDocument[]): AiAttachment[] {
  const attachments = documents.map(workspaceAttachment);
  validateAttachments(attachments);
  const result: AiAttachment[] = [];
  for (const item of attachments) {
    if (!item.media) { result.push({ name: item.name, text: item.text, mediaType: item.mediaType }); continue; }
    for (const [index, frame] of item.media.frames.entries()) {
      const time = item.media.kind === "video" ? `，采样时间 ${frame.timeSeconds!.toFixed(2)} 秒` : "";
      result.push({ name: `${item.name.slice(0, 120)}${time}`, mediaType: "image/jpeg", dataUrl: frame.dataUrl,
        text: item.media.kind === "video" ? `视频 ${item.name}：第 ${index + 1}/${item.media.frames.length} 个采样画面，时间 ${frame.timeSeconds!.toFixed(2)} 秒，总时长 ${item.media.durationSeconds!.toFixed(2)} 秒。仅分析这些静态画面，不包含音频；未采样部分未知。` : `图片附件：${item.name}` });
    }
  }
  if (result.length > MAX_ATTACHMENTS) throw new AttachmentError("本次文档、图片和视频采样帧合计最多 5 份，请减少本次添加的附件");
  return result;
}

/** Leave room for a maximum-length text reply and bounded source metadata, not just a short answer. */
export function ensureAttachmentWorkspaceCapacity(state: unknown, phase: "attachment" | "reply" | "video" = "attachment"): void {
  // Ordinary chat keeps room for the largest accepted text reply. A video
  // submission persists only IDs and small task metadata, so reserving a full
  // megabyte there incorrectly blocks a fresh conversation with existing history.
  const reserve = phase === "video" ? 64 * 1024 : 512 * 1024;
  if (utf8Length(JSON.stringify(state)) > AI_WORKSPACE_LIMITS.stateBytes - reserve) {
    throw new WorkspaceCapacityError(phase);
  }
}
