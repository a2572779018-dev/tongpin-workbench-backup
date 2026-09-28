import { markdownToSpeechText } from "../speechText";

/**
 * Sentence parts of a streaming reply for the 语音通话 speech queue.
 *
 * Ported from Open WebUI v0.6.5 (BSD-3-Clause, Copyright (c) 2023-2025 Timothy
 * Jaeryang Baek), `src/lib/utils/index.ts`: `extractSentences`,
 * `extractSentencesForAudio` and `getMessageContentParts`, plus the streaming
 * rule of `src/lib/components/chat/Chat.svelte` (every chunk: split, drop the
 * last, still-growing part, queue the parts not spoken yet).
 *
 * Changes for Tongpin: Open WebUI splits only at `.!?` followed by a space and
 * merges parts shorter than four words or fifty characters, so a Chinese reply
 * (no spaces, one "word") never splits and would be spoken only at the very
 * end. Here Chinese sentence ends (。！？；…) and line breaks split too, and
 * only very short Chinese parts (such as “好的。”) join the next one. Markdown
 * is cleaned with Tongpin's own `markdownToSpeechText` (code, formulas, charts,
 * cards and follow-up blocks), which replaces Open WebUI's `cleanText`.
 * Open WebUI queued only the newest finished part per chunk, which skips a
 * sentence when one chunk finishes two; parts are counted here instead.
 */

const HAN = /\p{Script=Han}/u;
const CJK_END = new Set(["。", "！", "？", "；", "…"]);
const LATIN_END = new Set([".", "!", "?", ";"]);
/** Closing quotes and brackets that belong to the sentence they end. */
const CLOSERS = new Set(["”", "’", "」", "』", "）", ")", "】", "》", "\"", "'"]);
/** Chinese parts shorter than this join the next part (Open WebUI: 50 characters / 4 words). */
const MIN_CJK_PART = 6;
const MIN_LATIN_WORDS = 4;
const MIN_LATIN_CHARACTERS = 50;

/** Sentences of plain speech text: Chinese ends, Latin ends before a space, line breaks. */
export function extractSentences(text: string): string[] {
  const characters = Array.from(text);
  const sentences: string[] = [];
  let current = "";
  const flush = () => {
    const sentence = current.replace(/\s+/g, " ").trim();
    if (sentence && /[\p{L}\p{N}]/u.test(sentence)) sentences.push(sentence);
    else if (sentence && sentences.length) sentences[sentences.length - 1] += sentence;
    current = "";
  };
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === "\n") { flush(); continue; }
    current += character;
    const next = characters[index + 1];
    const ends = CJK_END.has(character) || (LATIN_END.has(character) && (next === undefined || /\s/.test(next)));
    if (!ends) continue;
    // Keep runs like "？！" or "……" and a closing quote with the sentence they end.
    while (index + 1 < characters.length && (CJK_END.has(characters[index + 1]) || LATIN_END.has(characters[index + 1]) || CLOSERS.has(characters[index + 1]))) {
      index += 1;
      current += characters[index];
    }
    flush();
  }
  flush();
  return sentences;
}

function tooShort(part: string): boolean {
  if (HAN.test(part)) return Array.from(part.replace(/[\p{P}\p{S}\s]/gu, "")).length < MIN_CJK_PART;
  return part.split(/\s+/).length < MIN_LATIN_WORDS || part.length < MIN_LATIN_CHARACTERS;
}

/** Open WebUI `extractSentencesForAudio`: very short parts join the next one. */
export function extractSentencesForAudio(text: string): string[] {
  return extractSentences(text).reduce<string[]>((merged, sentence) => {
    const last = merged.length - 1;
    if (last >= 0 && tooShort(merged[last])) merged[last] = HAN.test(merged[last]) && HAN.test(sentence) ? merged[last] + sentence : `${merged[last]} ${sentence}`;
    else merged.push(sentence);
    return merged;
  }, []);
}

/** Open WebUI `getMessageContentParts` ("punctuation" split). */
export function getMessageContentParts(content: string): string[] {
  return extractSentencesForAudio(markdownToSpeechText(content));
}

/** Where a reply's speech queue stands: whole parts queued, and a first clause spoken early. */
export interface SpeechProgress { queued: number; clause: string }
export const NO_SPEECH_PROGRESS: SpeechProgress = Object.freeze({ queued: 0, clause: "" });

/** The first clause of a reply (up to a comma), long enough to be worth saying on its own. */
const FIRST_CLAUSE = /^(.+?[，,、：:])/u;
const MIN_FIRST_CLAUSE = 6;

/**
 * The parts to queue now for a reply at `progress`. While the reply streams,
 * its last part may still grow and waits; once it is done everything left is
 * queued. So the member hears the answer sooner, the very first part may start
 * at its first comma (“明天上午有小雨，”) while the rest of that sentence is
 * still arriving; the rest is queued when the sentence completes.
 */
export function newSpeechParts(content: string, progress: SpeechProgress, done: boolean): { parts: string[]; progress: SpeechProgress } {
  const parts = getMessageContentParts(content);
  const ready = done ? parts : parts.slice(0, -1);
  const out: string[] = [];
  let { queued, clause } = progress;
  for (; queued < ready.length; queued += 1) {
    const part = ready[queued];
    if (clause && part.startsWith(clause)) {
      const rest = part.slice(clause.length).trim();
      if (rest) out.push(rest);
    } else out.push(part);
    clause = "";
  }
  if (queued === 0 && !clause && !done && parts.length) {
    const early = FIRST_CLAUSE.exec(parts[0])?.[1];
    if (early && Array.from(early.replace(/[\p{P}\p{S}\s]/gu, "")).length >= MIN_FIRST_CLAUSE) { clause = early; out.push(early); }
  }
  return { parts: out, progress: { queued, clause } };
}
