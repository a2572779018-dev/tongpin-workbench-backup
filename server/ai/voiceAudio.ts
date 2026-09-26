import { AI_VOICE_LIMITS } from "../../shared/aiVoice";
import { AiError } from "./security";

/**
 * Container checks, duration reading and multipart helpers for the voice
 * routes. Everything here runs unchanged in Node (Express) and in the Worker:
 * only Web APIs are used, and nothing is logged or retained.
 *
 * The accepted container list and the language-code rule follow LibreChat
 * v0.8.7 `api/server/services/Files/Audio/STTService.js`
 * (`MIME_TO_EXTENSION_MAP`, `getValidatedLanguageCode`); MP3 is deliberately
 * not accepted because its duration cannot be verified cheaply.
 */
export type AudioContainer = "webm" | "ogg" | "wav" | "mp4";

const DECLARED_TYPES: Readonly<Record<string, AudioContainer>> = {
  "audio/webm": "webm", "video/webm": "webm",
  "audio/ogg": "ogg", "application/ogg": "ogg", "audio/opus": "ogg",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/vnd.wave": "wav",
  "audio/mp4": "mp4", "audio/x-m4a": "mp4", "audio/m4a": "mp4", "video/mp4": "mp4",
};
export const AUDIO_CONTAINER_FORMATS: Readonly<Record<AudioContainer, { extension: string; mimeType: string }>> = {
  webm: { extension: "webm", mimeType: "audio/webm" },
  ogg: { extension: "ogg", mimeType: "audio/ogg" },
  wav: { extension: "wav", mimeType: "audio/wav" },
  mp4: { extension: "m4a", mimeType: "audio/mp4" },
};

const ascii = (bytes: Uint8Array, offset: number, text: string) => {
  if (offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index += 1) if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  return true;
};
const u16le = (bytes: Uint8Array, offset: number) => bytes[offset] | bytes[offset + 1] << 8;
const u32le = (bytes: Uint8Array, offset: number) => (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16) + bytes[offset + 3] * 0x1000000;
const u32be = (bytes: Uint8Array, offset: number) => bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]);
/** 64-bit values above 2^53 are rejected rather than rounded. */
const u64le = (bytes: Uint8Array, offset: number) => { const high = u32le(bytes, offset + 4); return high > 0x1fffff ? null : high * 0x100000000 + u32le(bytes, offset); };
const u64be = (bytes: Uint8Array, offset: number) => { const high = u32be(bytes, offset); return high > 0x1fffff ? null : high * 0x100000000 + u32be(bytes, offset + 4); };

export function sniffAudioContainer(bytes: Uint8Array): AudioContainer | null {
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  if (ascii(bytes, 0, "OggS")) return "ogg";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "wav";
  if (ascii(bytes, 4, "ftyp")) return "mp4";
  return null;
}

/** Lower-cased MIME essence ("audio/webm;codecs=opus" -> "audio/webm"). */
export function audioMimeEssence(value: string): string {
  return value.split(";")[0].trim().toLowerCase();
}

/** The declared Blob type may be empty or generic, but never a different container. */
export function declaredAudioContainer(value: string): AudioContainer | "generic" | null {
  const essence = audioMimeEssence(value);
  if (!essence || essence === "application/octet-stream") return "generic";
  return DECLARED_TYPES[essence] ?? null;
}

// ---------------------------------------------------------------- WebM / Matroska
const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const INFO_DURATION = 0x4489;
const CLUSTER = 0x1f43b675;
const CLUSTER_TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const BLOCK_DURATION = 0x9b;
/** Segment children; one of these after an unknown-size Cluster ends that Cluster. */
const SEGMENT_CHILDREN = new Set([0x114d9b74, INFO, 0x1654ae6b, CLUSTER, 0x1c53bb6b, 0x1043a770, 0x1254c367, 0x1941a469, EBML_HEADER, SEGMENT]);

interface EbmlElement { id: number; size: number; unknown: boolean; dataStart: number }

function readVint(bytes: Uint8Array, offset: number, keepMarker: boolean): { value: number; length: number; allOnes: boolean } | null {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  let length = 1, mask = 0x80;
  while (!(first & mask)) { mask >>= 1; length += 1; }
  if (length > 8 || offset + length > bytes.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[offset + index];
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, allOnes };
}

function readElement(bytes: Uint8Array, offset: number): EbmlElement | null {
  const id = readVint(bytes, offset, true);
  if (!id || id.length > 4) return null;
  const size = readVint(bytes, offset + id.length, false);
  if (!size) return null;
  if (!size.allOnes && !Number.isSafeInteger(size.value)) return null;
  return { id: id.value, size: size.value, unknown: size.allOnes, dataStart: offset + id.length + size.length };
}

