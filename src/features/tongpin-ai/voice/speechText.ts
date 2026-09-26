/**
 * Text prepared for speech synthesis from an assistant reply.
 *
 * Markdown syntax, code, formulas, links, citation markers and rich-content
 * blocks are removed so a voice reads the answer, not its markup. Chunking
 * adapts LibreChat v0.8.7 `api/server/services/Files/Audio/streamAudio.js`
 * `splitTextIntoChunks` (cut at the last sentence separator inside a window)
 * with Chinese punctuation added to the separator list.
 */

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+.#-]*)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

function fenceSummary(language: string): string {
  const label = language.toLowerCase();
  if (label === "followups") return "";
  if (label === "chart") return "此处省略图表。";
  if (label === "cards") return "此处省略数据卡片。";
  if (label === "mermaid") return "此处省略图示。";
  if (label === "math" || label === "latex" || label === "katex" || label === "tex") return "此处省略公式。";
  return "此处省略代码。";
}

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'" };

function inlineSpeech(line: string): string {
  return line
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, "")
    .replace(/^\s{0,3}(?:>\s?)+/, "")
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[\d{1,3}(?:\s*[,，、–-]\s*\d{1,3})*\]/g, "")
    .replace(/【\d{1,3}(?:[^】\n]{0,24})?】/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<https?:\/\/[^>]+>/gi, "")
    .replace(/\b(?:https?:\/\/|www\.)[^\s)）\]】>，。；]+/gi, "")
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, "")
    .replace(/[-]/g, "")
    .replace(/<sup>[^<]*<\/sup>/gi, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\\\(([\s\S]*?)\\\)/g, "（公式）")
    .replace(/\$([^$\n]+)\$/g, (match, body: string) => /[\\^_{}]/.test(body) && !/^\s|\s$/.test(body) ? "（公式）" : match)
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(\*\*|__)(\S(?:[\s\S]*?\S)?)\1/g, "$2")
    .replace(/~~(\S(?:[\s\S]*?\S)?)~~/g, "$1")
    .replace(/(^|[^\w*])\*(\S(?:[^*\n]*?\S)?)\*(?=[^\w*]|$)/g, "$1$2")
    .replace(/(^|[^\w])_(\S(?:[^_\n]*?\S)?)_(?=[^\w]|$)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity] ?? entity)
    .replace(/\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Plain text to be spoken for one reply; empty when nothing is readable. */
export function markdownToSpeechText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let fence: { character: string; length: number; summary: string } | null = null;
  let mathBlock = false;
  for (const line of lines) {
    if (fence) {
      const closing = line.trim();
      if (closing.length >= fence.length && [...closing].every(character => character === fence!.character)) {
        if (fence.summary) output.push(fence.summary);
        fence = null;
      }
      continue;
    }
    const opening = FENCE_OPEN.exec(line);
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length, summary: fenceSummary(opening[2]) };
      continue;
    }
    const trimmed = line.trim();
    if (mathBlock) {
      if (trimmed.endsWith("$$") || trimmed === "\\]") { mathBlock = false; output.push("此处省略公式。"); }
      continue;
    }
    if (trimmed.startsWith("$$") || trimmed === "\\[") {
      const singleLine = trimmed.length > 2 && trimmed.startsWith("$$") && trimmed.slice(2).trimEnd().endsWith("$$");
      if (singleLine) output.push("此处省略公式。");
      else mathBlock = true;
      continue;
    }
    if (RULE.test(line)) continue;
    if (TABLE_ROW.test(line)) {
      if (TABLE_DIVIDER.test(line)) continue;
      const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => inlineSpeech(cell)).filter(Boolean);
      if (cells.length) output.push(`${cells.join("，")}。`);
      continue;
    }
    output.push(inlineSpeech(line));
  }
  // A reply that ends inside an unclosed fence (a cut-off answer) still says why.
  if (fence?.summary) output.push(fence.summary);
  if (mathBlock) output.push("此处省略公式。");
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const STRONG_SEPARATORS = new Set(["。", "！", "？", "；", "\n", ".", "!", "?", ";", "…"]);
const WEAK_SEPARATORS = new Set(["，", ",", "、", "：", ":", " "]);

/** Speakable pieces of at most `maxLength` code points, cut at sentence ends
 * where possible (then at commas, then hard). Surrogate pairs are never split. */
export function splitSpeechChunks(text: string, maxLength = 160): string[] {
  const characters = Array.from(text.trim());
  const chunks: string[] = [];
  const limit = Math.max(8, Math.floor(maxLength));
  for (let start = 0; start < characters.length;) {
    let end = Math.min(start + limit, characters.length);
    if (end < characters.length) {
      let cut = -1;
      for (let index = end - 1; index > start; index -= 1) if (STRONG_SEPARATORS.has(characters[index])) { cut = index; break; }
      if (cut < start + Math.floor(limit * 0.3)) {
        for (let index = end - 1; index > Math.max(start, cut); index -= 1) if (WEAK_SEPARATORS.has(characters[index])) { cut = index; break; }
      }
      if (cut > start) end = cut + 1;
    }
    const chunk = characters.slice(start, end).join("").replace(/\s+/g, " ").trim();
    if (chunk) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

export type SpeechLanguage = "zh-CN" | "en-US";

/** Chinese unless the text is predominantly Latin script. */
export function speechLanguage(text: string): SpeechLanguage {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  if (han === 0 && latin > 0) return "en-US";
  return han * 4 >= latin ? "zh-CN" : "en-US";
}

export interface SpeechVoiceLike { name: string; lang: string; localService: boolean; default?: boolean }

function normalizedLang(voice: SpeechVoiceLike): string {
  return voice.lang.replace(/_/g, "-").toLowerCase();
}

/** Prefers an installed (local) voice in the exact locale, then the language. */
export function pickSpeechVoice<T extends SpeechVoiceLike>(voices: readonly T[], language: SpeechLanguage): T | null {
  const tiers: Array<(lang: string) => boolean> = language === "zh-CN"
    ? [lang => lang === "zh-cn" || lang === "zh-hans-cn" || lang === "cmn-hans-cn", lang => lang.startsWith("zh-hans") || lang.startsWith("cmn"), lang => lang === "zh" || lang.startsWith("zh-")]
    : [lang => lang === "en-us", lang => lang === "en" || lang.startsWith("en-")];
  for (const matches of tiers) {
    const candidates = voices.filter(voice => matches(normalizedLang(voice)));
    const chosen = candidates.find(voice => voice.localService && voice.default) ?? candidates.find(voice => voice.localService) ?? candidates[0];
    if (chosen) return chosen;
  }
  return null;
}

export function hasChineseVoice(voices: readonly SpeechVoiceLike[]): boolean {
  return pickSpeechVoice(voices, "zh-CN") !== null;
}
