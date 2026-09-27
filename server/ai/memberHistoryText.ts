import { AI_MEMORY_RECALL_LIMITS } from "../../shared/aiMemoryLearning";
import { redactMemorySecrets } from "./memberMemorySafety";

/*
 * Pure text helpers for member history recall. The overall shape — index each
 * past message's own text, match queries with a substring-capable (trigram)
 * FTS5 index, fall back to a bounded substring scan for 1–2 character CJK
 * terms, and hand back real stored excerpts rather than a model summary — is
 * adapted from NousResearch Hermes Agent `tools/session_search_tool.py` and
 * `hermes_state_search.py` / `hermes_state_fts.py` (commit d0288be5, MIT; see
 * THIRD_PARTY_NOTICES.md). Hermes' CJK bigram tokenizer is a loadable SQLite
 * extension that a Durable Object cannot load, so short CJK terms and the final
 * ranking are handled here in TypeScript (character-bigram coverage).
 */

/** Indexed characters kept from one message: head + tail, like Hermes' bounded bookends. */
export const HISTORY_MESSAGE_CHARACTERS = 3000;
const HISTORY_MESSAGE_HEAD = 2400;
const HISTORY_MESSAGE_TAIL = 560;
/** One searchable chunk; neighbours overlap so a phrase across a boundary still matches. */
export const HISTORY_CHUNK_CHARACTERS = 700;
const HISTORY_CHUNK_OVERLAP = 40;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function codePoints(value: string): string[] { return Array.from(value); }

/** 64-bit FNV-1a (two 32-bit lanes) as 16 hex characters. Change detection only. */
export function historyFingerprint(...parts: readonly string[]): string {
  let a = 0x811c9dc5, b = 0xcbf29ce4;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index);
      a ^= code; a = Math.imul(a, 0x01000193) >>> 0;
      b ^= code; b = Math.imul(b, 0x01000193) >>> 0; b ^= b >>> 13;
    }
    a ^= 0x1f; a = Math.imul(a, 0x01000193) >>> 0;
    b ^= 0x1e; b = Math.imul(b, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * The FTS owner column. Every member's key has the same fixed length and
 * framing, so a phrase match on it is an equality match; results are still
 * re-filtered on the exact tenant/user columns of the chunk table.
 */
export function historyOwnerKey(tenantId: string, storedUserId: string): string {
  return `k${historyFingerprint(tenantId, storedUserId)}k`;
}

/** Drop a credential-looking run cut in half at a truncation edge. */
function trimTokenEdge(value: string, edge: "start" | "end"): string {
  return edge === "end" ? value.replace(/[A-Za-z0-9_+/=-]{6,}$/, "") : value.replace(/^[A-Za-z0-9_+/=-]{6,}/, "");
}

/**
 * The searchable text of one message: the visible answer or question only.
 * Structured rich blocks (chart/cards/follow-up JSON), tool envelopes, public
 * summaries, images, data URLs and base64 runs are removed; credential-shaped
 * spans are redacted with the member-memory filter; the result is bounded.
 */
export function historyIndexText(content: string): string {
  let text = content.normalize("NFKC")
    .replace(/```(?:chart|cards|followups)[^\n]*\n[\s\S]*?```/gi, " ")
    .replace(/<tool_request>[\s\S]*?<\/tool_request>/gi, " ")
    .replace(/<analysis_summary>[\s\S]*?<\/analysis_summary>/gi, " ")
    .replace(/<\/?(?:tool_request|analysis_summary)>/gi, " ")
    .replace(/!\[[^\]]{0,200}\]\([^)]{0,4000}\)/g, " ")
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, " ")
    .replace(/[A-Za-z0-9+/=]{200,}/g, " ")
    .replace(CONTROL, "")
    .replace(/\*\*|__/g, "")
    .replace(/^#{1,6}\s+/gm, "");
  const chars = codePoints(text);
  if (chars.length > HISTORY_MESSAGE_CHARACTERS) {
    const head = trimTokenEdge(chars.slice(0, HISTORY_MESSAGE_HEAD).join(""), "end");
    const tail = trimTokenEdge(chars.slice(-HISTORY_MESSAGE_TAIL).join(""), "start");
    text = `${head} … ${tail}`;
  }
  return redactMemorySecrets(text)
    .replace(/[ \t 　]+/g, " ")
    .replace(/ ?\n[ \n]*/g, "\n")
    .trim();
}

