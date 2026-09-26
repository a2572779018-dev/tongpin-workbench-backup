// Derived from OpenSquilla (https://github.com/TokenRhythm/opensquilla @ d27ba0e, Apache-2.0),
// ported to TypeScript and modified for Tongpin. See THIRD_PARTY_NOTICES.md.
import { BertWordPieceTokenizer } from "./bertTokenizer";
import {
  extractAssistantHandcrafted, extractContext, extractContinuation, extractHandcrafted, extractHist, extractReasoning,
  makeHistoryUserText, ROUTE_CLASSES, type AssistantUsage, type ContextMetadata, type PrevRouteDecision, type RouteClass, type RoutingFlags,
} from "./features";
import { LightGbmModel, type LightGbmLayout } from "./lightgbm";
import {
  applyGatewayPolicy, applyPostprocess, type AuxProbabilities, type GatewayDecision, type GatewayPolicyConfig,
  type PostprocessDecision, type PromptPolicy, type RoutingHistoryEntry, type RuntimeConfig, type TextTier, type ThinkingMode,
} from "./policy";
import { pyLen, wellFormed } from "./pyText";
import { tfidfSvdFeatures, type TfidfModel } from "./tfidf";

/*
 * OpenSquilla V4.2 Phase 3 inference core (`runtime_src/src/router/inference`:
 * features.py → heads.py → ensemble.py → postprocess.py) plus the gateway's
 * routing policy, running on the converted bundle. The two ONNX graphs are
 * executed by an injected runner (onnxruntime-web in the desktop worker).
 */

export const OPENSQUILLA_BUNDLE_FORMAT = "tongpin-opensquilla-router-bundle";

export interface OpenSquillaManifest {
  format: string;
  formatVersion: number;
  router: { name: string; version: string; phase: string; modelVersion: string; upstreamCommit: string; license: string };
  inference: {
    featureDim: number; mlpInputDim: number; routeClasses: string[]; temperature: number; perClassAlpha: number[];
    tfidfDims: number; svdComponents: number; vocabularySize: number; pcaDim: number; embeddingDim: number; bgeMaxLength: number; auxHead: boolean;
  };
  runtimeConfig: RuntimeConfig;
  gatewayPolicy: GatewayPolicyConfig;
  lightgbm: Record<"lgbm-main.bin" | "lgbm-aux.bin", LightGbmLayout>;
  files: Record<string, { sha256: string; bytes: number }>;
}

/** Everything the engine needs, already read from the bundle directory. */
export interface OpenSquillaBundleData {
  manifest: OpenSquillaManifest;
  tokenizerJson: unknown;
  tfidfVocabulary: string[];
  tfidfIdf: Uint8Array;
  svdComponents: Uint8Array;
  bgePca: Uint8Array;
  mlpScaler: Uint8Array;
  lgbmMain: Uint8Array;
  lgbmAux?: Uint8Array;
}

export interface OpenSquillaOnnxRunner {
  /** BGE `last_hidden_state` for a padded int64 batch → [batch, length, hidden]. */
  embed(input: { ids: BigInt64Array; mask: BigInt64Array; typeIds: BigInt64Array; batch: number; length: number }): Promise<Float32Array>;
  /** MLP head logits for one scaled 1536-d row. */
  mlp(input: Float32Array): Promise<Float32Array>;
}

export interface OpenSquillaRouterInput {
  message: string;
  /** Up to four earlier user texts, oldest first, already stripped/truncated. */
  historyUserTexts: string[];
  prevAssistantText: string | null;
  prevAssistantUsage: AssistantUsage | null;
  /** Routed turns inside the history window, oldest first. */
  routingHistory: RoutingHistoryEntry[];
}

