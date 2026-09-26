import { codePoints, decodeRanges, inRanges, SPACE, type CodePointRanges } from "./pyCodePoints";
import { PY_CASED, PY_CASE_IGNORABLE, PY_DIGIT, PY_LOWER, PY_WORD } from "./unicodeTables.generated";

/*
 * CPython `str`/`re` text semantics used by OpenSquilla's router features.
 * JavaScript differs in ways that change feature values: `.length` counts
 * UTF-16 units instead of code points, `\s`/`\w`/`\d`/`.` and multiline `^`
 * match different characters, `trim()`/`split()` use another whitespace set,
 * and `toLowerCase()` follows the host engine's Unicode version. Every helper
 * here reads tables probed from the reference CPython 3.12 runtime instead.
 */

// The renderer only needs whitespace and code-point helpers; they live in
// pyCodePoints.ts so the web bundle does not carry the full tables.
export { codePoints, decodeRanges, inRanges, isPySpace, pySplit, pyStrip, pyTail, type CodePointRanges } from "./pyCodePoints";

function hex(cp: number): string { return `\\u{${cp.toString(16)}}`; }

/** Regex character-class body (for use with the `u` flag). */
export function regexClass(ranges: CodePointRanges): string {
  let body = "";
  for (let index = 0; index < ranges.length; index += 2) {
    const start = ranges[index], end = ranges[index + 1];
    body += start === end ? hex(start) : `${hex(start)}-${hex(end)}`;
  }
  return body;
}

const WORD = decodeRanges(PY_WORD);
const DIGIT = decodeRanges(PY_DIGIT);
const CASED = decodeRanges(PY_CASED);
const CASE_IGNORABLE = decodeRanges(PY_CASE_IGNORABLE);

/** Class bodies equivalent to CPython `re` (str pattern) `\s`, `\w`, `\d`. */
export const RE_S = regexClass(SPACE);
export const RE_W = regexClass(WORD);
export const RE_D = regexClass(DIGIT);

let lowerMap: Map<number, string> | undefined;
function lowerTable(): Map<number, string> {
  if (lowerMap) return lowerMap;
  lowerMap = new Map();
  for (const item of PY_LOWER.split(",")) {
    const colon = item.indexOf(":");
    const cp = parseInt(item.slice(0, colon), 16);
    lowerMap.set(cp, String.fromCodePoint(...item.slice(colon + 1).split(".").map(value => parseInt(value, 16))));
  }
  return lowerMap;
}

/** Lone surrogates never reach CPython as text; treat them as U+FFFD. */
export function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** `len(text)` in CPython: code points, not UTF-16 units. */
export function pyLen(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) index += 1;
    }
    count += 1;
  }
  return count;
}

function finalSigma(cps: number[], index: number): boolean {
  // CPython unicodeobject.c handle_capital_sigma.
  let j = index - 1;
  while (j >= 0 && inRanges(CASE_IGNORABLE, cps[j])) j -= 1;
  const precededByCased = j >= 0 && inRanges(CASED, cps[j]);
  if (!precededByCased) return false;
  j = index + 1;
  while (j < cps.length && inRanges(CASE_IGNORABLE, cps[j])) j += 1;
  return j === cps.length || !inRanges(CASED, cps[j]);
}

/** `str.lower()`: full case mapping plus the final-sigma rule. */
export function pyLower(text: string): string {
  const table = lowerTable();
  const cps = codePoints(text);
  let out = "";
  for (let index = 0; index < cps.length; index += 1) {
    const cp = cps[index];
    if (cp < 0x41 || (cp > 0x5a && cp < 0xc0)) { out += String.fromCharCode(cp); continue; }
    if (cp === 0x3a3) { out += finalSigma(cps, index) ? "ς" : "σ"; continue; }
    const mapped = table.get(cp);
    out += mapped ?? String.fromCodePoint(cp);
  }
  return out;
}

/** Python `haystack.count(needle)` for a non-empty needle. */
export function pyCount(haystack: string, needle: string): number {
  let count = 0, from = 0;
  for (;;) {
    const found = haystack.indexOf(needle, from);
    if (found < 0) return count;
    count += 1;
    from = found + needle.length;
  }
}

/** Build a `u`-flag RegExp from CPython syntax restricted to what the router
 * uses: `\s \S \w \d`, `.` (no DOTALL) and MULTILINE `^`. */
export function pyRegex(source: string, flags: { multiline?: boolean; ignoreCase?: boolean; global?: boolean } = {}): RegExp {
  let out = "";
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1];
      index += 1;
      if (next === "s") out += inClass ? RE_S : `[${RE_S}]`;
      else if (next === "S") {
        if (inClass) throw new Error("\\S inside a class is not supported");
        out += `[^${RE_S}]`;
      } else if (next === "w") out += inClass ? RE_W : `[${RE_W}]`;
      else if (next === "d") out += inClass ? RE_D : `[${RE_D}]`;
      else if (next === "b" || next === "B" || next === "W" || next === "D") throw new Error(`\\${next} is not supported`);
      else if (/[A-Za-z0-9]/.test(next) || "^$\\.*+?()[]{}|/".includes(next) || (next === "-" && inClass)) out += `\\${next}`;
      // CPython treats any other escaped punctuation as the literal character;
      // the `u` flag rejects such identity escapes.
      else out += next;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      out += char;
      continue;
    }
    if (char === "[") {
      if (source.startsWith("[\\s\\S]", index)) { out += "[\\s\\S]"; index += 5; continue; }
      inClass = true;
      out += char;
      if (source[index + 1] === "^") { out += "^"; index += 1; }
      if (source[index + 1] === "]") { out += "\\]"; index += 1; }
      continue;
    }
    if (char === ".") { out += "[^\\n]"; continue; }
    if (char === "^" && flags.multiline) { out += "(?:^|(?<=\\n))"; continue; }
    out += char;
  }
  return new RegExp(out, `u${flags.ignoreCase ? "i" : ""}${flags.global ? "g" : ""}`);
}
