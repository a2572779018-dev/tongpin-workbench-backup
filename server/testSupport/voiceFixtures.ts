/**
 * Voice test fixtures. The base64 clips were produced locally with
 * `ffmpeg -f lavfi -i "sine=frequency=330:duration=1.2"` (libopus 6 kbit/s in
 * live WebM and Ogg; AAC 8 kbit/s in M4A); they contain a sine tone only.
 * The WebM/WAV builders reproduce the exact container shapes the recorder
 * produces, e.g. Chromium's unknown-size Segment and Clusters.
 */
export const FFMPEG_LIVE_WEBM_1200MS = [
  "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",
].join("");

export const FFMPEG_OGG_OPUS_1200MS = [
  "T2dnUwACAAAAAAAAAAA9AZaOAAAAAAgXwzcBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAD0Blo4BAAAAxpaBQAE+T3B1c1RhZ3",
  "MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAACAuwAAAAAAAD0Blo4CAAAAdZy2qjIR",
  "Fg4OEBAMDQ4NDQ8QDQ8MDQsODAwODA4NDhUVDgwMCwsMCwwLCwsLDAsLDAsLCwoMCwiDEN9/4wlhefu0R8VpTu8VCKXSoccI6WSj2zcBLzX9vA",
  "6UMNPvwAif5qgb7hlZ44hKvGiACJ/mqBvuGVnjy68GguEIn+aoG+4ZiG7INfMrtMn9CJ/mqBvuHKLFYFTJitvCwAif5qgb7hyizpwUMAif5qgb",
  "7hlZ5A9ZrKgIn+aoG+4ZVv5tm8ARVAif5qgb7hmIbsdEZB0In+aoG+4cos6/gLDMCJ/mqBvuHKLOet1LeV9ACJ/mqBvuGVnjjLhqtG0lgAif5q",
  "gb7hlW/mydDDoIn+aoG+4ZiG+PSKdTJUAIn+aoG+4cos5VgpgIn+aoG+4cos6crdcoCJ/mqBvuGVnkCfkIn+aoG+4ZVv7i8M4X4Aif5qgb7hmI",
  "b0lpCAif5qgb7hyityo8eAif5qgb7hlXKeU9oX4SCKBfH6y0HUC5zwSjCKEvCBtXviA3gG381p8IoTizbTkeiQT9uoJ4CKEvCBtXvc9NC633V/",
  "EIoaNzluO506a/GxmakJ9sXc2gWwoIobfuSD/nMDjafpj/gKnC862pSNAIoTizbTke1aFJiUE4QAihOLNtOR6CNrpkwAg5wpgKPaMZg4R2kAg5",
  "wpgKPfp9vCSACDnCmAo9yLkr9O0IOcKYCj3I5lMGN3AIOcKYCj2WCXjrQAg5wpgKPa9a6urfIAg5wpgKPfpWeo6uCDnCmAo9yJkhZZgIOcKYCj",
  "36WJJ1wAg5wpgKPa90V6yACDnCmAo9r3UQ4yFYCDnCmAo9yLouH6AIOcKYCj3ps6a5vAg5wpgKPfrHfzZWYAg5wpgKPa9AE39ACDnCmAo9u+c9",
  "nmQIOcKYCj3I5D8/9gg5wpgKPenr7ygIOcKYCj36x8j5dRsIOcKYCj2vbas3uE9nZ1MABDjiAAAAAAAAPQGWjgMAAADKNg4CCwsMCwsLCgwLCw",
  "wOCDnCmAo9r0RBRsAIOcKYCj3I74RYcLAIOcKYCj3ImSFlmAg5wpgKPenvFu60CDnCmAo9ljdJWb4IOcKYCj2vP7DgCDnCmAo9yPZ2DcPQCDnC",
  "mAo9yJhoOZQIOcKYCj3I+RYC0gg5wpgKPZZzNRpf/QgGMKrBuHd+lEYpC25j",
].join("");