export interface OpenSquillaRouterResult {
  routeClass: RouteClass;
  tier: TextTier;
  probabilities: [number, number, number, number];
  confidence: number;
  margin: number;
  difficulty: number;
  flags: RoutingFlags;
  thinkingMode: ThinkingMode;
  promptPolicy: PromptPolicy;
  postprocess: PostprocessDecision;
  gateway: GatewayDecision;
  intermediates: {
    tokens: [number[], number[], number[]];
    historyText: string;
    features: Float32Array;
    rawBge: Float32Array;
    pMain: Float64Array;
    pAux: Float64Array | null;
    mlpLogits: Float32Array;
    pMlp: Float64Array;
    fused: Float64Array;
  };
}

function aligned<T extends Float32Array | Float64Array>(bytes: Uint8Array, Ctor: { new(buffer: ArrayBuffer, offset: number, length: number): T; BYTES_PER_ELEMENT: number }, expected: number): T {
  if (bytes.byteLength !== expected * Ctor.BYTES_PER_ELEMENT) throw new Error(`unexpected array size ${bytes.byteLength}`);
  const source = bytes.byteOffset % Ctor.BYTES_PER_ELEMENT === 0 ? bytes : bytes.slice();
  return new Ctor(source.buffer as ArrayBuffer, source.byteOffset, expected);
}

function assertLittleEndian(): void {
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error("OpenSquilla bundle arrays are little-endian");
}

export class OpenSquillaRouterEngine {
  readonly manifest: OpenSquillaManifest;
  private readonly tokenizer: BertWordPieceTokenizer;
  private readonly tfidf: TfidfModel;
  private readonly pcaMean: Float32Array;
  private readonly pcaComponents: Float32Array;
  private readonly scalerMean: Float32Array;
  private readonly scalerScale: Float32Array;
  private readonly main: LightGbmModel;
  private readonly aux: LightGbmModel | null;

  constructor(data: OpenSquillaBundleData, private readonly onnx: OpenSquillaOnnxRunner) {
    assertLittleEndian();
    const manifest = data.manifest;
    if (manifest.format !== OPENSQUILLA_BUNDLE_FORMAT || manifest.formatVersion !== 1) throw new Error("unsupported OpenSquilla bundle format");
    const inf = manifest.inference;
    if (inf.featureDim !== 390 || inf.mlpInputDim !== 1536 || inf.routeClasses.join() !== ROUTE_CLASSES.join() || inf.perClassAlpha.length !== 4) {
      throw new Error("unexpected OpenSquilla inference manifest");
    }
    if (!(inf.temperature > 0) || inf.perClassAlpha.some(alpha => !(alpha >= 0 && alpha <= 1))) throw new Error("invalid OpenSquilla calibration");
    this.manifest = manifest;
    this.tokenizer = new BertWordPieceTokenizer(data.tokenizerJson as ConstructorParameters<typeof BertWordPieceTokenizer>[0], inf.bgeMaxLength);
    if (data.tfidfVocabulary.length !== inf.vocabularySize) throw new Error("TF-IDF vocabulary size mismatch");
    this.tfidf = {
      vocabulary: new Map(data.tfidfVocabulary.map((term, column) => [term, column])),
      idf: aligned(data.tfidfIdf, Float64Array, inf.vocabularySize),
      components: aligned(data.svdComponents, Float64Array, inf.svdComponents * inf.vocabularySize),
      svdComponents: inf.svdComponents,
      outputDims: inf.tfidfDims,
    };
    const pca = aligned(data.bgePca, Float32Array, inf.embeddingDim + inf.pcaDim * inf.embeddingDim);
    this.pcaMean = pca.subarray(0, inf.embeddingDim);
    this.pcaComponents = pca.subarray(inf.embeddingDim);
    const scaler = aligned(data.mlpScaler, Float64Array, inf.mlpInputDim * 2);
    // sklearn >= 1.8 StandardScaler.transform casts mean_/scale_ to the input dtype.
    this.scalerMean = Float32Array.from(scaler.subarray(0, inf.mlpInputDim));
    this.scalerScale = Float32Array.from(scaler.subarray(inf.mlpInputDim));
    this.main = new LightGbmModel(data.lgbmMain, manifest.lightgbm["lgbm-main.bin"]);
    this.aux = data.lgbmAux ? new LightGbmModel(data.lgbmAux, manifest.lightgbm["lgbm-aux.bin"]) : null;
    if (this.main.numFeatures !== inf.featureDim || this.main.numClass !== 4) throw new Error("unexpected LightGBM main head");
  }

