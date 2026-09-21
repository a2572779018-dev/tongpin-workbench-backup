import { describe, expect, it, vi } from "vitest";
import {
  DifyToolExecutionError,
  DifyToolGateway,
  type DifyToolCallRecord,
  type DifyToolCallStore,
  type DifyToolGrantClaims,
  type DifyToolInvocation,
} from "./difyToolGateway";

class MemoryToolStore implements DifyToolCallStore {
  records = new Map<string, DifyToolCallRecord>();
  async reserve(scope: string, runScope: string, requestHash: string) {
    if ([...this.records.values()].some(record => record.runScope === runScope && record.status === "unknown")) return { kind: "run_blocked" as const };
    const existing = this.records.get(scope);
    if (!existing) { this.records.set(scope, { scope, runScope, requestHash, status: "running" }); return { kind: "reserved" as const }; }
    if (existing.requestHash !== requestHash) return { kind: "conflict" as const };
    if (existing.status === "running") return { kind: "in_progress" as const };
    return { kind: "replay" as const, record: existing };
  }
  async finish(scope: string, requestHash: string, update: Pick<DifyToolCallRecord, "status" | "result" | "errorCode">) {
    const running = this.records.get(scope);
    if (!running) throw new Error("missing reservation");
    this.records.set(scope, { ...running, requestHash, ...update });
  }
}

const claims = (tenantId = "tenant-a"): DifyToolGrantClaims => ({
  audience: "tongpin-dify-tool", tenantId, userId: "member-1", conversationId: "conversation-a",
  runId: "run-a", attemptId: "attempt-a", allowedTools: ["lookup"], sourceAssetIds: ["asset-a"],
  budgetVersion: "budget-v1", maxPoints: 5, expiresAt: 2_000,
});
const invocation = (tenantId = "tenant-a"): DifyToolInvocation => ({
  tenantId, userId: "member-1", conversationId: "conversation-a", runId: "run-a", attemptId: "attempt-a",
  toolCallId: "tool-call-1", toolName: "lookup", input: { query: "safe" }, sourceAssetIds: ["asset-a"], authorization: tenantId,
});

function gateway(store = new MemoryToolStore(), execute = vi.fn(async (request: Omit<DifyToolInvocation, "authorization">) => ({
  output: { value: request.tenantId },
  ledger: { ledgerEntryId: `ledger-${request.tenantId}`, tenantId: request.tenantId, userId: request.userId, runId: request.runId, toolCallId: request.toolCallId, chargedPoints: 1 },
}))) {
  return { store, execute, gateway: new DifyToolGateway({ store, execute, now: () => 1_000, verifyAuthorization: async token => claims(token) }) };
}

describe("Dify controlled tool gateway", () => {
  it("replays an identical toolCallId without executing or charging twice", async () => {
    const runtime = gateway();
    const first = await runtime.gateway.invoke(invocation(), { tenantId: "tenant-a", userId: "member-1" });
    const replay = await runtime.gateway.invoke(invocation(), { tenantId: "tenant-a", userId: "member-1" });
    expect(replay).toEqual(first);
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    expect(first.ledger.chargedPoints).toBe(1);
  });

  it("isolates identical user and tool call ids in two tenants", async () => {
    const runtime = gateway();
    const first = await runtime.gateway.invoke(invocation("tenant-a"), { tenantId: "tenant-a", userId: "member-1" });
    const second = await runtime.gateway.invoke(invocation("tenant-b"), { tenantId: "tenant-b", userId: "member-1" });
    expect(first.output).toEqual({ value: "tenant-a" });
    expect(second.output).toEqual({ value: "tenant-b" });
    expect(runtime.execute).toHaveBeenCalledTimes(2);
    expect(runtime.store.records.size).toBe(2);
  });

  it("rejects cross-tenant, changed-input, unauthorized-tool, and asset-scope attacks", async () => {
    const runtime = gateway();
    await expect(runtime.gateway.invoke(invocation(), { tenantId: "tenant-b", userId: "member-1" })).rejects.toMatchObject({ code: "DIFY_TOOL_SCOPE_MISMATCH", status: 403 });
    const disallowed = { ...invocation(), toolName: "generate_video" };
    await expect(runtime.gateway.invoke(disallowed, { tenantId: "tenant-a", userId: "member-1" })).rejects.toMatchObject({ code: "DIFY_TOOL_NOT_ALLOWED" });
    const wrongAsset = { ...invocation(), sourceAssetIds: ["asset-from-another-account"] };
    await expect(runtime.gateway.invoke(wrongAsset, { tenantId: "tenant-a", userId: "member-1" })).rejects.toMatchObject({ code: "DIFY_TOOL_ASSET_SCOPE_MISMATCH" });
    await runtime.gateway.invoke(invocation(), { tenantId: "tenant-a", userId: "member-1" });
    const changed = { ...invocation(), input: { query: "changed" } };
    await expect(runtime.gateway.invoke(changed, { tenantId: "tenant-a", userId: "member-1" })).rejects.toMatchObject({ code: "DIFY_TOOL_IDEMPOTENCY_CONFLICT", status: 409 });
    expect(runtime.execute).toHaveBeenCalledTimes(1);
  });

  it("persists unknown outcomes and refuses to execute them again", async () => {
    const execute = vi.fn(async () => { throw new Error("connection lost after submit"); });
    const runtime = gateway(new MemoryToolStore(), execute);
    await expect(runtime.gateway.invoke(invocation(), { tenantId: "tenant-a", userId: "member-1" })).rejects.toMatchObject({ code: "DIFY_TOOL_OUTCOME_UNKNOWN" });
    await expect(runtime.gateway.invoke(invocation(), { tenantId: "tenant-a", userId: "member-1" })).rejects.toMatchObject({ code: "DIFY_RUN_OUTCOME_UNKNOWN" });
    await expect(runtime.gateway.invoke({ ...invocation(), toolCallId: "tool-call-2" }, { tenantId: "tenant-a", userId: "member-1" })).rejects.toMatchObject({ code: "DIFY_RUN_OUTCOME_UNKNOWN" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("records a known pre-submit rejection as failed and requires a new toolCallId", async () => {
    const execute = vi.fn(async () => { throw new DifyToolExecutionError("TOOL_BUDGET_EXHAUSTED", "预算不足", "not_started"); });
    const runtime = gateway(new MemoryToolStore(), execute);
    await expect(runtime.gateway.invoke(invocation(), { tenantId: "tenant-a", userId: "member-1" })).rejects.toMatchObject({ code: "TOOL_BUDGET_EXHAUSTED", status: 422 });
    await expect(runtime.gateway.invoke(invocation(), { tenantId: "tenant-a", userId: "member-1" })).rejects.toMatchObject({ code: "TOOL_BUDGET_EXHAUSTED", status: 409 });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