export const FFMPEG_M4A_AAC_1200MS = [
  "AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAAF2m1kYXTeAgBMYXZjNjAuMzEuMTAyAAI8pVngScRWd/n3/ncu8uSRESJESR",
  "Bi2I5izDmLFdjaN2No3Y2xdjbF4u415q7J0dsXY3FvG3NOYs05i0bs7jWLRjMVO4ViqZVYmzkbnT56+F9Z7muozprWhgYGBgYGBgYGBgYGNm5Z",
  "USKWU3LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL",
  "LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLwAQ6c2Yl9ZL0TZL0TZL0S/1/7f4/nzxrXGrnX6f/t/2/0/fzxfWru3f/1",
  "/6f4/nzxrjV3qZ//F/8f4/nzxrji9XgjswQbo6OjoNQDUUULorMAFhVC9i9xQLM+jubX0rWEEDEyjiyj5PUcSYKDfL5PDXR8vk8NdHy+TBro+X",
  "yiATr3UfKEkMAGvcYyAAiLl3lMOctJeInQkLAIKiZPE9PE9OqKJ56eeKLnennii53p54ovo9POqKKLn575551FFEX08/NN8VyENRML29AwQaii",
  "iiiiiiiiiig1FFC0RwEi8osixVb7+f+K/+2r41d3JJJJdRYp5+egM/uBk+AE+5A/wA6Am4A3v76APgDP7gZPhsO+8IyfDYz+8IyfDYd9yD/wYO",
  "+5DJ8AZ/cDJ8AO+5D4+DJ9/ch5OQ/hBixlvEeTwmX32fpFKVrGGZAxIr2MfAJABEICN8viQwzQygIhGZAoA4AA+jKH5nXNb5//1fP/+3zrWu55",
  "+dV131vjffRU9ed/H28iwyUo9VrbFtjZsKQNhssiftGOzsaBERw2oKhRHNULC1E1kFaDLIURC7KOFEJ2CgSFAQJAFRW0YAAIhmUXyJQwAIhGaS",
  "LOXsOAAPYyh+Y7m9//4Z//w66l86nN5rnzk5kvJzuccfPkVL3F1KG9v3lNBvu30b6X3m8QvRBUuqTsXVJ2CpNRgVQCCoJFSbEMYnKgIEokkCQA",
  "FgoAEAzWEayRuQmBSIL2kg2k0jgA+DKH5nHhnP/+n7f/7fOr48da+3mqzicc83XWby3H6fcVF/QQV1GpXUSiaoNUECsGrUTIQWJ1kJE65ULgsE",
  "kVEF5Uu2gQuIXyiskQuy0wTIp0CQALZwzgBAL2F0kLkLgUAETOKjgA+jKH5mt5Xf/+Gf//PPEma8+97456yPGuOdZvTj9PgWNbWjhSlrlrlr1k",
  "sxrNc2uSSaUl0kSWH9ce0vUKIQrIVCSaSARSRCARUG+0c2SVBRERTqjMiUAX2hliAUEmGxCdqL1ShMCgE60FgocA9DKH5l91vn//l+3/+3rq9V",
  "Xn3rLrzUrcrrOdtefnoeMi2I3W2Gxs2G2BsNhs2W2RbP2izVtEtsjNUvYJEwWJ2ogohGwVRJUTELyFqFxFnlhupFOyJQAF5BQAIhAIqI1ShcCk",
  "AFBUmHABHlKFJTFKs3z4/+k/8vrq9S7uWlri0KjXrof4U/pmS/xobf6HyNpS5oPtcPn84xh9rhJ8zAfYgPnGD/a4SfOMH+32EnzjB/tcE/PeD/",
  "a4J+YHh9toT17xh9vYfP57wfUQk+cYP9rwnf8U/ug/WKmah8lHELkF/aisgAIhGw0kM00gBAI3IFkbpHABFp2xiXgqyXomyn1kvn9/+n+n7+eN",
  "ca1cv1/+3/T/H7+eNcavUv+//b9Pv7cXrV3etff/6f34/HV3ctIGqw6xgHCAswKhRUTxUc0VFHNPEKKPlzRCij5c0Qoo+XyiFFFHy+XMQREe32",
  "wADfehANjdwwm+NG81JOhCFmMTccWtUX0VF9G5xxi+n0UOMX0+k44xfT6KHyi+n0+ilD5fL5bvp9DAAfLjEX8tc7AQ00PuH5wAunw8PDw8PDw8",
  "PDw8PDw8PDw8PDw8PDy77O/EryGb8fj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+OABGIG0cAAAAydtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAA",
  "AEsAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC",
  "AAACUXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAEsAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAA",
  "AAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAABLAAAAQAAAEAAAAAAcltZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAA",
  "AB9AAAApgFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAF0bWluZgAAABBzbWhkAAAAAAAAAAAAAA",
  "AkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAE4c3RibAAAAGpzdHNkAAAAAAAAAAEAAABabXA0YQAAAAAAAAABAAAAAAAAAAAA",
  "AQAQAAAAAB9AAAAAAAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAACMPAAAjDwWAgIAFFYhW5QAGgICAAQIAAAAgc3R0cwAAAAAAAAACAA",
  "AACgAABAAAAAABAAABgAAAABxzdHNjAAAAAAAAAAEAAAABAAAACwAAAAEAAABAc3RzegAAAAAAAAAAAAAACwAAAPQAAADcAAAAhQAAAGoAAABi",
  "AAAAZgAAAGwAAABpAAAAigAAAOcAAAAFAAAAFHN0Y28AAAAAAAAAAQAAACwAAAAac2dwZAEAAAByb2xsAAAAAgAAAAH//wAAABxzYmdwAAAAAH",
  "JvbGwAAAABAAAACwAAAAEAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0",
  "b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMA==",
].join("");

