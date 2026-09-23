import type { StoredProvider } from "./storage";
import type { AiAttachment } from "../../shared/ai";
import {
  AI_IMAGE_EDIT_MAX_INPUT_BYTES, AI_IMAGE_EDIT_PROFILE_SPECS, AI_IMAGE_GENERATION_PROFILE_SPECS,
  type AiImageEditCapability, type AiImageGenerationCapability,
} from "../../shared/aiImageCapabilities";
import { parseImageEditCapability, parseImageGenerationCapability } from "./imageCapabilities";
import { validateImageBase64 } from "./capabilities";
import { object, readBoundedText } from "./provider";
import { AiError } from "./security";

export const MAX_IMAGE_RESPONSE_BYTES = 6_000_000;

/** Images API streaming is separate from Responses/chat reasoning. Never probe by sending an extra generation. */
export function imageProviderBody(provider: Pick<StoredProvider, "imageModel" | "imageStream">, prompt: string, declared?: AiImageGenerationCapability): Record<string, unknown> {
  if (declared) {
    const spec = AI_IMAGE_GENERATION_PROFILE_SPECS[declared.profile];
    return {
      model: provider.imageModel, prompt, n: 1, size: declared.size,
      [spec.outputField]: spec.outputFormat,
      ...(provider.imageStream && spec.stream ? { stream: true, partial_images: 0 } : {}),
    };
  }
  // Historical saved configurations did not contain a generation capability.
  // Keep their exact on-wire request until an administrator explicitly binds a
  // protocol; this path is not evidence that a new alias supports GPT options.
  return {
    model: provider.imageModel, prompt, n: 1, size: "1024x1024",
    ...(/^gpt-image/i.test(provider.imageModel ?? "") ? { output_format: "jpeg" } : { response_format: "b64_json" }),
    // No progressive previews: partial images can be additionally billed and consume buffering/storage.
    ...(provider.imageStream ? { stream: true, partial_images: 0 } : {}),
  };
}

export interface PreparedImageProviderRequest {
  endpoint: "/images/generations" | "/images/edits";
  contentType: string;
  body?: string;
  binaryBody?: Uint8Array;
}

function invalidReference(): never {
  throw new AiError(400, "AI_IMAGE_REFERENCE_INVALID", "参考图片内容无效、格式不匹配或不符合当前编辑模型要求，请重新添加图片", true);
}

/** Validate container structure as well as the shared signature/dimension checks.
 * This does not claim to decode pixels or establish subject identity.
 */
function validateImageContainer(bytes: Uint8Array, mimeType: string): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, size: number) => String.fromCharCode(...bytes.subarray(offset, offset + size));
  if (mimeType === "image/png") {
    let offset = 8, imageData = false;
    while (offset + 12 <= bytes.length) {
      const size = view.getUint32(offset), type = text(offset + 4, 4), end = offset + 12 + size;
      if (end > bytes.length || !/^[A-Za-z]{4}$/.test(type) || (offset === 8 && (type !== "IHDR" || size !== 13)) || (offset !== 8 && type === "IHDR")) return invalidReference();
      let crc = 0xffffffff;
      for (let i = offset + 4; i < end - 4; i++) {
        crc ^= bytes[i];
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end - 4)) return invalidReference();
      if (type === "IDAT" && size > 0) imageData = true;
      if (type === "IEND") {
        if (!imageData || size !== 0 || end !== bytes.length) return invalidReference();
        return;
      }
      offset = end;
    }
    return invalidReference();
  }
  if (mimeType === "image/webp") {
    if (view.getUint32(4, true) + 8 !== bytes.length) return invalidReference();
    let offset = 12, imageData = false;
    while (offset + 8 <= bytes.length) {
      const type = text(offset, 4), size = view.getUint32(offset + 4, true), end = offset + 8 + size;
      if (end > bytes.length || type === "ANIM" || type === "ANMF") return invalidReference();
      if (type === "VP8 " || type === "VP8L") {
        if (imageData || (type === "VP8 " ? size < 10 || text(offset + 11, 3) !== "\x9d\x01\x2a" : size < 5 || bytes[offset + 8] !== 0x2f)) return invalidReference();
        imageData = true;
      }
      offset = end + (size % 2);
    }
    if (!imageData || offset !== bytes.length) return invalidReference();
    return;
  }
  let offset = 2, frame = false, scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) return invalidReference();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!frame || !scan || offset !== bytes.length) return invalidReference();
      return;
    }
    if (offset + 2 > bytes.length || marker === 0xd8 || marker === 0) return invalidReference();
    const size = view.getUint16(offset);
    if (size < 2 || offset + size > bytes.length) return invalidReference();
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) frame = size >= 8;
    offset += size;
    if (marker === 0xda) {
      if (!frame || size < 6) return invalidReference();
      const start = offset;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; continue; }
        if (bytes[offset + 1] === 0 || (bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7)) { offset += 2; continue; }
        break;
      }
      if (offset === start) return invalidReference();
      scan = true;
    }
  }
  return invalidReference();
}

