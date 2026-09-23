export type DifyEngineEventType =
  | "run_started"
  | "answer_delta"
  | "tool_started"
  | "tool_progress"
  | "tool_finished"
  | "usage_updated"
  | "run_finished"
  | "run_failed";

export interface DifyEngineEvent {
  type: DifyEngineEventType;
  runId: string;
  stepId: string;
  seq: number;
  timestamp: string;
  content?: string;
  toolName?: string;
  remoteTaskId?: string;
  remoteMessageId?: string;
  remoteConversationId?: string;
  remoteWorkflowRunId?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  errorCode?: string;
}

export interface DifyEngineRunInput {
  tenantId: string;
  userId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  query: string;
  toolAuthorization: string;
  remoteConversationId?: string;
  inputs?: Record<string, string | number | boolean>;
}

export interface DifyEngineRunResult {
  engine: "dify";
  status: "completed";
  answer: string;
  remoteTaskId: string;
  remoteMessageId?: string;
  remoteConversationId: string;
  remoteWorkflowRunId?: string;
  events: DifyEngineEvent[];
}

export interface DifyEngineConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxEventBytes?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

export class DifyEngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly outcome: "not_started" | "unknown" | "failed",
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DifyEngineError";
  }
}

function bounded(value: unknown, max = 500): string {
  return typeof value === "string" ? Array.from(value).slice(0, max).join("") : "";
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(normalized)) {
    throw new DifyEngineError("DIFY_INPUT_INVALID", `${label} 无效`, "not_started", false);
  }
  return normalized;
}

function remoteEventId(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new DifyEngineError("DIFY_PROTOCOL_ERROR", "Dify 任务标识无效，结果需要核对", "unknown", false);
  }
  return value;
}

function endpoint(baseUrl: string, path: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return `${normalized}${normalized.endsWith("/v1") ? "" : "/v1"}${path}`;
}

function eventTime(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : new Date().toISOString();
}

function usageFrom(value: unknown): DifyEngineEvent["usage"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const number = (key: string) => typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] as number : undefined;
  const result = { inputTokens: number("prompt_tokens"), outputTokens: number("completion_tokens"), totalTokens: number("total_tokens") };
  return Object.values(result).some(item => item !== undefined) ? result : undefined;
}

async function* ssePayloads(body: ReadableStream<Uint8Array>, maxEventBytes: number, maxResponseBytes: number) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxResponseBytes) throw new DifyEngineError("DIFY_RESPONSE_TOO_LARGE", "Dify 响应超出安全限制", "unknown", false);
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)![0];
        buffer = buffer.slice(boundary + separator.length);
        const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        if (new TextEncoder().encode(data).byteLength > maxEventBytes) throw new DifyEngineError("DIFY_EVENT_TOO_LARGE", "Dify 事件超出安全限制", "unknown", false);
        yield data;
      }
    }
    // SSE frames are committed only by a blank line. An unterminated tail may
    // be a truncated message_end and cannot prove a successful remote run.
  } finally {
    reader.releaseLock();
  }
}

/**
 * Adapter for a Dify Agent/Chatflow Service API application. It never retries
 * a run: once a remote task id is observed, a disconnect is an unknown outcome
 * that must be reconciled by the owning task service.
 */