export function bytesFromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function concat(parts: ArrayLike<number>[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function ebmlSize(value: number): number[] {
  for (let length = 1; length <= 8; length += 1) {
    if (value < 2 ** (7 * length) - 1) {
      const bytes: number[] = [];
      let rest = value;
      for (let index = 0; index < length; index += 1) { bytes.unshift(rest % 256); rest = Math.floor(rest / 256); }
      bytes[0] |= 0x80 >> (length - 1);
      return bytes;
    }
  }
  throw new Error("size too large");
}

function uintBytes(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  do { bytes.unshift(rest % 256); rest = Math.floor(rest / 256); } while (rest > 0);
  return bytes;
}

const element = (id: number[], payload: ArrayLike<number>) => concat([id, ebmlSize(payload.length), payload]);
const text = (value: string) => Array.from(new TextEncoder().encode(value));
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/** Live WebM laid out like Chromium's MediaRecorder output: unknown-size
 * Segment and Clusters, no Duration element, 20 ms Opus SimpleBlocks. */
export function chromeLikeWebm({ durationMs, frameMs = 20, clusterMs = 1000, truncateLastBlock = false }: {
  durationMs: number; frameMs?: number; clusterMs?: number; truncateLastBlock?: boolean;
}): Uint8Array<ArrayBuffer> {
  const header = element([0x1a, 0x45, 0xdf, 0xa3], concat([
    element([0x42, 0x86], [1]), element([0x42, 0xf7], [1]), element([0x42, 0xf2], [4]), element([0x42, 0xf3], [8]),
    element([0x42, 0x82], text("webm")), element([0x42, 0x87], [4]), element([0x42, 0x85], [2]),
  ]));
  const info = element([0x15, 0x49, 0xa9, 0x66], concat([
    element([0x2a, 0xd7, 0xb1], uintBytes(1_000_000)), element([0x4d, 0x80], text("Chrome")), element([0x57, 0x41], text("Chrome")),
  ]));
  const tracks = element([0x16, 0x54, 0xae, 0x6b], element([0xae], concat([
    element([0xd7], [1]), element([0x73, 0xc5], [0x12, 0x34]), element([0x83], [2]), element([0x86], text("A_OPUS")),
  ])));
  const parts: Uint8Array[] = [header, concat([[0x18, 0x53, 0x80, 0x67], UNKNOWN_SIZE]), info, tracks];
  const frames = Math.max(1, Math.round(durationMs / frameMs));
  let clusterStart = -1;
  for (let frame = 0; frame < frames; frame += 1) {
    const timestamp = frame * frameMs;
    if (clusterStart < 0 || timestamp - clusterStart >= clusterMs) {
      clusterStart = timestamp;
      parts.push(concat([[0x1f, 0x43, 0xb6, 0x75], UNKNOWN_SIZE]), element([0xe7], uintBytes(clusterStart)));
    }
    const relative = timestamp - clusterStart;
    const block = element([0xa3], [0x81, relative >> 8 & 0xff, relative & 0xff, 0x80, 0xfc, 0xff, 0xfe, 0x01, 0x02, 0x03]);
    parts.push(truncateLastBlock && frame === frames - 1 ? block.slice(0, block.length - 3) : block);
  }
  return concat(parts);
}

/** 16-bit mono PCM WAV of silence. */
export function pcmWav({ durationMs, sampleRate = 8000 }: { durationMs: number; sampleRate?: number }): Uint8Array<ArrayBuffer> {
  const dataBytes = Math.round(sampleRate * durationMs / 1000) * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0); view.setUint32(4, 36 + dataBytes, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36); view.setUint32(40, dataBytes, true);
  return bytes;
}

/** An ID3-tagged MP3 prefix: a real audio format the voice route refuses. */
export const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]);
