/**
 * Minimal TypeSafe System One ("Jev") client that runs unchanged in Node and
 * the Cloudflare Worker through Tongpin's outbound AI transport (public-DNS
 * checks, deployment allowlist, no redirects).
 *
 * The request/response contract is taken from the live API reference
 * (https://docs.typesafe.ai/api.md) and the MIT-licensed `@typesafe-ai/sdk`
 * 0.6.0 (`src/client.ts`, `src/types.ts`, commit 66880cc). Unlike the SDK it
 * never retries a timeout or a connection error — a decision whose outcome is
 * unknown may already be billed — and it validates every answer against the
 * exact questions that were asked. The API key is never logged or returned.
 */
import { AiError } from "./security";
import { readBoundedJson, type AiTransport } from "./provider";

export const TYPESAFE_ORIGIN = "https://api.typesafe.ai";
export const JEV_DEFAULT_MODEL = "jev-latest";
export const JEV_MODEL_PATTERN = /^jev-[a-z0-9][a-z0-9.-]{0,40}$/;
export const JEV_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 256_000;
const QUESTION_ID = /^[a-z][a-z0-9_]{0,47}$/;
const OPTION_ID = /^[a-z][a-z0-9_]{0,47}$/;
/** Documented Choice limit is 255 options; the executor itself sends ≤ 32. */
const MAX_OPTIONS = 255;

export type JevEntry = string | { [key: string]: unknown } | unknown[] | null;
export type JevQuestion =
  | { type: "choice"; instructions: JevEntry; criteria: Record<string, JevEntry> }
  | { type: "noul"; instructions: JevEntry; criteria?: { true?: JevEntry; false?: JevEntry } };
export interface JevRequest { model: string; state: JevEntry; questions: Record<string, JevQuestion> }
export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };
export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { inputTokens: number; outputTokens: number };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function invalidResponse(detail: string): never {
  // Billing already happened upstream; the caller settles it as uncertain.
  throw new AiError(502, "AI_JEV_RESPONSE_INVALID", `Jev 决策服务返回的结果未通过校验（${detail}），已停止，未执行任何动作`);
}

export function assertJevRequest(request: JevRequest): void {
  if (!JEV_MODEL_PATTERN.test(request.model)) throw new AiError(400, "AI_JEV_MODEL_INVALID", "Jev 模型名称不正确", true);
  const ids = Object.keys(request.questions);
  if (!ids.length || ids.length > 16) throw new AiError(400, "AI_JEV_REQUEST_INVALID", "Jev 问题数量不正确", true);
  for (const id of ids) {
    const question = request.questions[id];
    if (!QUESTION_ID.test(id)) throw new AiError(400, "AI_JEV_REQUEST_INVALID", "Jev 问题编号不正确", true);
    if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      if (options.length < 2 || options.length > MAX_OPTIONS || options.some(option => !OPTION_ID.test(option))) {
        throw new AiError(400, "AI_JEV_REQUEST_INVALID", "Jev 候选项不正确", true);
      }
    } else if (question.type !== "noul") {
      throw new AiError(400, "AI_JEV_REQUEST_INVALID", "Jev 问题类型不正确", true);
    }
  }
}

/** Validate one response against the exact questions asked (closed sets, ranges, usage). */
export function parseJevResult(value: unknown, request: JevRequest): JevResult {
  const root = object(value);
  if (!root) invalidResponse("顶层结构");
  if (typeof root.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(root.model)) invalidResponse("模型标识");
  const answers = object(root.answers);
  if (!answers) invalidResponse("答案");
  const expected = Object.keys(request.questions).sort();
  const received = Object.keys(answers).sort();
  if (expected.length !== received.length || expected.some((id, index) => id !== received[index])) invalidResponse("问题集合不一致");
  const parsed: Record<string, JevAnswer> = {};
  for (const id of expected) {
    const question = request.questions[id];
    const answer = object(answers[id]);
    if (!answer || answer.type !== question.type) invalidResponse("答案类型");
    if (question.type === "noul") {
      if (!unit(answer.noul)) invalidResponse("是非概率");
      parsed[id] = { type: "noul", noul: answer.noul };
      continue;
    }
    const options = new Set(Object.keys(question.criteria));
    // Closed-set validation: the answer must be one of the supplied ids.
    if (typeof answer.choice !== "string" || !options.has(answer.choice)) invalidResponse("选择了未提供的候选项");
    if (!unit(answer.confidence)) invalidResponse("置信度");
    const probabilities = object(answer.probabilities);
    if (!probabilities) invalidResponse("概率分布");
    const clean: Record<string, number> = {};
    let sum = 0;
    for (const [option, probability] of Object.entries(probabilities)) {
      if (!options.has(option)) invalidResponse("概率包含未提供的候选项");
      if (!unit(probability)) invalidResponse("概率数值");
      clean[option] = probability;
      sum += probability;
    }
    if (!Object.hasOwn(clean, answer.choice) || Math.abs(sum - 1) > 0.05) invalidResponse("概率分布不完整");
    parsed[id] = { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities: clean };
  }
  const usage = object(root.usage);
  if (!usage || !count(usage.input_tokens) || !count(usage.output_tokens)) invalidResponse("用量");
  return { model: root.model, answers: parsed, usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } };
}

