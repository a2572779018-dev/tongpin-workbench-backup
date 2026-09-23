import { createHash } from "node:crypto";

export interface DifyToolGrantClaims {
  audience: "tongpin-dify-tool";
  tenantId: string;
  userId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  allowedTools: string[];
  sourceAssetIds: string[];
  budgetVersion: string;
  maxPoints: number;
  expiresAt: number;
}

export interface DifyToolInvocation {
  tenantId: string;
  userId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  sourceAssetIds: string[];
  authorization: string;
}

export interface DifyToolExecutionContext {
  /** Values established by the authenticated Tongpin route, never by Dify JSON. */
  tenantId: string;
  userId: string;
}

export interface DifyToolLedgerResult {
  ledgerEntryId: string;
  tenantId: string;
  userId: string;
  runId: string;
  toolCallId: string;
  chargedPoints: number;
}

export interface DifyToolExecutionResult {
  output: Record<string, unknown>;
  ledger?: DifyToolLedgerResult;
  /** Queries have no charge; an asynchronous submission references its real reservation. */
  accounting?: { kind: "read_only" } | { kind: "reserved"; requestId: string; reservedPoints: number };
}

export interface DifyToolCallRecord {
  scope: string;
  runScope: string;
  requestHash: string;
  status: "running" | "succeeded" | "failed" | "unknown";
  result?: DifyToolExecutionResult;
  errorCode?: string;
}

export type DifyToolReservation =
  | { kind: "reserved" }
  | { kind: "replay"; record: DifyToolCallRecord }
  | { kind: "conflict" }
  | { kind: "in_progress" }
  | { kind: "run_blocked" };

export interface DifyToolCallStore {
  /**
   * Must atomically enforce both the (tenantId, userId, toolCallId) reservation
   * and the run-level unknown-outcome freeze across processes.
   */
  reserve(scope: string, runScope: string, requestHash: string, options?: { readOnly: boolean }): Promise<DifyToolReservation>;
  finish(scope: string, requestHash: string, update: Pick<DifyToolCallRecord, "status" | "result" | "errorCode">): Promise<void>;
}

export interface DifyToolGatewayDependencies {
  verifyAuthorization(token: string): Promise<DifyToolGrantClaims>;
  store: DifyToolCallStore;
  execute(request: Omit<DifyToolInvocation, "authorization">, claims: DifyToolGrantClaims): Promise<DifyToolExecutionResult>;
  now?: () => number;
  isReadOnly?: (toolName: string) => boolean;
}

export class DifyToolGatewayError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "DifyToolGatewayError";
  }
}