/** Pure preflight: validate before claiming an approval or reserving quota. No network request. */
export function prepareImageProviderRequest(input: {
  baseUrl: string; modelId: string; prompt: string; stream?: boolean;
  attachments?: AiAttachment[]; editCapability?: AiImageEditCapability; generationCapability?: AiImageGenerationCapability;
}): PreparedImageProviderRequest {
  const generationCapability = parseImageGenerationCapability(input.generationCapability);
  if (generationCapability && (generationCapability.baseUrl !== input.baseUrl.replace(/\/+$/, "") || generationCapability.modelId !== input.modelId)) {
    throw new AiError(400, "AI_IMAGE_GENERATION_CAPABILITY_MISMATCH", "图片生成协议与当前服务地址或模型不匹配，请管理员重新确认；图片未发送", true);
  }
  // Text documents already contributed to the approved plan prompt. Preserve that
  // text-generation path, but never discard a declared visual or its missing bytes.
  const attachments = (input.attachments ?? []).filter(attachment => {
    if (attachment.dataUrl !== undefined || /^(?:image|video)\//i.test(attachment.mediaType?.trim() ?? "")) return true;
    if (typeof attachment.text === "string" && attachment.text.trim()) return false;
    return invalidReference();
  });
  if (!attachments.length) {
    if (generationCapability && (!input.prompt.trim() || Array.from(input.prompt).length > AI_IMAGE_GENERATION_PROFILE_SPECS[generationCapability.profile].maxPromptCharacters)) {
      throw new AiError(400, "AI_IMAGE_PROMPT_INVALID", `当前图片生成提示词不能为空或超过 ${AI_IMAGE_GENERATION_PROFILE_SPECS[generationCapability.profile].maxPromptCharacters} 字`, true);
    }
    return {
      endpoint: "/images/generations", contentType: "application/json",
      body: JSON.stringify(imageProviderBody({ imageModel: input.modelId, imageStream: input.stream }, input.prompt, generationCapability)),
    };
  }
  const capability = parseImageEditCapability(input.editCapability);
  // Matching the full configured path prevents a capability surviving provider or model changes.
  if (!capability || capability.baseUrl !== input.baseUrl.replace(/\/+$/, "") || capability.modelId !== input.modelId) {
    throw new AiError(400, "AI_IMAGE_EDIT_UNSUPPORTED", "当前图片模型未配置匹配的参考图编辑能力，请管理员核对服务地址、模型和编辑协议；参考图未发送", true);
  }
  const profile = AI_IMAGE_EDIT_PROFILE_SPECS[capability.profile];
  const limit = (): never => { throw new AiError(400, "AI_IMAGE_REFERENCE_LIMIT", `当前编辑协议最多支持 ${profile.maxReferences} 张参考图，同频参考图合计不能超过 1 MiB`, true); };
  if (attachments.length > profile.maxReferences) return limit();
  if (!input.prompt.trim() || Array.from(input.prompt).length > profile.maxPromptCharacters) throw new AiError(400, "AI_IMAGE_PROMPT_INVALID", `当前图片编辑提示词不能为空或超过 ${profile.maxPromptCharacters} 字`, true);
  let totalBytes = 0;
  const references = attachments.map((attachment, index) => {
    if (typeof attachment.dataUrl !== "string") return invalidReference();
    // Check length before regex or atob; the existing API attachment budget also applies here.
    if (attachment.dataUrl.length > Math.ceil(AI_IMAGE_EDIT_MAX_INPUT_BYTES / 3) * 4 + 32) return limit();
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(attachment.dataUrl);
    if (!match || (attachment.mediaType !== undefined && attachment.mediaType !== match[1]) || !profile.mimeTypes.includes(match[1])) return invalidReference();
    const byteLength = match[2].length * 3 / 4 - (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0);
    totalBytes += byteLength;
    if (byteLength >= profile.maxReferenceBytes || totalBytes > AI_IMAGE_EDIT_MAX_INPUT_BYTES) return limit();
    let image: ReturnType<typeof validateImageBase64>;
    try { image = validateImageBase64(match[2], AI_IMAGE_EDIT_MAX_INPUT_BYTES, 400); } catch { return invalidReference(); }
    if (image.mimeType !== match[1] || (profile.squareInput && image.width !== image.height)) return invalidReference();
    const bytes = Uint8Array.from(atob(image.base64), c => c.charCodeAt(0));
    validateImageContainer(bytes, image.mimeType);
    const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice(6);
    return { bytes, mimeType: image.mimeType, filename: `reference-${index + 1}.${extension}` };
  });
  const fields: Record<string, string> = { model: input.modelId, prompt: input.prompt, n: "1", size: profile.size };
  if (profile.outputFormat === "b64_json") fields.response_format = "b64_json";
  else fields.output_format = profile.outputFormat;
  if (input.stream && profile.stream) { fields.stream = "true"; fields.partial_images = "0"; }
  const encoder = new TextEncoder();
  const fieldBytes = Object.values(fields).map(value => encoder.encode(value));
  // A random boundary is checked against every part so even deliberately chosen input cannot split parts.
  let boundary: string;
  for (;;) {
    boundary = `tongpin-image-${crypto.randomUUID()}`;
    const needle = encoder.encode(boundary);
    const contains = (bytes: Uint8Array) => bytes.some((_, offset) => offset + needle.length <= bytes.length && needle.every((byte, index) => bytes[offset + index] === byte));
    if (![...fieldBytes, ...references.map(reference => reference.bytes)].some(contains)) break;
  }
  const chunks: Uint8Array[] = [];
  for (const [key, value] of Object.entries(fields)) chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  const imageField = capability.profile === "openai-gpt-image-edits-v1" ? "image[]" : "image";
  for (const reference of references) {
    chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${imageField}"; filename="${reference.filename}"\r\nContent-Type: ${reference.mimeType}\r\n\r\n`), reference.bytes, encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const binaryBody = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { binaryBody.set(chunk, offset); offset += chunk.byteLength; }
  return { endpoint: "/images/edits", contentType: `multipart/form-data; boundary=${boundary}`, binaryBody };
}

/** Accept one complete JSON image or a standard image_generation.completed SSE event.
 * Never deliver partial images, follow URL-only results, or retry after an interrupted paid stream.
 * https://developers.openai.com/api/reference/resources/images/generation-streaming-events
 */
export async function readImageProviderResponse(response: Response): Promise<unknown> {
  const text = await readBoundedText(response, MAX_IMAGE_RESPONSE_BYTES);
  const prefix = text.trimStart();
  const isStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || /^(?:event:|data:|:)/.test(prefix);
  if (!isStream) {
    try { return JSON.parse(text) as unknown; }
    catch { throw new AiError(502, "AI_IMAGE_FORMAT_UNSUPPORTED", "图片服务未返回完整 JSON 或标准 Images SSE，请管理员核对图片接口格式"); }
  }
  let completed: string | undefined;
  // Iterate blocks without copying the entire multi-megabyte body to normalize newlines.
  const delimiter = /\r?\n\r?\n/g;
  let start = 0;
  for (;;) {
    const match = delimiter.exec(text);
    const block = text.slice(start, match?.index ?? text.length);
    const lines = block.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (data && data !== "[DONE]") {
      let event: Record<string, unknown>;
      try { event = object(JSON.parse(data)); }
      catch { throw new AiError(502, "AI_IMAGE_STREAM_INVALID", "图片数据流格式损坏，用量待管理员核对"); }
      const eventName = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
      if (eventName && typeof event.type === "string" && eventName !== event.type) throw new AiError(502, "AI_IMAGE_STREAM_INVALID", "图片数据流事件不一致，用量待管理员核对");
      const type = event.type ?? eventName;
      if (type === "error" || type === "image_generation.failed" || type === "image_edit.failed" || event.error) throw new AiError(502, "AI_IMAGE_STREAM_FAILED", "图片服务未完成生成，用量待核对；请管理员先核对服务商记录");
      if (type === "image_generation.completed" || type === "image_edit.completed") {
        if (completed !== undefined || typeof event.b64_json !== "string" || !event.b64_json) throw new AiError(502, "AI_IMAGE_STREAM_INVALID", "图片数据流未返回唯一完整图片，用量待管理员核对");
        completed = event.b64_json;
      }
      // In particular, image_generation.partial_image and [DONE] alone are not a successful image.
    }
    if (!match) break;
    start = delimiter.lastIndex;
  }
  if (!completed) throw new AiError(502, "AI_IMAGE_STREAM_INTERRUPTED", "图片数据流中断或未返回最终图片，用量待核对；请勿直接重复生成");
  return { data: [{ b64_json: completed }] };
}