function readUnsigned(bytes: Uint8Array, start: number, size: number): number | null {
  if (size > 7 || start + size > bytes.length) return null;
  let value = 0;
  for (let index = 0; index < size; index += 1) value = value * 256 + bytes[start + index];
  return value;
}

function readFloat(bytes: Uint8Array, start: number, size: number): number | null {
  if (start + size > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, size);
  const value = size === 4 ? view.getFloat32(0) : size === 8 ? view.getFloat64(0) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Duration of a Matroska/WebM audio stream. Chromium's MediaRecorder writes a
 * "live" file: unknown-size Segment and Clusters and no Duration element, so
 * the duration is taken from the last block timestamp plus one frame.
 */
export function webmDurationMs(bytes: Uint8Array): number | null {
  const header = readElement(bytes, 0);
  if (!header || header.id !== EBML_HEADER || header.unknown) return null;
  const segment = readElement(bytes, header.dataStart + header.size);
  if (!segment || segment.id !== SEGMENT) return null;
  const segmentEnd = segment.unknown ? bytes.length : Math.min(bytes.length, segment.dataStart + segment.size);
  let timecodeScale = 1_000_000, infoDuration: number | null = null;
  let clusterEnd = -1, clusterTimecode: number | null = null;
  let first = Infinity, last = -Infinity, previous: number | null = null, frame = 0, blockDuration = 0;
  const recordBlock = (start: number, end: number) => {
    if (clusterTimecode === null) return;
    const track = readVint(bytes, start, false);
    if (!track || start + track.length + 2 > end) return;
    const offset = start + track.length;
    const relative = (bytes[offset] << 8 | bytes[offset + 1]) << 16 >> 16;
    const timestamp = clusterTimecode + relative;
    if (previous !== null && timestamp > previous) frame = timestamp - previous;
    previous = timestamp;
    first = Math.min(first, timestamp);
    if (timestamp >= last) { last = timestamp; blockDuration = 0; }
  };
  let position = segment.dataStart;
  for (let steps = 0; position < segmentEnd; steps += 1) {
    if (steps > 400_000) return null;
    if (clusterEnd >= 0 && position >= clusterEnd) clusterEnd = -1;
    const element = readElement(bytes, position);
    if (!element) break;
    if (element.id === CLUSTER) {
      clusterTimecode = null;
      clusterEnd = element.unknown ? segmentEnd : Math.min(segmentEnd, element.dataStart + element.size);
      position = element.dataStart;
      continue;
    }
    if (clusterEnd >= 0 && SEGMENT_CHILDREN.has(element.id)) clusterEnd = -1;
    if (element.unknown) return null;
    const dataEnd = element.dataStart + element.size;
    // A recorder stopped mid-write can leave a partial final block; keep what was complete.
    if (dataEnd > bytes.length) break;
    if (clusterEnd < 0 && element.id === INFO) {
      for (let child = element.dataStart; child < dataEnd;) {
        const item = readElement(bytes, child);
        if (!item || item.unknown || item.dataStart + item.size > dataEnd) break;
        if (item.id === TIMECODE_SCALE) timecodeScale = readUnsigned(bytes, item.dataStart, item.size) || timecodeScale;
        if (item.id === INFO_DURATION) infoDuration = readFloat(bytes, item.dataStart, item.size);
        child = item.dataStart + item.size;
      }
    } else if (clusterEnd >= 0) {
      if (element.id === CLUSTER_TIMECODE) clusterTimecode = readUnsigned(bytes, element.dataStart, element.size);
      else if (element.id === SIMPLE_BLOCK) recordBlock(element.dataStart, dataEnd);
      else if (element.id === BLOCK_GROUP) {
        let groupStart = -1, duration = 0;
        for (let child = element.dataStart; child < dataEnd;) {
          const item = readElement(bytes, child);
          if (!item || item.unknown || item.dataStart + item.size > dataEnd) break;
          if (item.id === BLOCK) groupStart = child;
          if (item.id === BLOCK_DURATION) duration = readUnsigned(bytes, item.dataStart, item.size) ?? 0;
          child = item.dataStart + item.size;
        }
        if (groupStart >= 0) {
          const block = readElement(bytes, groupStart)!;
          recordBlock(block.dataStart, block.dataStart + block.size);
          if (previous === last && duration > 0) blockDuration = duration;
        }
      }
    }
    position = dataEnd;
  }
  const scaleMs = timecodeScale / 1_000_000;
  if (infoDuration !== null && infoDuration > 0) return Math.round(infoDuration * scaleMs);
  if (!Number.isFinite(first) || last < first) return null;
  // Opus packets from MediaRecorder are 20-60 ms; bound an unusual gap.
  const tail = blockDuration || Math.min(Math.max(frame, 0), 120 / scaleMs) || 20 / scaleMs;
  return Math.round((last - first + tail) * scaleMs);
}

// ---------------------------------------------------------------- Ogg (Opus / Vorbis)
export function oggDurationMs(bytes: Uint8Array): number | null {
  if (!ascii(bytes, 0, "OggS") || bytes.length < 28) return null;
  const segments = bytes[26];
  const payload = 27 + segments;
  if (payload + 8 > bytes.length) return null;
  let sampleRate: number, preSkip = 0;
  if (ascii(bytes, payload, "OpusHead")) {
    if (payload + 12 > bytes.length) return null;
    sampleRate = 48_000;
    preSkip = u16le(bytes, payload + 10);
  } else if (bytes[payload] === 1 && ascii(bytes, payload + 1, "vorbis")) {
    if (payload + 16 > bytes.length) return null;
    sampleRate = u32le(bytes, payload + 12);
  } else return null;
  if (!sampleRate) return null;
  for (let offset = bytes.length - 27; offset >= 0; offset -= 1) {
    if (bytes[offset] !== 0x4f || !ascii(bytes, offset, "OggS") || bytes[offset + 4] !== 0) continue;
    // -1 granule marks a page on which no packet ends.
    if (u32le(bytes, offset + 6) === 0xffffffff && u32le(bytes, offset + 10) === 0xffffffff) continue;
    const granule = u64le(bytes, offset + 6);
    if (granule === null) return null;
    return Math.round(Math.max(0, granule - preSkip) * 1000 / sampleRate);
  }
  return null;
}

// ---------------------------------------------------------------- WAV
export function wavDurationMs(bytes: Uint8Array): number | null {
  if (!ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WAVE")) return null;
  let byteRate = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = u32le(bytes, offset + 4);
    if (ascii(bytes, offset, "fmt ") && offset + 20 <= bytes.length) byteRate = u32le(bytes, offset + 16);
    if (ascii(bytes, offset, "data")) {
      if (!byteRate) return null;
      const available = bytes.length - offset - 8;
      // Streaming writers leave 0 or 0xFFFFFFFF until the file is finalized.
      const dataSize = size === 0 || size === 0xffffffff || size > available ? available : size;
      return Math.round(dataSize * 1000 / byteRate);
    }
    offset += 8 + size + (size & 1);
  }
  return null;
}

// ---------------------------------------------------------------- MP4 / M4A
function mp4Children(bytes: Uint8Array, start: number, end: number, visit: (type: string, dataStart: number, dataEnd: number) => boolean | void): void {
  for (let offset = start, steps = 0; offset + 8 <= end && steps < 10_000; steps += 1) {
    let size = u32be(bytes, offset), header = 8;
    if (size === 1) { const large = u64be(bytes, offset + 8); if (large === null) return; size = large; header = 16; }
    else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) return;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (visit(type, offset + header, offset + size) === true) return;
    offset += size;
  }
}

