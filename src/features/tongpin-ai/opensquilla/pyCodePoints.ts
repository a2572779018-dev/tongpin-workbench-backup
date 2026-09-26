import { PY_SPACE } from "./unicodeTables.generated";

/*
 * Code-point helpers and CPython `str.isspace()` whitespace (`strip()`,
 * `split()`, `text[-n:]`), shared by the desktop router worker and the
 * renderer, which bounds the context it sends to the router. The regex,
 * lower-casing and word tables stay in pyText.ts.
 */

export type CodePointRanges = Uint32Array;

/** "a-b,c" hex ranges → flat [start, end, start, end, …]. */
export function decodeRanges(encoded: string): CodePointRanges {
  const parts = encoded ? encoded.split(",") : [];
  const out = new Uint32Array(parts.length * 2);
  parts.forEach((part, index) => {
    const dash = part.indexOf("-");
    const start = parseInt(dash < 0 ? part : part.slice(0, dash), 16);
    const end = dash < 0 ? start : parseInt(part.slice(dash + 1), 16);
    out[index * 2] = start;
    out[index * 2 + 1] = end;
  });
  return out;
}

export function inRanges(ranges: CodePointRanges, cp: number): boolean {
  let lo = 0, hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid * 2]) hi = mid - 1;
    else if (cp > ranges[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

export const SPACE = decodeRanges(PY_SPACE);

export function codePoints(text: string): number[] {
  const out: number[] = [];
  for (const char of text) out.push(char.codePointAt(0)!);
  return out;
}

export function isPySpace(cp: number): boolean { return inRanges(SPACE, cp); }

/** `str.strip()` with no arguments. */
export function pyStrip(text: string): string {
  const cps = codePoints(text);
  let start = 0, end = cps.length;
  while (start < end && isPySpace(cps[start])) start += 1;
  while (end > start && isPySpace(cps[end - 1])) end -= 1;
  return start === 0 && end === cps.length ? text : String.fromCodePoint(...cps.slice(start, end));
}

/** `str.split()` with no arguments. */
export function pySplit(text: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const char of text) {
    if (isPySpace(char.codePointAt(0)!)) {
      if (current) { words.push(current); current = ""; }
    } else current += char;
  }
  if (current) words.push(current);
  return words;
}

/** `text[-count:]` on code points. */
export function pyTail(text: string, count: number): string {
  const cps = codePoints(text);
  return cps.length <= count ? text : String.fromCodePoint(...cps.slice(cps.length - count));
}
