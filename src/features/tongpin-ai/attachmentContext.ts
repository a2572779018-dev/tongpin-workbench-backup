import type { AiAttachment } from "../../../shared/ai";
import type { AiWorkspaceDocument, AiWorkspaceMessage } from "../../../shared/aiWorkspace";
import { AI_MEDIA_LIMITS, mediaFrameByteLength } from "../../../shared/aiMedia";
import { documentAttachments, MAX_ATTACHMENT_CHARACTERS, MAX_ATTACHMENT_TOTAL_BYTES } from "./attachments";

const encoder = new TextEncoder();
const textBytes = (value: string | undefined) => encoder.encode(value || "").length;
function validRequestAttachment(item: AiAttachment): boolean {
  if (!item || typeof item.name !== "string" || !item.name.trim() || item.name.length > 160 || /[\u0000-\u001f\u007f]/.test(item.name)) return false;
  if (item.text !== undefined && (typeof item.text !== "string" || !item.text.trim() || item.text.length > MAX_ATTACHMENT_CHARACTERS)) return false;
  if (item.dataUrl !== undefined && (!Number.isFinite(mediaFrameByteLength(item.dataUrl)) || mediaFrameByteLength(item.dataUrl) > AI_MEDIA_LIMITS.frameBytes)) return false;
  return item.text !== undefined || item.dataUrl !== undefined;
}
function utf8Prefix(text: string, maxBytes: number, maxCodeUnits: number): string {
  if (maxBytes <= 0 || maxCodeUnits <= 0) return "";
  let bytes = 0, end = 0;
  for (const character of text) {
    const size = textBytes(character);
    if (bytes + size > maxBytes || end + character.length > maxCodeUnits) break;
    bytes += size; end += character.length;
  }
  return text.slice(0, end);
}
function appendOmissionNotice(items: AiAttachment[], omitted: number): AiAttachment[] {
  if (!omitted || !items.length) return items;
  const notice = `上下文说明：本轮按相关性和最近顺序选取附件，${omitted} 份历史附件未重送。未提供的内容不可推测；历史原文件仍保存在对话。`;
  let index = 0;
  for (let i = 1; i < items.length; i += 1) if (textBytes(items[i].text) > textBytes(items[index].text)) index = i;
  const existing = items[index].text || "";
  const otherBytes = items.reduce((total, item, i) => total + (i === index ? 0 : textBytes(item.text)), 0);
  const prefix = utf8Prefix(existing,
    Math.max(0, MAX_ATTACHMENT_TOTAL_BYTES - otherBytes - textBytes(notice) - 1),
    Math.max(0, MAX_ATTACHMENT_CHARACTERS - notice.length - 1));
  const result = [...items];
  result[index] = { ...result[index], text: prefix ? `${prefix}\n${notice}` : notice };
  return result;
}

/** Select request context only; never mutate or remove persisted conversation attachments. */
export function fitAttachmentContext(priority: AiAttachment[], history: AiAttachment[], alreadyOmitted = 0): AiAttachment[] {
  if (priority.length > 5) throw Error("本次附件最多 5 份，请减少当前附件");
  if (priority.some(item => !validRequestAttachment(item))) throw Error("本次附件内容无效，请重新添加");
  const result = [...priority], seen = new Set(priority.map(a => a.dataUrl || `${a.name}\n${a.text}`));
  let bytes = result.reduce((n, a) => n + textBytes(a.text), 0);
  let visualBytes = result.reduce((n, a) => n + (a.dataUrl ? mediaFrameByteLength(a.dataUrl) : 0), 0);
  if (bytes > MAX_ATTACHMENT_TOTAL_BYTES || visualBytes > AI_MEDIA_LIMITS.requestBytes) throw Error("本次附件内容超出分析上限，请减少当前附件");
  let omitted = alreadyOmitted;
  for (const item of history) {
    if (!validRequestAttachment(item)) { omitted++; continue; }
    const identity = item.dataUrl || `${item.name}\n${item.text}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const size = textBytes(item.text), imageSize = item.dataUrl ? mediaFrameByteLength(item.dataUrl) : 0;
    if (result.length >= 5 || bytes + size > MAX_ATTACHMENT_TOTAL_BYTES || visualBytes + imageSize > AI_MEDIA_LIMITS.requestBytes) { omitted++; continue; }
    result.push(item); bytes += size; visualBytes += imageSize;
  }
  return appendOmissionNotice(result, omitted);
}

export function conversationAttachmentContext(current: AiWorkspaceDocument[], history: AiWorkspaceDocument[]) {
  // Explicit new uploads are validated together. Old uploads do not make the new message unsendable.
  const priority = documentAttachments(current), ids = new Set(current.map(a => a.id));
  const old: AiAttachment[] = [];
  let omitted = 0;
  for (const item of history as unknown[]) {
    try {
      if (!item || typeof item !== "object" || typeof (item as AiWorkspaceDocument).id !== "string") throw Error("invalid history attachment");
      const document = item as AiWorkspaceDocument;
      if (ids.has(document.id)) continue;
      ids.add(document.id); old.push(...documentAttachments([document]));
    } catch { omitted++; }
  }
  return fitAttachmentContext(priority, old, omitted);
}

/** Build the one canonical attachment selection used by both planning and execution. */
export function toolAttachmentContext(
  current: AiWorkspaceDocument[],
  projectDocuments: AiWorkspaceDocument[],
  messages: Array<Pick<AiWorkspaceMessage, "attachments">>,
) {
  const documents = new Map([...projectDocuments, ...current].map(item => [item.id, item]));
  for (const message of messages) {
    for (const item of message.attachments ?? []) documents.set(item.id, item);
  }
  return conversationAttachmentContext(current, [...documents.values()].reverse());
}
