/** Files are source material, not privileged instructions or executable skills. */
export interface AiTextAttachment {
  name: string;
  text: string;
  mediaType: string;
}

export interface ExtractedAttachment extends AiTextAttachment {
  warnings: string[];
}

export const ATTACHMENT_ACCEPT = ".txt,.md,.markdown,.csv,.json,.pdf,.docx";
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_CHARACTERS = 24_000;
export const MAX_ATTACHMENT_TOTAL_BYTES = 48_000;
export const MAX_ATTACHMENT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 256 * 1024;
const MAX_PDF_PAGES = 60;

export class AttachmentError extends Error {
  constructor(message: string) { super(message); this.name = "AttachmentError"; }
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

export function validateAttachments(attachments: readonly AiTextAttachment[]): void {
  if (attachments.length > MAX_ATTACHMENTS) throw new AttachmentError("每次最多添加 5 个附件");
  let total = 0;
  for (const attachment of attachments) {
    if (!attachment.name.trim() || attachment.name.length > 160) throw new AttachmentError("文件名过长，请缩短后再添加");
    if (!attachment.text.trim()) throw new AttachmentError(`${attachment.name} 没有可读取的文字`);
    if (attachment.text.length > MAX_ATTACHMENT_CHARACTERS) throw new AttachmentError(`${attachment.name} 文字过长，每个附件最多 24,000 字符，请拆分文件`);
    total += utf8Length(attachment.text);
  }
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new AttachmentError("附件文字合计过长，请减少附件或精简内容后再发送");
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

async function extractPdf(bytes: Uint8Array): Promise<{ text: string; warnings: string[] }> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: bytes, useSystemFonts: false, disableFontFace: true, enableXfa: false, useWasm: false });
  try {
    const document = await task.promise;
    if (document.numPages > MAX_PDF_PAGES) throw new AttachmentError("PDF 最多支持 60 页，请拆分后上传");
    const pages: string[] = [];
    let characters = 0;
    let emptyPages = 0;
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
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
    if (error instanceof AttachmentError) throw error;
    if (error instanceof Error && error.name === "PasswordException") throw new AttachmentError("PDF 已加密，请先解除密码后上传");
    throw new AttachmentError("PDF 读取失败，请检查文件是否损坏或另存为文字版 PDF");
  } finally { await task.destroy(); }
}

export async function extractAttachment(file: File): Promise<ExtractedAttachment> {
  if (!file.size) throw new AttachmentError("不能添加空文件");
  if (file.size > MAX_ATTACHMENT_FILE_BYTES) throw new AttachmentError("单个附件最大 5 MB，请压缩或拆分后上传");
  if (file.name.length > 160) throw new AttachmentError("文件名过长，请缩短后再添加");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["txt", "md", "markdown", "csv", "json", "pdf", "docx"].includes(extension ?? "")) throw new AttachmentError("支持 TXT、Markdown、CSV、JSON、PDF 和 DOCX 文件");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  let mediaType: string;
  let warnings: string[] = [];
  if (extension === "pdf") {
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new AttachmentError("文件内容不是 PDF");
    ({ text, warnings } = await extractPdf(bytes));
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
  validateAttachments([attachment]);
  return attachment;
}

/** Use this boundary when sending: local extraction warnings are not part of the API contract. */
export function attachmentPayload(attachment: AiTextAttachment): AiTextAttachment {
  return { name: attachment.name, text: attachment.text, mediaType: attachment.mediaType };
}