  get version(): string { return `${this.manifest.router.version}-${this.manifest.router.phase}`; }

  tokenize(text: string): number[] { return this.tokenizer.encode(wellFormed(text)).ids; }

  /** OpenSquillaBGE.encode (CLS pooling + L2 norm) for [current, history, assistant]. */
  private async embedTriplet(texts: [string, string, string]): Promise<{ raw: Float32Array; tokens: [number[], number[], number[]] }> {
    const batch = this.tokenizer.encodeBatch(texts);
    const hidden = await this.onnx.embed({ ids: batch.ids, mask: batch.mask, typeIds: batch.typeIds, batch: texts.length, length: batch.length });
    const dim = this.manifest.inference.embeddingDim;
    if (hidden.length !== texts.length * batch.length * dim) throw new Error("unexpected BGE output shape");
    const raw = new Float32Array(texts.length * dim);
    for (let row = 0; row < texts.length; row += 1) {
      const base = row * batch.length * dim;
      let sum = 0;
      for (let k = 0; k < dim; k += 1) sum += hidden[base + k] * hidden[base + k];
      const norm = Math.max(Math.fround(Math.sqrt(sum)), 1e-12);
      for (let k = 0; k < dim; k += 1) raw[row * dim + k] = hidden[base + k] / norm;
    }
    const tokens = [0, 1, 2].map(row => {
      const ids: number[] = [];
      for (let position = 0; position < batch.lengths[row]; position += 1) ids.push(Number(batch.ids[row * batch.length + position]));
      return ids;
    }) as [number[], number[], number[]];
    return { raw, tokens };
  }

  private pca(raw: Float32Array): Float32Array {
    const { embeddingDim: dim, pcaDim } = this.manifest.inference;
    const out = new Float32Array(3 * pcaDim);
    for (let component = 0; component < pcaDim; component += 1) {
      const row = component * dim;
      let meanProjection = 0;
      for (let k = 0; k < dim; k += 1) meanProjection += this.pcaMean[k] * this.pcaComponents[row + k];
      const offset = Math.fround(meanProjection);
      for (let text = 0; text < 3; text += 1) {
        let projection = 0;
        for (let k = 0; k < dim; k += 1) projection += raw[text * dim + k] * this.pcaComponents[row + k];
        out[text * pcaDim + component] = Math.fround(projection) - offset;
      }
    }
    return out;
  }

  private async mlpProbabilities(raw: Float32Array): Promise<{ logits: Float32Array; probabilities: Float64Array }> {
    const scaled = new Float32Array(raw.length);
    for (let k = 0; k < raw.length; k += 1) scaled[k] = Math.fround(raw[k] - this.scalerMean[k]) / this.scalerScale[k];
    const logits = await this.onnx.mlp(scaled);
    if (logits.length !== 4) throw new Error("unexpected MLP output shape");
    const temperature = this.manifest.inference.temperature;
    const z = Array.from(logits, value => value / temperature);
    const max = Math.max(...z);
    const exps = z.map(value => Math.exp(value - max));
    const total = exps.reduce((sum, value) => sum + value, 0);
    return { logits, probabilities: Float64Array.from(exps, value => value / total) };
  }

