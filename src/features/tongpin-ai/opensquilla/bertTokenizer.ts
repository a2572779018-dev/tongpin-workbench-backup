// Derived from OpenSquilla (https://github.com/TokenRhythm/opensquilla @ d27ba0e, Apache-2.0),
// ported to TypeScript and modified for Tongpin. See THIRD_PARTY_NOTICES.md.
import { decodeRanges, inRanges } from "./pyText";
import { BERT_CHINESE, BERT_PUNCTUATION, BERT_REMOVED, BERT_WHITESPACE } from "./unicodeTables.generated";

/*
 * The BGE tokenizer OpenSquilla loads with `tokenizers.Tokenizer.from_file(
 * "bge_onnx/tokenizer.json")` plus `enable_truncation(max_length=510)` and
 * batch padding with [PAD] (`runtime_src/src/router/bge_onnx.py`):
 * added-token splitting on the raw text, BertNormalizer (clean_text,
 * handle_chinese_chars; no lowercasing or accent stripping in this file),
 * BertPreTokenizer, WordPiece ("##", max 100 chars/word), then
 * `[CLS] … [SEP]` with truncation counting the two special tokens.
 * Character classes are the tables probed from tokenizers 0.23.2.
 */

const REMOVED = decodeRanges(BERT_REMOVED);
const WHITESPACE = decodeRanges(BERT_WHITESPACE);
const CHINESE = decodeRanges(BERT_CHINESE);
const PUNCTUATION = decodeRanges(BERT_PUNCTUATION);

interface TokenizerJson {
  added_tokens: Array<{ id: number; content: string; special: boolean; normalized: boolean; lstrip: boolean; rstrip: boolean; single_word: boolean }>;
  normalizer: { type: string; clean_text: boolean; handle_chinese_chars: boolean; strip_accents: boolean | null; lowercase: boolean };
  pre_tokenizer: { type: string };
  post_processor: { type: string; single: Array<Record<string, { id: string; type_id: number }>> };
  model: { type: string; unk_token: string; continuing_subword_prefix: string; max_input_chars_per_word: number; vocab: Record<string, number> };
}

export interface EncodedText { ids: number[] }

export class BertWordPieceTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly added: Array<{ content: string; id: number }>;
  private readonly unkId: number;
  private readonly clsId: number;
  private readonly sepId: number;
  readonly padId: number;
  private readonly prefix: string;
  private readonly maxWordChars: number;

  constructor(json: TokenizerJson, private readonly maxLength = 510) {
    const n = json.normalizer, m = json.model;
    // Fail closed on any tokenizer.json this port does not reproduce exactly.
    if (n?.type !== "BertNormalizer" || !n.clean_text || !n.handle_chinese_chars || n.lowercase || n.strip_accents) throw new Error("unsupported BGE normalizer");
    if (json.pre_tokenizer?.type !== "BertPreTokenizer") throw new Error("unsupported BGE pre-tokenizer");
    if (m?.type !== "WordPiece") throw new Error("unsupported BGE model type");
    const template = json.post_processor?.single?.map(item => item.SpecialToken ? item.SpecialToken.id : item.Sequence ? `$${item.Sequence.id}` : "?").join(" ");
    if (json.post_processor?.type !== "TemplateProcessing" || template !== "[CLS] $A [SEP]") throw new Error("unsupported BGE post-processor");
    this.vocab = new Map(Object.entries(m.vocab));
    this.added = json.added_tokens.map(token => {
      if (token.normalized || token.lstrip || token.rstrip || token.single_word) throw new Error("unsupported added token options");
      return { content: token.content, id: token.id };
    }).sort((a, b) => b.content.length - a.content.length);
    const id = (token: string) => {
      const value = this.vocab.get(token);
      if (value === undefined) throw new Error(`missing token ${token}`);
      return value;
    };
    this.unkId = id(m.unk_token);
    this.clsId = id("[CLS]");
    this.sepId = id("[SEP]");
    this.padId = this.vocab.get("[PAD]") ?? 0;
    this.prefix = m.continuing_subword_prefix;
    this.maxWordChars = m.max_input_chars_per_word;
  }

  /** Added (special) tokens are matched on the raw text, leftmost-longest. */
  private splitAdded(text: string): Array<{ special: number } | { text: string }> {
    const out: Array<{ special: number } | { text: string }> = [];
    let start = 0, cursor = 0;
    while (cursor < text.length) {
      const match = text.charCodeAt(cursor) === 0x5b ? this.added.find(token => text.startsWith(token.content, cursor)) : undefined;
      if (!match) { cursor += 1; continue; }
      if (cursor > start) out.push({ text: text.slice(start, cursor) });
      out.push({ special: match.id });
      cursor += match.content.length;
      start = cursor;
    }
    if (start < text.length) out.push({ text: text.slice(start) });
    return out;
  }

  /** BertNormalizer + BertPreTokenizer → words. */
  private words(text: string): string[] {
    const words: string[] = [];
    let current = "";
    const flush = () => { if (current) { words.push(current); current = ""; } };
    for (const char of text) {
      const cp = char.codePointAt(0)!;
      if (cp === 0 || cp === 0xfffd || inRanges(REMOVED, cp)) continue;
      if (cp === 0x20 || inRanges(WHITESPACE, cp)) { flush(); continue; }
      if (inRanges(CHINESE, cp) || inRanges(PUNCTUATION, cp)) { flush(); words.push(char); continue; }
      current += char;
    }
    flush();
    return words;
  }

  private wordPiece(word: string, out: number[]): void {
    const chars = Array.from(word);
    if (chars.length > this.maxWordChars) { out.push(this.unkId); return; }
    const pieces: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length, found: number | undefined;
      while (start < end) {
        const piece = (start > 0 ? this.prefix : "") + chars.slice(start, end).join("");
        const id = this.vocab.get(piece);
        if (id !== undefined) { found = id; break; }
        end -= 1;
      }
      if (found === undefined) { out.push(this.unkId); return; }
      pieces.push(found);
      start = end;
    }
    out.push(...pieces);
  }

  encode(text: string): EncodedText {
    const content: number[] = [];
    for (const part of this.splitAdded(text)) {
      if ("special" in part) content.push(part.special);
      else for (const word of this.words(part.text)) this.wordPiece(word, content);
    }
    const limit = Math.max(0, this.maxLength - 2);
    return { ids: [this.clsId, ...content.slice(0, limit), this.sepId] };
  }

  /** `encode_batch` with padding to the longest sequence. */
  encodeBatch(texts: readonly string[]): { ids: BigInt64Array; mask: BigInt64Array; typeIds: BigInt64Array; length: number; lengths: number[] } {
    const encoded = texts.map(text => this.encode(text).ids);
    const length = Math.max(...encoded.map(ids => ids.length));
    const ids = new BigInt64Array(texts.length * length);
    const mask = new BigInt64Array(texts.length * length);
    encoded.forEach((row, index) => {
      for (let position = 0; position < length; position += 1) {
        const real = position < row.length;
        ids[index * length + position] = BigInt(real ? row[position] : this.padId);
        mask[index * length + position] = real ? 1n : 0n;
      }
    });
    return { ids, mask, typeIds: new BigInt64Array(texts.length * length), length, lengths: encoded.map(row => row.length) };
  }
}
