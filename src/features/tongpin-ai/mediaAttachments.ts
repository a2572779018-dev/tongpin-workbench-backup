import { AI_MEDIA_LIMITS, videoSampleTimes } from "../../../shared/aiMedia";
import { AttachmentError, validateAttachments, type ExtractedAttachment } from "./attachments";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
const checkAbort = (signal?: AbortSignal) => signal?.throwIfAborted();

/** Inspect dimensions before asking a browser decoder to allocate an image surface. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0; let height = 0;
  if (bytes.length >= 24 && bytes[0] === 137 && String.fromCharCode(...bytes.subarray(1, 4)) === "PNG" && view.getUint32(12) === 0x49484452) {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += length;
    }
  } else if (bytes.length >= 30 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
    const format = String.fromCharCode(...bytes.subarray(12, 16));
    if (format === "VP8X") {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (format === "VP8L" && bytes[20] === 0x2f) {
      width = 1 + bytes[21] + ((bytes[22] & 63) << 8);
      height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10);
    } else if (format === "VP8 " && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
    }
  }
  if (!width || !height) throw new AttachmentError("图片格式无效，支持 PNG、JPEG 和 WebP");
  if (width > AI_MEDIA_LIMITS.imageDimension || height > AI_MEDIA_LIMITS.imageDimension || width * height > AI_MEDIA_LIMITS.imagePixels) {
    throw new AttachmentError("图片分辨率过大，请缩小到 2400 万像素、单边 8192 像素以内后添加");
  }
  return { width, height };
}

function waitForMedia(element: HTMLMediaElement | HTMLImageElement, event: string, action: () => void, signal?: AbortSignal, milliseconds = 12_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); element.removeEventListener(event, done); element.removeEventListener("error", failed); signal?.removeEventListener("abort", aborted); };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new AttachmentError("当前设备无法解码此文件，请转换为 JPEG 图片或 H.264 MP4 视频后重试")); };
    const aborted = () => { cleanup(); reject(signal?.reason ?? new DOMException("已取消附件读取", "AbortError")); };
    const timer = setTimeout(() => { cleanup(); reject(new AttachmentError("附件读取超时，请缩短视频或压缩文件后重试")); }, milliseconds);
    element.addEventListener(event, done, { once: true }); element.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    try { action(); } catch (error) { cleanup(); reject(error); }
  });
}

async function blobDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => { reader.abort(); cleanup(); reject(signal?.reason ?? new DOMException("已取消附件读取", "AbortError")); };
    reader.onload = () => { cleanup(); resolve(String(reader.result)); };
    reader.onerror = () => { cleanup(); reject(new AttachmentError("图片读取失败，请重新添加")); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    reader.readAsDataURL(blob);
  });
}

/** Yield during encoding. Nothing is synchronously base64-encoded on the pointer/UI path. */
async function compressedFrame(source: CanvasImageSource, width: number, height: number, signal?: AbortSignal): Promise<string> {
  checkAbort(signal);
  if (!width || !height || width * height > AI_MEDIA_LIMITS.imagePixels) throw new AttachmentError("图片或视频分辨率过大，请缩小后添加");
  const canvas = document.createElement("canvas");
  try {
    for (const maxSide of [AI_MEDIA_LIMITS.frameDimension, 768, 512]) {
      checkAbort(signal);
      const ratio = Math.min(1, maxSide / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new AttachmentError("当前设备无法处理图片，请重新打开同频后重试");
      context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new AttachmentError("图片压缩失败")), "image/jpeg", 0.78));
      checkAbort(signal);
      if (blob.size <= AI_MEDIA_LIMITS.frameBytes) return blobDataUrl(blob, signal);
    }
    throw new AttachmentError("图片无法压缩到发送大小，请裁剪需要分析的区域后重试");
  } finally { canvas.width = 0; canvas.height = 0; }
}

async function imageAttachment(file: File, signal?: AbortSignal): Promise<ExtractedAttachment> {
  if (file.size > AI_MEDIA_LIMITS.imageFileBytes) throw new AttachmentError("单张图片最大 12 MB，请压缩后添加");
  const bytes = new Uint8Array(await file.arrayBuffer()); checkAbort(signal);
  const dimensions = imageDimensions(bytes);
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  try {
    await waitForMedia(image, "load", () => { image.src = url; }, signal);
    const dataUrl = await compressedFrame(image, image.naturalWidth || dimensions.width, image.naturalHeight || dimensions.height, signal);
    return { name: file.name, mediaType: "image/jpeg", text: `图片：${file.name}`, warnings: [], media: { kind: "image", frames: [{ dataUrl }] } };
  } finally { image.removeAttribute("src"); URL.revokeObjectURL(url); }
}

async function videoAttachment(file: File, signal?: AbortSignal): Promise<ExtractedAttachment> {
  if (file.size > AI_MEDIA_LIMITS.videoFileBytes) throw new AttachmentError("单个视频最大 50 MB，请压缩或截取片段后添加");
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  video.preload = "metadata"; video.muted = true; video.playsInline = true;
  try {
    await waitForMedia(video, "loadedmetadata", () => { video.src = url; video.load(); }, signal);
    const durationSeconds = video.duration;
    const times = videoSampleTimes(durationSeconds);
    if (!video.videoWidth || !video.videoHeight || video.videoWidth * video.videoHeight > AI_MEDIA_LIMITS.imagePixels) throw new AttachmentError("视频分辨率过大或没有可读取画面");
    if (video.readyState < 2) await waitForMedia(video, "loadeddata", () => { video.preload = "auto"; }, signal);
    const frames: Array<{ dataUrl: string; timeSeconds: number }> = [];
    for (const sample of times) {
      checkAbort(signal);
      // A freshly loaded paused <video> may report HAVE_CURRENT_DATA while its
      // initial frame still paints blank. Force a seek even for the first sample.
      const timeSeconds = sample === 0 ? Math.min(0.001, durationSeconds / 2) : sample;
      await waitForMedia(video, "seeked", () => { video.currentTime = timeSeconds; }, signal);
      frames.push({ timeSeconds, dataUrl: await compressedFrame(video, video.videoWidth, video.videoHeight, signal) });
    }
    return { name: file.name, mediaType: file.type || "video/mp4", text: `视频：${file.name}，时长 ${durationSeconds.toFixed(2)} 秒。仅分析 ${frames.length} 个采样画面，不含音频，未采样片段未知。`,
      warnings: ["视频仅分析采样画面，不含声音；关键细节可另附截图"], media: { kind: "video", durationSeconds, frames } };
  } finally { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}

export async function extractMediaAttachment(file: File, signal?: AbortSignal): Promise<ExtractedAttachment> {
  checkAbort(signal);
  if (!file.size || !file.name.trim() || file.name.length > 160 || /[\u0000-\u001f\u007f]/.test(file.name)) throw new AttachmentError("文件为空或名称无效，请重新选择");
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  const timeout = setTimeout(() => controller.abort(new AttachmentError("附件处理超时，请压缩图片或缩短视频后重试")), 45_000);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    const result = IMAGE_EXTENSIONS.includes(extension) ? await imageAttachment(file, controller.signal) : await videoAttachment(file, controller.signal);
    checkAbort(controller.signal); validateAttachments([result]); return result;
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}