  /** `options.rawEmbeddings` (3x512, already L2-normalized) replaces the BGE
   * pass; parity tests use it to feed the reference runtime's embeddings. */
  async route(input: OpenSquillaRouterInput, options: { rawEmbeddings?: Float32Array } = {}): Promise<OpenSquillaRouterResult> {
    const message = wellFormed(input.message);
    const historyTexts = input.historyUserTexts.map(wellFormed).filter(Boolean);
    const prevAssistant = input.prevAssistantText ? wellFormed(input.prevAssistantText) : null;
    const usage = input.prevAssistantUsage;
    const history = input.routingHistory;
    const previousDecisions: PrevRouteDecision[] = history.map(entry => ({ route_class: entry.finalRouteClass ?? entry.routeClass, difficulty: entry.difficulty, margin: entry.margin }));
    const contextTokens = Math.max(0, Math.floor((pyLen(message) + historyTexts.reduce((sum, text) => sum + pyLen(text), 0) + pyLen(prevAssistant ?? "")) / 4));
    const context: ContextMetadata = {
      turn_index: history.length,
      context_tokens_est: contextTokens,
      n_tools: 0,
      tool_result_length: 0,
      has_code_block: message.includes("```"),
      has_file_reference: false,
      has_url: false,
      has_tool_results: false,
    };

    const historyText = makeHistoryUserText(historyTexts);
    const texts: [string, string, string] = [message, historyText, prevAssistant ?? ""];
    const { raw, tokens } = options.rawEmbeddings
      ? { raw: options.rawEmbeddings, tokens: texts.map(text => this.tokenize(text)) as [number[], number[], number[]] }
      : await this.embedTriplet(texts);
    if (raw.length !== 3 * this.manifest.inference.embeddingDim) throw new Error("unexpected embedding size");
    const pca = this.pca(raw);
    const features = new Float32Array(this.manifest.inference.featureDim);
    let offset = 0;
    for (const channel of [
      extractHandcrafted(message),
      tfidfSvdFeatures(this.tfidf, message),
      extractContext(context),
      extractHist(previousDecisions),
      pca,
      extractAssistantHandcrafted(prevAssistant, usage, message),
      extractContinuation(usage, message),
      extractReasoning(usage, message),
    ]) {
      features.set(channel, offset);
      offset += channel.length;
    }
    if (offset !== features.length) throw new Error(`feature dim mismatch: ${offset}`);

    const pMain = this.main.predict(features);
    const pAux = this.aux ? this.aux.predict(features) : null;
    const { logits, probabilities: pMlp } = await this.mlpProbabilities(raw);
    const alpha = this.manifest.inference.perClassAlpha;
    const mixed = Float64Array.from(alpha, (a, index) => a * pMain[index] + (1 - a) * pMlp[index]);
    const total = mixed.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total <= 0) throw new Error("fused probability mass must be positive");
    const fused = mixed.map(value => value / total);
    const aux: AuxProbabilities | null = pAux ? { initial: pAux[0], maintain: pAux[1], upgrade: pAux[2], downgrade: pAux[3] } : null;
    const postprocess = applyPostprocess({ fused, aux, message, context, history: previousDecisions, config: this.manifest.runtimeConfig });
    const confidence = fused[ROUTE_CLASSES.indexOf(postprocess.routeClass)];
    const gateway = applyGatewayPolicy({
      routeClass: postprocess.routeClass, confidence, thinkingMode: postprocess.thinkingMode, promptPolicy: postprocess.promptPolicy,
      message, history, config: this.manifest.gatewayPolicy,
    });
    return {
      routeClass: postprocess.routeClass,
      tier: gateway.tier,
      probabilities: [fused[0], fused[1], fused[2], fused[3]],
      confidence,
      margin: postprocess.margin,
      difficulty: postprocess.difficulty,
      flags: postprocess.flags,
      thinkingMode: gateway.thinkingMode,
      promptPolicy: gateway.promptPolicy,
      postprocess,
      gateway,
      intermediates: { tokens, historyText, features, rawBge: raw, pMain, pAux, mlpLogits: logits, pMlp, fused },
    };
  }
}