const BOUNDARY = /[。！？!?；;\n]/;

/** Split indexed text into overlapping chunks, preferring sentence boundaries. */
export function historyChunks(text: string): string[] {
  const chars = codePoints(text);
  if (!chars.length) return [];
  if (chars.length <= HISTORY_CHUNK_CHARACTERS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(chars.length, start + HISTORY_CHUNK_CHARACTERS);
    if (end < chars.length) {
      for (let index = end - 1; index > end - 120 && index > start + 200; index -= 1) {
        if (BOUNDARY.test(chars[index])) { end = index + 1; break; }
      }
    }
    chunks.push(chars.slice(start, end).join("").trim());
    if (end >= chars.length) break;
    start = Math.max(start + 1, end - HISTORY_CHUNK_OVERLAP);
  }
  return chunks.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type HistoryRecallCue = "explicit" | "reference";

/** "查一下我之前问过的 XX", "翻翻历史对话里…": the member asks to search. */
const EXPLICIT_CUE = /(?:查一下|查查|查找|搜一下|搜索一下|搜搜|搜索|找一下|找找|翻一下|翻翻|回忆一下|帮我回忆)[^。！？!?\n]{0,12}(?:之前|以前|上次|过去|历史|聊过|问过|说过|讨论过|提过|写过|对话|聊天记录)|(?:历史对话|聊天记录|对话记录|以前的对话|之前的对话)|\b(?:search|look up|find)\b[^.!?\n]{0,30}\b(?:previous|earlier|past|old)\s+(?:chats?|conversations?)\b/i;
/** The message plausibly refers to an earlier conversation. */
const REFERENCE_CUE = /(?:上次|上回|上一次|前几天|前阵子|前两天|(?:我们|咱们|我|你)(?:之前|以前|先前)|(?:之前|以前|先前)(?:说|聊|提|问|讨论|写|发|做|给|定|用|的|那)|(?:^|[，,。！？!?\s])(?:之前|以前|先前)|(?:聊|谈|讨论|说|提|问|写|发)过|还记得|记不记得|记得吗|继续上次|接着上次|(?:跟|和|像|同|照|按)上次|老样子|照旧|\blast time\b|\bpreviously\b|\bas before\b|\bwe discussed\b|\byou (?:said|mentioned)\b|\bremember (?:when|what|the|our)\b)/i;

export function detectHistoryRecallCue(message: string): HistoryRecallCue | null {
  const text = message.normalize("NFKC");
  if (EXPLICIT_CUE.test(text)) return "explicit";
  if (REFERENCE_CUE.test(text)) return "reference";
  return null;
}

/** Words that say "search the past", not what to search for. Longest first. */
const FILLER_PHRASES = [
  "我们之前聊过的", "我们之前讨论的", "我之前问过的", "我之前说过的", "我之前写过的", "你之前说过的", "之前问过的", "之前聊过的", "之前说过的", "之前提到的",
  "之前讨论的", "之前写过的", "上次聊到的", "上次说到的", "上次提到的", "上次说的", "上次聊的", "上次写的", "上次做的", "上次给的", "上次那个", "上次那份",
  "历史对话", "聊天记录", "对话记录", "历史记录", "以前的对话", "之前的对话", "前面说的", "前面提到的", "你说的", "我说的", "说的",
  "搜索一下", "回忆一下", "帮我回忆", "记不记得", "继续上次", "接着上次", "我们聊过的", "我们聊过", "还记得", "记得吗", "是什么", "怎么样",
  "上一次", "上次", "上回", "之前", "以前", "先前", "前几天", "前阵子", "前两天", "那天", "聊过的", "聊过", "说过的", "说过", "谈过", "讨论过的", "讨论过",
  "提到过", "提过的", "提过", "问过的", "问过", "写过的", "写过", "发过", "请帮我", "帮我", "请你", "麻烦你", "麻烦", "查一下", "查查", "查找", "搜一下",
  "搜搜", "搜索", "找一下", "找找", "翻一下", "翻翻", "看一下", "看看", "发一下", "发给我", "发我", "给我", "再发", "一下", "那个", "这个", "那份", "这份",
  "那篇", "那次", "那些", "这些", "哪个", "哪些", "什么", "怎么", "如何", "我们", "咱们", "我的", "你的", "关于", "有关", "一样", "照着", "按照", "继续",
  "接着", "老样子", "照旧", "现在", "能不能", "可不可以", "可以吗", "好吗", "谢谢",
].sort((a, b) => b.length - a.length);
/** Particles that end a phrase: split CJK runs here. */
const PARTICLE = /[的吗呢吧啊呀嘛哦啦哈]/g;
/** Verb + aspect particle and measure-word pairs that only carry grammar. */
const GRAMMAR_PAIRS = /[写做用发说问聊改给定弄看讲提找查][了过着]|再[写做发来给弄出]|[一两几这那每哪][个份篇张条项次些种位]/g;
const LATIN_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "are", "was", "were", "be", "what", "how", "why", "when", "which", "who", "my", "me",
  "we", "our", "you", "your", "it", "its", "that", "this", "these", "those", "with", "about", "last", "time", "remember", "previous", "previously",
  "earlier", "before", "again", "please", "can", "could", "would", "find", "search", "look", "up", "did", "do", "does", "said", "say", "mentioned",
  "discussed", "chat", "chats", "conversation", "conversations", "past", "old", "as", "at", "by", "from", "i", "so", "if", "then", "there",
  // Present in nearly every 同频 AI conversation; they carry no topic.
  "ai", "ok",
]);
/** Bigrams made only of these characters carry little topic information. */
const FUNCTION_CHARS = new Set(Array.from("了一个份些这那我你他她它们是在有就都也还又再很要想能会让给把被对从到过着地得之其所以而且或与及等为和上下中里"));