/** Movie header duration, or the fragmented-movie extends header duration. */
export function mp4DurationMs(bytes: Uint8Array): number | null {
  let timescale = 0, duration = 0, fragmented = 0;
  mp4Children(bytes, 0, bytes.length, (type, start, end) => {
    if (type !== "moov") return;
    mp4Children(bytes, start, end, (child, childStart, childEnd) => {
      if (child === "mvhd" && childEnd - childStart >= 20) {
        const version = bytes[childStart];
        if (version === 1 && childEnd - childStart >= 32) { timescale = u32be(bytes, childStart + 20); duration = u64be(bytes, childStart + 24) ?? 0; }
        else { timescale = u32be(bytes, childStart + 12); duration = u32be(bytes, childStart + 16); }
      }
      if (child === "mvex") {
        mp4Children(bytes, childStart, childEnd, (extension, extensionStart, extensionEnd) => {
          if (extension !== "mehd" || extensionEnd - extensionStart < 8) return;
          fragmented = bytes[extensionStart] === 1 ? u64be(bytes, extensionStart + 4) ?? 0 : u32be(bytes, extensionStart + 4);
        });
      }
    });
    return true;
  });
  const units = duration > 0 && duration !== 0xffffffff ? duration : fragmented;
  return timescale > 0 && units > 0 ? Math.round(units * 1000 / timescale) : null;
}

