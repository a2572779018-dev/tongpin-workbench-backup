// Derived from OpenSquilla (https://github.com/TokenRhythm/opensquilla @ d27ba0e, Apache-2.0),
// ported to TypeScript and modified for Tongpin. See THIRD_PARTY_NOTICES.md.
import { codePoints, pyLower, pySplit } from "./pyText";

/*
 * OpenSquilla's TF-IDF channel: scikit-learn `TfidfVectorizer(analyzer=
 * "char_wb", ngram_range=(2, 4), lowercase=True, sublinear_tf=True,
 * norm="l2")` followed by `TruncatedSVD(n_components=100).transform`, then
 * zero-padded to 102 float32 values (`inference/artifacts.py`). The analyzer
 * mirrors `_VectorizerMixin._char_wb_ngrams`; the fitted vocabulary, idf and
 * SVD components come from the converted bundle.
 */

export interface TfidfModel {
  vocabulary: ReadonlyMap<string, number>;
  idf: Float64Array;
  /** Row-major components_ (svdComponents x vocabularySize). */
  components: Float64Array;
  svdComponents: number;
  outputDims: number;
}

/** sklearn `char_wb` n-grams of the lowercased document. */
export function charWbNgrams(document: string, minN = 2, maxN = 4): string[] {
  const grams: string[] = [];
  // `_white_spaces.sub(" ", …)` only collapses runs; `str.split()` removes them all.
  for (const word of pySplit(pyLower(document))) {
    const padded = [0x20, ...codePoints(word), 0x20];
    const length = padded.length;
    for (let n = minN; n <= maxN; n += 1) {
      let offset = 0;
      grams.push(String.fromCodePoint(...padded.slice(offset, offset + n)));
      while (offset + n < length) {
        offset += 1;
        grams.push(String.fromCodePoint(...padded.slice(offset, offset + n)));
      }
      if (offset === 0) break; // a short word is counted only once
    }
  }
  return grams;
}

export function tfidfSvdFeatures(model: TfidfModel, text: string): Float32Array {
  const counts = new Map<number, number>();
  for (const gram of charWbNgrams(text)) {
    const column = model.vocabulary.get(gram);
    if (column !== undefined) counts.set(column, (counts.get(column) ?? 0) + 1);
  }
  const columns = [...counts.keys()].sort((a, b) => a - b);
  const values = columns.map(column => (Math.log(counts.get(column)!) + 1) * model.idf[column]);
  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm);
  const out = new Float32Array(model.outputDims);
  if (!columns.length) return out;
  const width = model.vocabulary.size;
  for (let component = 0; component < model.svdComponents && component < model.outputDims; component += 1) {
    const row = component * width;
    let sum = 0;
    for (let index = 0; index < columns.length; index += 1) sum += (values[index] / norm) * model.components[row + columns[index]];
    out[component] = sum;
  }
  return out;
}