export interface HistoryQueryUnit { text: string; weight: number }
export interface HistoryQuery {
  /** Topic phrases left after removing recall wording (for display and logs). */
  segments: string[];
  /** Coverage units: CJK character bigrams and Latin words. */
  units: HistoryQueryUnit[];
  totalWeight: number;
  /** FTS5 trigram phrases (CJK trigrams, Latin words of 3+ characters). */
  ftsTerms: string[];
  /** Units too short for a trigram index (2 characters): substring scan. */
  shortTerms: string[];
}

const MAX_SEGMENTS = 8;
const MAX_SEGMENT_CHARACTERS = 10;
const MAX_UNITS = 24;
const MAX_FTS_TERMS = 24;

/** Turn a member message into search terms; empty when nothing searchable remains. */
export function historyQuery(message: string): HistoryQuery {
  let text = message.normalize("NFKC").toLowerCase().replace(CONTROL, " ").slice(0, 600);
  for (const phrase of FILLER_PHRASES) text = text.split(phrase).join(" ");
  text = text.replace(PARTICLE, " ").replace(GRAMMAR_PAIRS, " ");
  const segments: string[] = [];
  const push = (segment: string) => { if (segments.length < MAX_SEGMENTS && !segments.includes(segment)) segments.push(segment); };
  for (const match of text.matchAll(/[a-z0-9][a-z0-9._-]*|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    const raw = match[0].replace(/[._-]+$/, "");
    const chars = codePoints(raw);
    if (chars.length < 2) continue;
    if (!CJK.test(raw)) {
      if (!LATIN_STOPWORDS.has(raw) && !/^\d{1,2}$/.test(raw)) push(raw.slice(0, 40));
      continue;
    }
    // A long run without particles is still one topic stream: window it
    // (overlapping by one character, so no bigram is lost).
    if (chars.length <= MAX_SEGMENT_CHARACTERS) push(raw);
    else for (let start = 0; start + 1 < chars.length; start += MAX_SEGMENT_CHARACTERS - 1) push(chars.slice(start, start + MAX_SEGMENT_CHARACTERS).join(""));
    if (segments.length >= MAX_SEGMENTS) break;
  }
  const units: HistoryQueryUnit[] = [];
  const ftsTerms: string[] = [];
  const shortTerms: string[] = [];
  const addUnit = (unit: string, weight: number) => { if (units.length < MAX_UNITS && !units.some(item => item.text === unit)) units.push({ text: unit, weight }); };
  for (const segment of segments) {
    if (CJK.test(segment)) {
      const chars = codePoints(segment);
      if (chars.length === 2) { addUnit(segment, chars.every(char => FUNCTION_CHARS.has(char)) ? 0.35 : 1); if (!shortTerms.includes(segment)) shortTerms.push(segment); }
      for (let index = 0; index + 1 < chars.length && chars.length > 2; index += 1) {
        const bigram = chars[index] + chars[index + 1];
        addUnit(bigram, FUNCTION_CHARS.has(chars[index]) || FUNCTION_CHARS.has(chars[index + 1]) ? 0.35 : 1);
      }
      for (let index = 0; index + 2 < chars.length && ftsTerms.length < MAX_FTS_TERMS; index += 1) {
        const trigram = chars.slice(index, index + 3).join("");
        if (!ftsTerms.includes(trigram)) ftsTerms.push(trigram);
      }
    } else {
      addUnit(segment, 1);
      if (codePoints(segment).length >= 3) { if (ftsTerms.length < MAX_FTS_TERMS && !ftsTerms.includes(segment)) ftsTerms.push(segment); }
      else if (!shortTerms.includes(segment)) shortTerms.push(segment);
    }
  }
  return { segments, units, totalWeight: units.reduce((sum, unit) => sum + unit.weight, 0), ftsTerms, shortTerms };
}

/** FTS5 expression: the owner phrase AND any topic phrase. Terms never carry quotes. */
export function historyMatchExpression(ownerKey: string, terms: readonly string[]): string {
  const quoted = terms.map(term => `"${term.replace(/"/g, "\"\"")}"`).join(" OR ");
  return `owner:"${ownerKey}" AND body:(${quoted})`;
}

export interface HistoryScore { score: number; coverage: number; longest: number; anchor: number }

/**
 * Coverage of the query's bigram/word units in `text` (weighted so grammar
 * bigrams count less), plus a bonus for the longest contiguous topic match.
 * "上次那个汇报模板" → units 汇报/报模/模板 → a chunk containing 季度汇报模板
 * covers all three.
 */
export function scoreHistoryText(query: HistoryQuery, text: string): HistoryScore {
  if (!query.units.length || !text) return { score: 0, coverage: 0, longest: 0, anchor: -1 };
  const haystack = text.normalize("NFKC").toLowerCase();
  let matched = 0;
  for (const unit of query.units) if (haystack.includes(unit.text)) matched += unit.weight;
  const coverage = query.totalWeight ? matched / query.totalWeight : 0;
  let longest = 0, anchor = -1;
  for (const segment of query.segments) {
    const chars = codePoints(segment);
    // The bonus saturates at 6 characters, so longer probes add nothing.
    for (let length = Math.min(chars.length, 6); length >= 2 && length > longest; length -= 1) {
      let found = false;
      for (let start = 0; start + length <= chars.length; start += 1) {
        const piece = chars.slice(start, start + length).join("");
        const at = haystack.indexOf(piece);
        if (at >= 0) { longest = length; anchor = at; found = true; break; }
      }
      if (found) break;
    }
  }
  return { score: coverage * 0.75 + Math.min(longest, 6) / 6 * 0.25, coverage, longest, anchor };
}

/**
 * A bounded excerpt around the best match, snapped to sentence boundaries,
 * on one line. `anchor` is a UTF-16 index into the NFKC-lowercased text; the
 * stored chunk is already NFKC, so indices line up.
 */
export function historyExcerpt(text: string, anchor: number, maxCharacters: number = AI_MEMORY_RECALL_LIMITS.snippetCharacters): string {
  const chars = codePoints(text);
  const anchorPoint = anchor < 0 ? 0 : codePoints(text.slice(0, anchor)).length;
  if (chars.length <= maxCharacters) return chars.join("").replace(/\s*\n\s*/g, " / ").trim();
  let start = Math.max(0, anchorPoint - Math.floor(maxCharacters / 3));
  let end = Math.min(chars.length, start + maxCharacters);
  if (end - start < maxCharacters) start = Math.max(0, end - maxCharacters);
  if (start > 0) {
    for (let index = start; index < Math.min(start + 40, anchorPoint); index += 1) if (BOUNDARY.test(chars[index])) { start = index + 1; break; }
  }
  if (end < chars.length) {
    for (let index = end - 1; index > Math.max(end - 40, anchorPoint); index -= 1) if (BOUNDARY.test(chars[index])) { end = index + 1; break; }
  }
  return `${start > 0 ? "…" : ""}${chars.slice(start, end).join("").replace(/\s*\n\s*/g, " / ").trim()}${end < chars.length ? "…" : ""}`;
}

/** `YYYY-MM-DD` in China Standard Time (UTC+8, no daylight saving). */
export function historyDate(epochMs: number): string | null {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
  return new Date(epochMs + 8 * 60 * 60_000).toISOString().slice(0, 10);
}
