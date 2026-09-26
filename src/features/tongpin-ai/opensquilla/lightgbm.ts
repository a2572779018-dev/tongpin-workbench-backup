// Derived from OpenSquilla (https://github.com/TokenRhythm/opensquilla @ d27ba0e, Apache-2.0),
// ported to TypeScript and modified for Tongpin. See THIRD_PARTY_NOTICES.md.
/*
 * Evaluator for OpenSquilla's LightGBM router heads (`lgbm_main.bin`,
 * `lgbm_aux.bin`) after `scripts/opensquilla-router/convert_bundle.py`
 * flattened LightGBM's text model into typed arrays. The decision rule is
 * LightGBM's `Tree::NumericalDecision` (include/LightGBM/tree.h); the output
 * is the `multiclass` objective's softmax over per-class raw scores, as
 * `Booster.predict` returns it. Thresholds and leaf values are the model
 * file's float64 values, features arrive as float32 like NumPy passes them.
 */

export interface LightGbmSection { offset: number; length: number; dtype: string }
export interface LightGbmLayout {
  numClass: number;
  numFeatures: number;
  objective: string;
  trees: number;
  sections: Record<"nodeOffsets" | "leafOffsets" | "splitFeature" | "decisionType" | "leftChild" | "rightChild" | "threshold" | "leafValue", LightGbmSection>;
}

const DTYPES = {
  u4: Uint32Array, u2: Uint16Array, u1: Uint8Array, i2: Int16Array, f8: Float64Array,
} as const;
type Dtype = keyof typeof DTYPES;

function view<T extends Dtype>(buffer: ArrayBuffer, byteOffset: number, section: LightGbmSection, dtype: T): InstanceType<typeof DTYPES[T]> {
  if (section.dtype !== dtype) throw new Error(`LightGBM section dtype ${section.dtype} != ${dtype}`);
  const Ctor = DTYPES[dtype];
  const start = byteOffset + section.offset;
  if (start % Ctor.BYTES_PER_ELEMENT !== 0) throw new Error("LightGBM section is not aligned");
  if (start + section.length * Ctor.BYTES_PER_ELEMENT > buffer.byteLength) throw new Error("LightGBM section exceeds file");
  return new Ctor(buffer, start, section.length) as InstanceType<typeof DTYPES[T]>;
}

const ZERO_THRESHOLD = 1e-35;

export class LightGbmModel {
  readonly numClass: number;
  readonly numFeatures: number;
  private readonly trees: number;
  private readonly nodeOffsets: Uint32Array;
  private readonly leafOffsets: Uint32Array;
  private readonly splitFeature: Uint16Array;
  private readonly decisionType: Uint8Array;
  private readonly leftChild: Int16Array;
  private readonly rightChild: Int16Array;
  private readonly threshold: Float64Array;
  private readonly leafValue: Float64Array;

  constructor(bytes: Uint8Array, layout: LightGbmLayout) {
    if (!layout.objective.startsWith("multiclass") || layout.numClass < 2) throw new Error(`unsupported LightGBM objective ${layout.objective}`);
    // Typed views need an 8-byte aligned base; copy only when the reader handed a misaligned slice.
    const aligned = bytes.byteOffset % 8 === 0 ? bytes : bytes.slice();
    const buffer = aligned.buffer as ArrayBuffer, base = aligned.byteOffset;
    const s = layout.sections;
    this.numClass = layout.numClass;
    this.numFeatures = layout.numFeatures;
    this.trees = layout.trees;
    this.nodeOffsets = view(buffer, base, s.nodeOffsets, "u4");
    this.leafOffsets = view(buffer, base, s.leafOffsets, "u4");
    this.splitFeature = view(buffer, base, s.splitFeature, "u2");
    this.decisionType = view(buffer, base, s.decisionType, "u1");
    this.leftChild = view(buffer, base, s.leftChild, "i2");
    this.rightChild = view(buffer, base, s.rightChild, "i2");
    this.threshold = view(buffer, base, s.threshold, "f8");
    this.leafValue = view(buffer, base, s.leafValue, "f8");
    if (this.nodeOffsets.length !== this.trees + 1 || this.leafOffsets.length !== this.trees + 1) throw new Error("LightGBM tree index is inconsistent");
    if (this.trees % this.numClass !== 0) throw new Error("LightGBM tree count is not a multiple of the class count");
    for (let index = 0; index < this.splitFeature.length; index += 1) {
      if (this.splitFeature[index] >= this.numFeatures) throw new Error("LightGBM split feature out of range");
      if (this.decisionType[index] & 1) throw new Error("categorical LightGBM splits are not supported");
    }
  }

  /** Per-class raw scores (sum of leaf outputs), float64. */
  rawScores(features: Float32Array): Float64Array {
    if (features.length !== this.numFeatures) throw new Error(`expected ${this.numFeatures} features, got ${features.length}`);
    const scores = new Float64Array(this.numClass);
    for (let tree = 0; tree < this.trees; tree += 1) {
      const nodeBase = this.nodeOffsets[tree], leafBase = this.leafOffsets[tree];
      if (this.nodeOffsets[tree + 1] === nodeBase) {
        scores[tree % this.numClass] += this.leafValue[leafBase];
        continue;
      }
      let node = 0;
      while (node >= 0) {
        const index = nodeBase + node;
        let value = features[this.splitFeature[index]];
        const kind = this.decisionType[index];
        const missing = (kind >> 2) & 3;
        if (Number.isNaN(value) && missing !== 2) value = 0;
        if ((missing === 1 && value >= -ZERO_THRESHOLD && value <= ZERO_THRESHOLD) || (missing === 2 && Number.isNaN(value))) {
          node = kind & 2 ? this.leftChild[index] : this.rightChild[index];
        } else {
          node = value <= this.threshold[index] ? this.leftChild[index] : this.rightChild[index];
        }
      }
      scores[tree % this.numClass] += this.leafValue[leafBase + ~node];
    }
    return scores;
  }

  /** LightGBM multiclass softmax, as `Booster.predict` returns it. */
  predict(features: Float32Array): Float64Array {
    const scores = this.rawScores(features);
    let max = -Infinity;
    for (const score of scores) max = Math.max(max, score);
    let sum = 0;
    const out = new Float64Array(scores.length);
    for (let index = 0; index < scores.length; index += 1) { out[index] = Math.exp(scores[index] - max); sum += out[index]; }
    for (let index = 0; index < out.length; index += 1) out[index] /= sum;
    return out;
  }
}
