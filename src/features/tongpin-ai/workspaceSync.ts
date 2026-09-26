import type { AiWorkspaceSaveRequest, AiWorkspaceSnapshot, AiWorkspaceState } from "../../../shared/aiWorkspace";

export type WorkspaceSyncStatus = "saved" | "saving" | "error" | "conflict";
export class WorkspaceConflictError extends Error {}

const CONFLICT_CODES = new Set([
  "AI_WORKSPACE_CONFLICT", "AI_WORKSPACE_MUTATION_CONFLICT", "AI_WORKSPACE_VERSION_UNSUPPORTED",
  "AI_WORKSPACE_ACCOUNT_CHANGED", "AI_ACCOUNT_CHANGED",
]);
const REJECTED_WITHOUT_WRITE_CODES = new Set([
  "AI_WORKSPACE_INVALID", "AI_WORKSPACE_TOO_LARGE", "INVALID_JSON", "PAYLOAD_TOO_LARGE", "VALIDATION_ERROR",
]);
function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Bind background saves to their originating account, independent of the current auth session. */
export function workspaceSaveOptions(accountId: string, body: AiWorkspaceSaveRequest): RequestInit {
  return { method: "PUT", headers: { "X-Tongpin-Account": accountId }, body: JSON.stringify(body) };
}

/** Serial, revision-checked writes. Unknown outcomes reuse the exact mutation id and body. */
export class WorkspaceSaveQueue {
  private revision: number;
  private acknowledged: string;
  private desired: AiWorkspaceState | null;
  private desiredJson: string;
  private pending: AiWorkspaceSaveRequest | null = null;
  private flight: Promise<void> | null = null;
  private conflict = false;
  private failure = false;
  constructor(
    initial: AiWorkspaceSnapshot,
    private readonly write: (body: AiWorkspaceSaveRequest) => Promise<AiWorkspaceSnapshot>,
    private readonly changed: (status: WorkspaceSyncStatus, message?: string, code?: string) => void,
  ) {
    this.revision = initial.revision;
    this.desiredJson = JSON.stringify(initial.state);
    this.desired = JSON.parse(this.desiredJson) as AiWorkspaceState | null;
    this.acknowledged = this.desiredJson;
  }
  setState(state: AiWorkspaceState, options: { flush?: boolean } = {}): boolean {
    const serialized = JSON.stringify(state);
    const changed = serialized !== this.desiredJson;
    this.desiredJson = serialized;
    // The caller must not mutate an in-flight request or change the UUID's meaning.
    this.desired = JSON.parse(serialized) as AiWorkspaceState;
    const ready = !this.failure && !this.conflict && this.isDirty();
    if (ready && options.flush !== false) void this.flush();
    return ready && changed;
  }
  isDirty() { return Boolean(this.pending) || this.desiredJson !== this.acknowledged; }
  async saveNow(state: AiWorkspaceState): Promise<boolean> {
    this.setState(state, { flush: false });
    return this.flushSaved();
  }
  async flushSaved(): Promise<boolean> {
    await this.flush();
    return !this.failure && !this.conflict && !this.isDirty();
  }
  flush(): Promise<void> {
    if (this.flight) return this.flight;
    if (this.conflict || !this.desired || !this.isDirty()) return Promise.resolve();
    this.failure = false;
    this.changed("saving");
    // Assign the shared promise before invoking write(), including synchronous/reentrant adapters.
    this.flight = Promise.resolve().then(() => this.drain()).finally(() => { this.flight = null; });
    return this.flight;
  }
  private async drain() {
    try {
      while (this.desired && this.isDirty()) {
        this.pending ??= { expectedRevision: this.revision, mutationId: crypto.randomUUID(), state: this.desired };
        const next = await this.write(this.pending);
        if (next.revision !== this.pending.expectedRevision + 1) {
          throw new WorkspaceConflictError("另一台设备已更新记录；当前内容未覆盖，请先导出本机内容再重新加载。");
        }
        this.revision = next.revision;
        if (next.schemaVersion !== 1 || !next.state || JSON.stringify(next.state) !== JSON.stringify(this.pending.state)) {
          throw new WorkspaceConflictError("云端返回的记录与本次保存不同；当前内容未覆盖，请先导出本机内容再重新加载。");
        }
        this.acknowledged = JSON.stringify(this.pending.state);
        this.pending = null;
      }
      this.changed("saved");
    } catch (error) {
      this.failure = true;
      const code = errorCode(error);
      this.conflict = error instanceof WorkspaceConflictError || Boolean(code && CONFLICT_CODES.has(code));
      // Only a definitive validation rejection may discard the old request body.
      // Network/timeout/5xx/invalid-ack failures keep it byte-for-byte for safe retry.
      if (!this.conflict && code && REJECTED_WITHOUT_WRITE_CODES.has(code)) this.pending = null;
      this.changed(this.conflict ? "conflict" : "error", this.conflict
        ? code === "AI_ACCOUNT_CHANGED" || code === "AI_WORKSPACE_ACCOUNT_CHANGED"
          ? "账号已切换，本机记录未保存到其他账号；请先导出本机内容，再重新打开工作台。"
          : "另一台设备已更新记录；为避免覆盖，请先导出本机内容，再重新加载。"
        : error instanceof Error ? error.message : "记录暂未保存，请检查网络后重试。", code);
    }
  }
}