function retryDelay(response: Response): number {
  const ms = Number(response.headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, 2_000);
  const seconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 2_000);
  return 800;
}

function httpError(status: number): AiError {
  if (status === 401 || status === 403) return new AiError(502, "AI_JEV_AUTH", "Jev 决策服务拒绝了密钥，请管理员在「AI 管理 → 生成与搜索 → Jev 决策服务」检查", true);
  if (status === 422 || status === 400) return new AiError(502, "AI_JEV_REJECTED", "Jev 决策服务拒绝了本次请求，已停止，未执行任何动作", true);
  if (status === 429 || status === 529) return new AiError(503, "AI_JEV_BUSY", "Jev 决策服务繁忙，已停止，未执行任何动作；请稍后重试", true);
  if (status >= 400 && status < 500) return new AiError(502, "AI_JEV_REJECTED", "Jev 决策服务拒绝了本次请求，已停止，未执行任何动作", true);
  return new AiError(502, "AI_JEV_UNAVAILABLE", "Jev 决策服务暂时不可用，已停止，未执行任何动作");
}

/**
 * One System One call. 429/529 ("not processed") is retried at most once
 * after a bounded delay; everything else is final. `definitelyNotSent` on the
 * thrown AiError tells the caller whether it may release the reservation.
 */
export async function callJev(transport: AiTransport, apiKey: string, request: JevRequest, options: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {}): Promise<JevResult> {
  assertJevRequest(request);
  if (!apiKey) throw new AiError(503, "AI_JEV_NOT_CONFIGURED", "管理员尚未配置 Jev 决策服务密钥", true);
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const body = JSON.stringify(request);
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(JEV_TIMEOUT_MS)]) : AbortSignal.timeout(JEV_TIMEOUT_MS);
      response = await transport(`${TYPESAFE_ORIGIN}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body, signal, maxResponseBytes: MAX_RESPONSE_BYTES,
      });
    } catch (error) {
      const notSent = error instanceof AiError && error.definitelyNotSent;
      throw new AiError(502, "AI_JEV_CONNECTION", "无法连接 Jev 决策服务或等待超时，已停止，未执行任何动作", notSent);
    }
    if (response.ok) {
      const value = await readBoundedJson(response, MAX_RESPONSE_BYTES).catch(() => invalidResponse("JSON"));
      return parseJevResult(value, request);
    }
    await response.body?.cancel().catch(() => undefined);
    if ((response.status === 429 || response.status === 529) && attempt === 0) {
      await sleep(retryDelay(response));
      continue;
    }
    throw httpError(response.status);
  }
}

/** Non-generating credential check: `GET /v1/models` lists the account's model names. */
export async function listJevModels(transport: AiTransport, apiKey: string): Promise<string[]> {
  let response: Response;
  try {
    response = await transport(`${TYPESAFE_ORIGIN}/v1/models`, {
      method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000), maxResponseBytes: 64_000,
    });
  } catch {
    throw new AiError(502, "AI_JEV_CONNECTION", "无法连接 Jev 决策服务，请检查服务器网络和域名允许名单", true);
  }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw httpError(response.status); }
  const root = object(await readBoundedJson(response, 64_000).catch(() => null));
  if (!root || !Array.isArray(root.models)) throw new AiError(502, "AI_JEV_RESPONSE_INVALID", "Jev 决策服务没有返回模型列表", true);
  return root.models
    .map(item => object(item)?.name)
    .filter((name): name is string => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(name))
    .slice(0, 50);
}