export class DifyEngineAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxEventBytes: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly config: DifyEngineConfig) {
    if (!config.apiKey.trim()) throw new DifyEngineError("DIFY_NOT_CONFIGURED", "Dify 应用密钥未配置", "not_started", false);
    try { new URL(config.baseUrl); } catch { throw new DifyEngineError("DIFY_NOT_CONFIGURED", "Dify 服务地址无效", "not_started", false); }
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.maxEventBytes = config.maxEventBytes ?? 256 * 1024;
    this.maxResponseBytes = config.maxResponseBytes ?? 8 * 1024 * 1024;
  }

  async health(signal?: AbortSignal): Promise<{ reachable: true; name?: string; description?: string }> {
    const response = await this.fetchImpl(endpoint(this.config.baseUrl, "/info"), {
      headers: { Authorization: `Bearer ${this.config.apiKey}` }, signal,
    });
    if (!response.ok) throw new DifyEngineError("DIFY_UNAVAILABLE", `Dify 健康检查失败（HTTP ${response.status}）`, "not_started", response.status >= 500);
    const data = await response.json() as Record<string, unknown>;
    return { reachable: true, ...(typeof data.name === "string" ? { name: bounded(data.name, 120) } : {}), ...(typeof data.description === "string" ? { description: bounded(data.description, 240) } : {}) };
  }

  async run(input: DifyEngineRunInput, onEvent?: (event: DifyEngineEvent) => void, signal?: AbortSignal): Promise<DifyEngineRunResult> {
    const tenantId = requiredId(input.tenantId, "tenantId");
    const userId = requiredId(input.userId, "userId");
    const conversationId = requiredId(input.conversationId, "conversationId");
    const runId = requiredId(input.runId, "runId");
    const attemptId = requiredId(input.attemptId, "attemptId");
    if (!input.query.trim()) throw new DifyEngineError("DIFY_INPUT_INVALID", "Dify 任务内容为空", "not_started", false);
    if (!input.toolAuthorization.trim()) throw new DifyEngineError("DIFY_INPUT_INVALID", "Dify 工具授权缺失", "not_started", false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const suppliedRemoteConversationId = input.remoteConversationId?.trim() || undefined;
    let remoteTaskId = "";
    let remoteMessageId = "";
    let remoteConversationId = suppliedRemoteConversationId ?? "";
    let remoteWorkflowRunId = "";
    let answer = "";
    let terminal = false;
    let messageEndSeen = false;
    let chatflow = false;
    let agentMessageSeen = false;
    let closingAgentMessageSeen = false;
    let messageChunkSeen = false;
    let seq = 0;
    const startedTools = new Map<string, string>();
    const finishedTools = new Set<string>();
    let terminalUsage: DifyEngineEvent["usage"];
    let terminalTimestamp = "";
    const events: DifyEngineEvent[] = [];
    const emit = (event: Omit<DifyEngineEvent, "runId" | "seq">) => {
      const next = { ...event, runId, seq: ++seq };
      events.push(next); onEvent?.(next);
    };
    const customInputs = input.inputs ?? {};
    for (const [key, value] of Object.entries(customInputs)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || typeof value === "string" && value.length > 16_000) {
        clearTimeout(timeout); throw new DifyEngineError("DIFY_INPUT_INVALID", "Dify 输入变量无效", "not_started", false);
      }
    }
    const payload = {
      inputs: {
        ...customInputs,
        tongpin_tenant_id: tenantId,
        tongpin_user_id: userId,
        tongpin_conversation_id: conversationId,
        tongpin_run_id: runId,
        tongpin_attempt_id: attemptId,
        tongpin_tool_authorization: input.toolAuthorization,
      },
      query: input.query,
      response_mode: "streaming",
      conversation_id: suppliedRemoteConversationId ?? "",
      user: `${tenantId}:${userId}`,
    };
    try {
      const response = await this.fetchImpl(endpoint(this.config.baseUrl, "/chat-messages"), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const message = bounded(await response.text(), 300);
        throw new DifyEngineError("DIFY_REQUEST_REJECTED", `Dify 拒绝任务（HTTP ${response.status}）${message ? `：${message}` : ""}`, "not_started", response.status >= 500 || response.status === 429);
      }
      if (!response.body) throw new DifyEngineError("DIFY_PROTOCOL_ERROR", "Dify 未返回事件流", "unknown", false);
      for await (const raw of ssePayloads(response.body, this.maxEventBytes, this.maxResponseBytes)) {
        let item: Record<string, unknown>;
        try { item = JSON.parse(raw) as Record<string, unknown>; }
        catch { throw new DifyEngineError("DIFY_PROTOCOL_ERROR", "Dify 返回了无效事件", remoteTaskId ? "unknown" : "not_started", false); }
        const event = bounded(item.event, 80);
        // Chatflow emits workflow_finished after message_end; other chat apps
        // do not. Delay all success events until the complete stream closes.
        if (terminal || (messageEndSeen && event !== "workflow_finished" && event !== "error")) {
          throw new DifyEngineError("DIFY_PROTOCOL_ERROR", "Dify 终态后又返回事件，结果需要核对", "unknown", false);
        }
        const taskId = remoteEventId(item.task_id);
        const conversationId = remoteEventId(item.conversation_id);
        const workflowRunId = remoteEventId(item.workflow_run_id);
        if ((taskId && remoteTaskId && taskId !== remoteTaskId) || (conversationId && remoteConversationId && conversationId !== remoteConversationId) || (workflowRunId && remoteWorkflowRunId && workflowRunId !== remoteWorkflowRunId)) {
          throw new DifyEngineError("DIFY_PROTOCOL_ERROR", "Dify 任务标识在事件流中发生变化，结果需要核对", "unknown", false);
        }
        remoteTaskId ||= taskId;
        remoteMessageId ||= remoteEventId(item.message_id);
        remoteConversationId ||= conversationId;
        remoteWorkflowRunId ||= workflowRunId;
        const common = { timestamp: eventTime(item.created_at), remoteTaskId: remoteTaskId || undefined, remoteMessageId: remoteMessageId || undefined, remoteConversationId: remoteConversationId || undefined, remoteWorkflowRunId: remoteWorkflowRunId || undefined };
        if (events.length === 0) emit({ type: "run_started", stepId: `dify:${attemptId}`, ...common });
        if (event === "workflow_started") {
          if (agentMessageSeen || messageChunkSeen) throw new DifyEngineError("DIFY_PROTOCOL_ERROR", "Dify 工作流事件顺序无效", "unknown", false);
          chatflow = true;
        } else if (event === "agent_message") {
          if (chatflow || messageChunkSeen || closingAgentMessageSeen) throw new DifyEngineError("DIFY_PROTOCOL_ERROR", "Dify 回答事件顺序无效", "unknown", false);
          agentMessageSeen = true;
          const delta = bounded(item.answer, 128_000);
          if (delta) { answer += delta; emit({ type: "answer_delta", stepId: remoteMessageId || `dify:${attemptId}`, content: delta, ...common }); }
        } else if (event === "message") {
          const text = bounded(item.answer, 128_000);
          if (agentMessageSeen) {
            // Agent's closing message is the full answer, not another delta.
            if (closingAgentMessageSeen || !text.startsWith(answer)) throw new DifyEngineError("DIFY_PROTOCOL_ERROR", "Dify 最终回答与已发送片段不一致", "unknown", false);
            closingAgentMessageSeen = true;
            const remaining = text.slice(answer.length);
            if (remaining) emit({ type: "answer_delta", stepId: remoteMessageId || `dify:${attemptId}`, content: remaining, ...common });
            answer = text;
          } else {
            messageChunkSeen = true;
            if (text) { answer += text; emit({ type: "answer_delta", stepId: remoteMessageId || `dify:${attemptId}`, content: text, ...common }); }
          }
        } else if (event === "agent_thought") {
          const toolName = bounded(item.tool, 120);
          const observation = typeof item.observation === "string" && item.observation.length > 0;
          const observedStepId = remoteEventId(item.id);
          if (toolName) {
            const stepId = observedStepId || `dify-tool:${seq + 1}`;
            const previousTool = startedTools.get(stepId);
            if (previousTool && previousTool !== toolName) throw new DifyEngineError("DIFY_PROTOCOL_ERROR", "Dify 工具步骤标识冲突", "unknown", false);
            if (!startedTools.has(stepId)) {
              startedTools.set(stepId, toolName);
              emit({ type: "tool_started", stepId, toolName, ...common });
            }
            if (observation) {
              if (!finishedTools.has(stepId)) { finishedTools.add(stepId); emit({ type: "tool_finished", stepId, toolName, ...common }); }
            } else if (!finishedTools.has(stepId)) emit({ type: "tool_progress", stepId, toolName, ...common });
          } else if (observation && observedStepId && startedTools.has(observedStepId) && !finishedTools.has(observedStepId)) {
            finishedTools.add(observedStepId);
            emit({ type: "tool_finished", stepId: observedStepId, toolName: startedTools.get(observedStepId), ...common });
          }
        } else if (event === "message_end") {
          const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata) ? item.metadata as Record<string, unknown> : {};
          terminalUsage = usageFrom(metadata.usage);
          terminalTimestamp = common.timestamp;
          messageEndSeen = true;
          if (!chatflow) terminal = true;
        } else if (event === "workflow_finished") {
          if (!chatflow || !messageEndSeen) throw new DifyEngineError("DIFY_PROTOCOL_ERROR", "Dify 工作流终态顺序无效", "unknown", false);
          const data = item.data && typeof item.data === "object" && !Array.isArray(item.data) ? item.data as Record<string, unknown> : {};
          if (data.status === "failed" || data.status === "stopped") {
            emit({ type: "run_failed", stepId: remoteMessageId || `dify:${attemptId}`, errorCode: "DIFY_WORKFLOW_FAILED", ...common });
            throw new DifyEngineError("DIFY_WORKFLOW_FAILED", "Dify 工作流执行失败", "failed", false);
          }
          if (data.status !== "succeeded") throw new DifyEngineError("DIFY_PROTOCOL_ERROR", "Dify 工作流终态无效", "unknown", false);
          terminalTimestamp = common.timestamp;
          terminal = true;
        } else if (event === "error") {
          const errorCode = bounded(item.code, 120) || "DIFY_REMOTE_ERROR";
          emit({ type: "run_failed", stepId: remoteMessageId || `dify:${attemptId}`, content: bounded(item.message, 500), errorCode, ...common });
          throw new DifyEngineError(errorCode, bounded(item.message, 500) || "Dify 任务失败", "failed", false);
        }
      }
      if (!terminal || !remoteTaskId || !remoteConversationId || chatflow && !remoteWorkflowRunId || startedTools.size !== finishedTools.size) {
        throw new DifyEngineError("DIFY_OUTCOME_UNKNOWN", "Dify 终态、任务标识或工具结果未能核实，不会自动切换引擎或重复执行", "unknown", false);
      }
      const final = { timestamp: terminalTimestamp, remoteTaskId, ...(remoteMessageId ? { remoteMessageId } : {}), remoteConversationId, ...(remoteWorkflowRunId ? { remoteWorkflowRunId } : {}) };
      if (terminalUsage) emit({ type: "usage_updated", stepId: remoteMessageId || `dify:${attemptId}`, usage: terminalUsage, ...final });
      emit({ type: "run_finished", stepId: remoteMessageId || `dify:${attemptId}`, ...final });
      return { engine: "dify", status: "completed", answer, remoteTaskId, ...(remoteMessageId ? { remoteMessageId } : {}), remoteConversationId, ...(remoteWorkflowRunId ? { remoteWorkflowRunId } : {}), events };
    } catch (error) {
      if (error instanceof DifyEngineError) throw error;
      const timedOut = controller.signal.aborted;
      throw new DifyEngineError(timedOut ? "DIFY_TIMEOUT" : "DIFY_UNAVAILABLE", timedOut ? "Dify 任务超时，未知是否已在远程执行" : "无法连接 Dify 运行环境", remoteTaskId ? "unknown" : "not_started", !remoteTaskId);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async stop(remoteTaskId: string, tenantId: string, userId: string): Promise<void> {
    requiredId(remoteTaskId, "remoteTaskId");
    const user = `${requiredId(tenantId, "tenantId")}:${requiredId(userId, "userId")}`;
    const response = await this.fetchImpl(endpoint(this.config.baseUrl, `/chat-messages/${encodeURIComponent(remoteTaskId)}/stop`), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user }),
    });
    if (!response.ok) throw new DifyEngineError("DIFY_STOP_FAILED", `Dify 停止请求失败（HTTP ${response.status}）`, "unknown", response.status >= 500);
  }
}