/** Executor errors must state whether an external side effect might have begun. */
export class DifyToolExecutionError extends Error {
  constructor(public readonly code: string, message: string, public readonly outcome: "not_started" | "unknown") {
    super(message);
    this.name = "DifyToolExecutionError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DifyToolGatewayError("DIFY_TOOL_INPUT_INVALID", "工具参数包含无效数字", 400);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  throw new DifyToolGatewayError("DIFY_TOOL_INPUT_INVALID", "工具参数必须是 JSON", 400);
}

function requestHash(request: Omit<DifyToolInvocation, "authorization">): string {
  return createHash("sha256").update(canonical(request)).digest("hex");
}

function safeId(value: string, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new DifyToolGatewayError("DIFY_TOOL_INPUT_INVALID", `${label} 无效`, 400);
}

function sameSet(left: readonly string[], right: readonly string[]) {
  const expected = [...right].sort();
  return left.length === expected.length && [...left].sort().every((value, index) => value === expected[index]);
}

/**
 * Security boundary used by the internal Dify tool endpoint. It validates the
 * authenticated tenant binding and a short-lived capability before atomically
 * reserving the tool call. Unknown outcomes are never executed again.
 */
export class DifyToolGateway {
  private readonly now: () => number;
  constructor(private readonly dependencies: DifyToolGatewayDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async invoke(invocation: DifyToolInvocation, context: DifyToolExecutionContext): Promise<DifyToolExecutionResult> {
    for (const [label, value] of Object.entries({ tenantId: invocation.tenantId, userId: invocation.userId, conversationId: invocation.conversationId, runId: invocation.runId, attemptId: invocation.attemptId, toolCallId: invocation.toolCallId, toolName: invocation.toolName })) safeId(value, label);
    for (const assetId of invocation.sourceAssetIds) safeId(assetId, "sourceAssetId");
    if (new Set(invocation.sourceAssetIds).size !== invocation.sourceAssetIds.length) throw new DifyToolGatewayError("DIFY_TOOL_INPUT_INVALID", "素材 ID 不能重复", 400);
    if (context.tenantId !== invocation.tenantId || context.userId !== invocation.userId) throw new DifyToolGatewayError("DIFY_TOOL_SCOPE_MISMATCH", "Dify 工具请求与已认证账户不匹配", 403);
    let claims: DifyToolGrantClaims;
    try { claims = await this.dependencies.verifyAuthorization(invocation.authorization); }
    catch { throw new DifyToolGatewayError("DIFY_TOOL_AUTH_INVALID", "Dify 工具授权无效或已过期", 403); }
    if (claims.audience !== "tongpin-dify-tool" || claims.expiresAt <= this.now()) throw new DifyToolGatewayError("DIFY_TOOL_AUTH_EXPIRED", "Dify 工具授权无效或已过期", 403);
    for (const key of ["tenantId", "userId", "conversationId", "runId", "attemptId"] as const) {
      if (claims[key] !== invocation[key]) throw new DifyToolGatewayError("DIFY_TOOL_SCOPE_MISMATCH", "Dify 工具授权与任务快照不匹配", 403);
    }
    if (!claims.allowedTools.includes(invocation.toolName)) throw new DifyToolGatewayError("DIFY_TOOL_NOT_ALLOWED", "该工具不在本次授权范围内", 403);
    if (!Number.isSafeInteger(claims.maxPoints) || claims.maxPoints < 0 || !claims.budgetVersion) throw new DifyToolGatewayError("DIFY_TOOL_AUTH_INVALID", "Dify 工具授权缺少预算快照", 403);
    if (!sameSet(invocation.sourceAssetIds, claims.sourceAssetIds)) throw new DifyToolGatewayError("DIFY_TOOL_ASSET_SCOPE_MISMATCH", "Dify 工具素材与已授权素材不匹配", 403);
    const { authorization: _authorization, ...request } = invocation;
    const hash = requestHash(request);
    const scope = `${invocation.tenantId}\u0000${invocation.userId}\u0000${invocation.toolCallId}`;
    const runScope = `${invocation.tenantId}\u0000${invocation.userId}\u0000${invocation.runId}`;
    const readOnly = this.dependencies.isReadOnly?.(invocation.toolName) === true;
    const reservation = await this.dependencies.store.reserve(scope, runScope, hash, { readOnly });
    if (reservation.kind === "run_blocked") throw new DifyToolGatewayError("DIFY_RUN_OUTCOME_UNKNOWN", "父任务存在结果未知的工具调用，调和前禁止新执行", 409);
    if (reservation.kind === "conflict") throw new DifyToolGatewayError("DIFY_TOOL_IDEMPOTENCY_CONFLICT", "相同 toolCallId 已绑定其他参数", 409);
    if (reservation.kind === "in_progress") throw new DifyToolGatewayError("DIFY_TOOL_IN_PROGRESS", "该工具调用正在执行，请只查询原任务", 409);
    if (reservation.kind === "replay") {
      if (reservation.record.status === "succeeded" && reservation.record.result) return reservation.record.result;
      if (reservation.record.status === "unknown") throw new DifyToolGatewayError("DIFY_TOOL_OUTCOME_UNKNOWN", "原工具调用结果未知，禁止重复执行", 409);
      throw new DifyToolGatewayError(reservation.record.errorCode ?? "DIFY_TOOL_FAILED", "原工具调用已失败，需要新 toolCallId 才能重试", 409);
    }
    try {
      const result = await this.dependencies.execute(request, claims);
      const encodedOutput = canonical(result.output);
      if (new TextEncoder().encode(encodedOutput).byteLength > 256 * 1024) throw new DifyToolExecutionError("DIFY_TOOL_RESULT_TOO_LARGE", "工具结果超出 Dify 回流限制", "unknown");
      const ledger = result.ledger;
      const accounting = result.accounting;
      const validLedger = !readOnly && ledger && !accounting && Boolean(ledger.ledgerEntryId) && ledger.tenantId === invocation.tenantId && ledger.userId === invocation.userId && ledger.runId === invocation.runId && ledger.toolCallId === invocation.toolCallId && Number.isSafeInteger(ledger.chargedPoints) && ledger.chargedPoints >= 0 && ledger.chargedPoints <= claims.maxPoints;
      const validAccounting = !ledger && (readOnly && accounting?.kind === "read_only" || !readOnly && accounting?.kind === "reserved" && accounting.requestId === invocation.attemptId && Number.isSafeInteger(accounting.reservedPoints) && accounting.reservedPoints > 0 && accounting.reservedPoints <= claims.maxPoints);
      if (!validLedger && !validAccounting) {
        throw new DifyToolExecutionError("DIFY_TOOL_LEDGER_INVALID", "工具执行未返回与父任务一致的账本记录", "unknown");
      }
      await this.dependencies.store.finish(scope, hash, { status: "succeeded", result });
      return result;
    } catch (error) {
      const known = error instanceof DifyToolExecutionError;
      await this.dependencies.store.finish(scope, hash, { status: known && error.outcome === "not_started" ? "failed" : "unknown", errorCode: known ? error.code : "DIFY_TOOL_EXECUTION_UNKNOWN" });
      if (known) throw new DifyToolGatewayError(error.code, error.message, error.outcome === "not_started" ? 422 : 409);
      throw new DifyToolGatewayError("DIFY_TOOL_OUTCOME_UNKNOWN", "工具调用结果未知，禁止自动重试", 409);
    }
  }
}