export function audioDurationMs(bytes: Uint8Array, container: AudioContainer): number | null {
  try {
    if (container === "webm") return webmDurationMs(bytes);
    if (container === "ogg") return oggDurationMs(bytes);
    if (container === "wav") return wavDurationMs(bytes);
    return mp4DurationMs(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- multipart
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  const first = needle[0];
  for (let index = haystack.indexOf(first); index >= 0 && index + needle.length <= haystack.length; index = haystack.indexOf(first, index + 1)) {
    let match = true;
    for (let offset = 1; offset < needle.length; offset += 1) if (haystack[index + offset] !== needle[offset]) { match = false; break; }
    if (match) return index;
  }
  return -1;
}

/** multipart/form-data body for a provider call; the boundary never occurs in any part. */
export function encodeMultipartForm(
  fields: ReadonlyArray<readonly [string, string]>,
  file: { name: string; filename: string; contentType: string; bytes: Uint8Array },
): { contentType: string; body: Uint8Array<ArrayBuffer> } {
  const encoder = new TextEncoder();
  const encodedFields = fields.map(([name, value]) => {
    if (!/^[a-z_]{1,40}$/.test(name) || /[\r\n]/.test(value)) throw new AiError(400, "AI_VOICE_REQUEST_INVALID", "语音请求参数不正确", true);
    return [name, encoder.encode(value)] as const;
  });
  let boundary = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `tongpin-voice-${crypto.randomUUID()}`;
    const needle = encoder.encode(candidate);
    if (indexOfBytes(file.bytes, needle) < 0 && encodedFields.every(([, value]) => indexOfBytes(value, needle) < 0)) { boundary = candidate; break; }
  }
  if (!boundary) throw new AiError(500, "AI_VOICE_REQUEST_INVALID", "语音请求无法编码，请重新录制", true);
  const chunks: Uint8Array[] = [];
  for (const [name, value] of encodedFields) chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`), value, encoder.encode("\r\n"));
  chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`), file.bytes, encoder.encode(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

/** Reads a request body without ever buffering more than `limit` bytes. */
export async function readBoundedRequestBytes(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get("content-length"));
  const tooLarge = () => new AiError(413, "AI_VOICE_AUDIO_TOO_LARGE", "录音文件过大，单次最多 10 MB、60 秒");
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  if (!request.body) throw new AiError(400, "AI_VOICE_UPLOAD_INVALID", "没有收到录音文件");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw tooLarge(); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError(400, "AI_VOICE_UPLOAD_INVALID", "录音上传中断，请重新录制");
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export interface VoiceTranscriptionUpload {
  requestId: unknown;
  durationMs: unknown;
  language: unknown;
  declaredType: string;
  audio: Uint8Array<ArrayBuffer>;
}

/** Parses the member's multipart upload with the platform FormData parser
 * (workerd and Node's undici both implement it) after a bounded read. */
export async function parseTranscriptionUpload(request: Request): Promise<VoiceTranscriptionUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType) || !/boundary=/i.test(contentType)) {
    throw new AiError(415, "AI_VOICE_UPLOAD_INVALID", "请以 multipart/form-data 上传录音");
  }
  const body = await readBoundedRequestBytes(request, AI_VOICE_LIMITS.uploadBytes);
  let form: FormData;
  try {
    form = await new Request("https://tongpin.invalid/voice-upload", { method: "POST", headers: { "content-type": contentType }, body }).formData();
  } catch {
    throw new AiError(400, "AI_VOICE_UPLOAD_INVALID", "录音上传格式不正确，请重新录制");
  }
  const audio = form.get("audio");
  if (!audio || typeof audio === "string") throw new AiError(400, "AI_VOICE_UPLOAD_INVALID", "没有收到录音文件");
  if (audio.size > AI_VOICE_LIMITS.maxAudioBytes) throw new AiError(413, "AI_VOICE_AUDIO_TOO_LARGE", "录音文件过大，单次最多 10 MB、60 秒");
  if (audio.size === 0) throw new AiError(400, "AI_VOICE_AUDIO_EMPTY", "录音内容为空，请重新录制");
  const text = (name: string) => { const value = form.get(name); return typeof value === "string" ? value : undefined; };
  return {
    requestId: text("requestId"),
    durationMs: text("durationMs"),
    language: text("language"),
    declaredType: audio.type ?? "",
    audio: new Uint8Array(await audio.arrayBuffer()),
  };
}

/** ISO-639-1 code from "zh", "zh-CN" or "en-US"; anything else is ignored. */
export function validatedLanguageCode(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[a-z]{2}(?:-[a-z]{2})?$/i.test(value.trim())) return undefined;
  return value.trim().slice(0, 2).toLowerCase();
}
