import { useEffect, useReducer, useRef, useState } from "react";
import type { AiRunGuidanceInput, AiRunGuidanceItem } from "../../../shared/aiRunGuidance";
import { ApiRequestError } from "../../lib/api";
import { mergeSteerTexts, STEER_MAX_CHARACTERS, STEER_MAX_PENDING, steerBubbles, type SteerBubble, type SteerItem, type SteerTarget } from "./composerSteer";

/**
 * Lifecycle of mid-reply supplements ("steer"), shared by every chat workspace.
 *
 * - Follow-up path (the common single-stream reply): items wait locally and,
 *   when the conversation's current reply ends (completed, failed or stopped),
 *   are sent as ONE follow-up user turn through the host's normal send path.
 *   A turn that cannot be sent puts the text back into the composer with the
 *   reason; "request still in progress" (e.g. just after a stop, while the
 *   server finishes the old request) is retried with backoff first.
 * - Guidance path (an active multi-step run): items are handed to the server
 *   (POST /api/ai/requests/:runRequestId/guidance, idempotent by item id) and
 *   the run takes them before its next model call. When the run is over, items
 *   it took are kept in the conversation record; items it never took are
 *   withdrawn and sent as the follow-up turn instead; if the server cannot be
 *   asked, the text goes back to the composer. Nothing is lost or sent twice.
 */

export type SteerSendResult =
  | { status: "sent" }
  | { status: "retry"; reason?: string }
  | { status: "failed"; reason: string };

export interface RunGuidanceClient {
  post(runRequestId: string, input: AiRunGuidanceInput): Promise<AiRunGuidanceItem>;
  cancel(runRequestId: string, guidanceId: string): Promise<AiRunGuidanceItem>;
  list(runRequestId: string): Promise<AiRunGuidanceItem[]>;
}

export interface SteerHost {
  /** Sends one follow-up user turn owned by `conversationId`. Resolve as soon
   * as the turn exists (or definitely will not), not when its reply ends. */
  sendFollowUp(conversationId: string, text: string): Promise<SteerSendResult>;
  /** Appends unsent text to that conversation's composer and shows `reason`. */
  restoreDraft(conversationId: string, text: string, reason: string): void;
  /** Keeps text that a multi-step run already took in the conversation record. */
  recordDelivered(conversationId: string, text: string): void;
  /** The conversation still has a reply/request in flight. */
  isResponding(conversationId: string): boolean;
  /** The multi-step run can still take guidance. */
  isRunActive(conversationId: string, runRequestId: string): boolean;
  notify(message: string): void;
  /** Absent: every supplement uses the follow-up path. */
  guidance?: RunGuidanceClient;
}

export interface SteerControllerOptions {
  now?: () => number;
  newId?: () => string;
  maxPending?: number;
  /** Delay before retry `attempt` (1-based). */
  retryDelayMs?: (attempt: number) => number;
  maxRetries?: number;
  /** Re-check interval while a conversation with pending items is still busy
   * (a host busy flag can clear without any render). */
  watchMs?: number;
}

type GuidanceOutcome = "cancelled" | "delivered" | "unknown";

type ApiCall = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;

/** Account-bound client for the run-guidance endpoints. */
export function runGuidanceClient(api: ApiCall, accountId: string): RunGuidanceClient {
  const headers = { "X-Tongpin-Account": accountId };
  const path = (runRequestId: string, guidanceId?: string) => `/api/ai/requests/${encodeURIComponent(runRequestId)}/guidance${guidanceId ? `/${encodeURIComponent(guidanceId)}` : ""}`;
  return {
    post: async (runRequestId, input) => (await api<{ guidance: AiRunGuidanceItem }>(path(runRequestId), { method: "POST", headers, body: JSON.stringify(input) }, 15_000)).guidance,
    cancel: async (runRequestId, guidanceId) => (await api<{ guidance: AiRunGuidanceItem }>(path(runRequestId, guidanceId), { method: "DELETE", headers }, 15_000)).guidance,
    list: async runRequestId => (await api<{ guidance: AiRunGuidanceItem[] }>(path(runRequestId), { headers }, 15_000)).guidance,
  };
}

const defaultRetryDelay = (attempt: number) => [1_500, 3_000, 5_000][attempt - 1] ?? 8_000;

export class SteerController {
  private items: SteerItem[] = [];
  private readonly listeners = new Set<() => void>();
  /** Conversations with a follow-up send or a guidance resolution in flight. */
  private readonly busy = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watchers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  private attached = true;

  constructor(private readonly host: () => SteerHost, private readonly options: SteerControllerOptions = {}) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Visible items of one conversation, oldest first. */
  list(conversationId: string | undefined): readonly SteerItem[] {
    return conversationId ? this.items.filter(item => item.conversationId === conversationId && !item.withdrawn) : [];
  }

  bubbles(conversationId: string | undefined): SteerBubble[] {
    return steerBubbles(this.list(conversationId));
  }

  add(conversationId: string, text: string, target: SteerTarget): { ok: true; id: string } | { ok: false; reason: string } {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: "请先输入补充内容" };
    const max = this.options.maxPending ?? STEER_MAX_PENDING;
    const pending = this.list(conversationId);
    if (pending.length >= max) return { ok: false, reason: `最多暂存 ${max} 条补充，请等当前回复结束后再发送` };
    // The merged follow-up must fit in one request message (and in a draft if it comes back).
    if (pending.reduce((total, item) => total + item.text.length + 1, trimmed.length) > STEER_MAX_CHARACTERS) return { ok: false, reason: "补充内容过长，请缩短后再发送" };
    const item: SteerItem = { id: this.options.newId?.() ?? crypto.randomUUID(), conversationId, text: trimmed, createdAt: this.now(), status: "queued" };
    this.items = [...this.items, item];
    this.emit();
    const client = this.host().guidance;
    if (target.kind === "guidance" && client) void this.deliver(item.id, target.runRequestId, client);
    else this.settle(conversationId);
    return { ok: true, id: item.id };
  }

  /** × on a bubble: only before delivery. */
  cancel(id: string): void {
    const item = this.find(id);
    if (!item || item.status === "sending") return;
    if (item.delivering) { this.patch(id, { withdrawn: true }); return; }
    if (item.status === "handed" && item.runRequestId) { void this.withdrawHanded(item, item.runRequestId); return; }
    this.remove([id]);
  }

  /** Re-evaluate after the host's responding or run state changed. */
  sync(): void {
    for (const conversationId of new Set(this.items.map(item => item.conversationId))) this.settle(conversationId);
  }

  attach(): void {
    this.attached = true;
    this.sync();
  }

  detach(): void {
    this.attached = false;
    for (const timer of [...this.timers.values(), ...this.watchers.values()]) clearTimeout(timer);
    this.timers.clear();
    this.watchers.clear();
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private emit(): void { for (const listener of [...this.listeners]) listener(); }
  private find(id: string): SteerItem | undefined { return this.items.find(item => item.id === id); }
  private patch(id: string, patch: Partial<SteerItem>): void {
    this.items = this.items.map(item => item.id === id ? { ...item, ...patch } : item);
    this.emit();
  }
  private patchAll(ids: ReadonlySet<string>, patch: Partial<SteerItem>): void {
    this.items = this.items.map(item => ids.has(item.id) ? { ...item, ...patch } : item);
    this.emit();
  }
  private remove(ids: Iterable<string>): void {
    const removed = new Set(ids);
    if (!removed.size) return;
    this.items = this.items.filter(item => !removed.has(item.id));
    this.emit();
  }

  private settle(conversationId: string): void {
    if (!this.attached || this.busy.has(conversationId) || this.timers.has(conversationId)) return;
    const host = this.host();
    const items = this.list(conversationId);
    if (!items.length) return;
    if (host.isResponding(conversationId)) { this.watch(conversationId); return; }
    if (items.some(item => item.delivering)) return;
    const finishedRuns = [...new Set(items.flatMap(item => item.status === "handed" && item.runRequestId && !host.isRunActive(conversationId, item.runRequestId) ? [item.runRequestId] : []))];
    if (finishedRuns.length) { void this.resolveHanded(conversationId, finishedRuns); return; }
    const queued = items.filter(item => item.status === "queued");
    if (queued.length) void this.flush(conversationId, queued);
  }

  private watch(conversationId: string): void {
    if (!this.attached || this.watchers.has(conversationId)) return;
    this.watchers.set(conversationId, setTimeout(() => {
      this.watchers.delete(conversationId);
      this.settle(conversationId);
    }, this.options.watchMs ?? 2_000));
  }

  private async deliver(id: string, runRequestId: string, client: RunGuidanceClient): Promise<void> {
    const item = this.find(id);
    if (!item) return;
    this.patch(id, { delivering: true, runRequestId });
    let outcome = await guidancePost(client, runRequestId, { id, text: item.text });
    // A lost response is replayed once: the POST is idempotent by this id.
    if (outcome === "uncertain") outcome = await guidancePost(client, runRequestId, { id, text: item.text });
    const current = this.find(id);
    if (!current) return;
    if (current.withdrawn) {
      const cancelled = outcome === "rejected" ? "cancelled" : await guidanceCancel(client, runRequestId, id);
      this.remove([id]);
      if (cancelled === "delivered") {
        this.host().recordDelivered(current.conversationId, current.text);
        this.host().notify("AI 已读取这条补充，无法撤回");
      }
    // Definitely refused (run already over, limit reached…): wait for the reply
    // to end and send it as the follow-up turn instead.
    } else if (outcome === "rejected") this.patch(id, { delivering: false, runRequestId: undefined });
    // Accepted, or still unknown: reconciled with the server when the run ends,
    // so it is neither lost nor delivered twice.
    else this.patch(id, { delivering: false, status: "handed" });
    this.settle(current.conversationId);
  }

  private async withdrawHanded(item: SteerItem, runRequestId: string): Promise<void> {
    const client = this.host().guidance;
    this.patch(item.id, { delivering: true });
    const outcome = client ? await guidanceCancel(client, runRequestId, item.id) : "unknown";
    if (outcome === "cancelled") this.remove([item.id]);
    else {
      this.patch(item.id, { delivering: false });
      this.host().notify(outcome === "delivered" ? "AI 已读取这条补充，无法撤回" : "暂时无法撤回这条补充，请稍后重试");
    }
    this.settle(item.conversationId);
  }

  /** The run is over: keep what it took, send what it never took. */
  private async resolveHanded(conversationId: string, runRequestIds: string[]): Promise<void> {
    this.busy.add(conversationId);
    try {
      const client = this.host().guidance;
      for (const runRequestId of runRequestIds) {
        const handed = this.list(conversationId).filter(item => item.status === "handed" && item.runRequestId === runRequestId);
        let statuses: Map<string, AiRunGuidanceItem["status"]> | undefined;
        try { statuses = client ? new Map((await client.list(runRequestId)).map(entry => [entry.id, entry.status])) : undefined; }
        catch { statuses = undefined; }
        const delivered: SteerItem[] = [], unknown: SteerItem[] = [], requeue = new Set<string>();
        for (const item of handed) {
          const status = statuses?.get(item.id);
          if (status === "delivered") delivered.push(item);
          else if (statuses && status !== "pending") requeue.add(item.id);
          else if (status === "pending" && client) {
            const outcome = await guidanceCancel(client, runRequestId, item.id);
            if (outcome === "cancelled") requeue.add(item.id);
            else if (outcome === "delivered") delivered.push(item);
            else unknown.push(item);
          } else unknown.push(item);
        }
        if (delivered.length) {
          this.remove(delivered.map(item => item.id));
          this.host().recordDelivered(conversationId, mergeSteerTexts(delivered));
        }
        if (unknown.length) {
          // Never auto-send what the run may already have: the member decides.
          this.remove(unknown.map(item => item.id));
          this.host().restoreDraft(conversationId, mergeSteerTexts(unknown), "补充的送达状态暂时无法确认，已放回输入框，请核对后再发送");
        }
        if (requeue.size) this.patchAll(requeue, { status: "queued", runRequestId: undefined });
      }
    } finally { this.busy.delete(conversationId); }
    this.settle(conversationId);
  }

  private async flush(conversationId: string, queued: readonly SteerItem[]): Promise<void> {
    const ids = new Set(queued.map(item => item.id));
    const text = mergeSteerTexts(queued);
    this.busy.add(conversationId);
    this.patchAll(ids, { status: "sending" });
    let result: SteerSendResult;
    try { result = await this.host().sendFollowUp(conversationId, text); }
    catch (error) { result = { status: "failed", reason: error instanceof Error && error.message ? error.message : "补充暂时无法发送，已放回输入框" }; }
    finally { this.busy.delete(conversationId); }
    if (result.status === "sent") {
      this.attempts.delete(conversationId);
      this.remove(ids);
      return;
    }
    if (result.status === "retry") {
      const attempt = (this.attempts.get(conversationId) ?? 0) + 1;
      if (attempt <= (this.options.maxRetries ?? 20)) {
        this.attempts.set(conversationId, attempt);
        this.patchAll(ids, { status: "queued" });
        if (this.attached) {
          const timer = setTimeout(() => { this.timers.delete(conversationId); this.settle(conversationId); }, (this.options.retryDelayMs ?? defaultRetryDelay)(attempt));
          this.timers.set(conversationId, timer);
        }
        return;
      }
      result = { status: "failed", reason: result.reason ?? "上一条回复仍在处理，补充内容已放回输入框" };
    }
    this.attempts.delete(conversationId);
    this.remove(ids);
    this.host().restoreDraft(conversationId, text, result.reason);
  }
}

/** 4xx is a definite refusal; a network error or 5xx leaves the server state unknown. */
async function guidancePost(client: RunGuidanceClient, runRequestId: string, input: AiRunGuidanceInput): Promise<"accepted" | "rejected" | "uncertain"> {
  try {
    return (await client.post(runRequestId, input)).status === "cancelled" ? "rejected" : "accepted";
  } catch (error) {
    return error instanceof ApiRequestError && error.status >= 400 && error.status < 500 ? "rejected" : "uncertain";
  }
}

async function guidanceCancel(client: RunGuidanceClient, runRequestId: string, id: string): Promise<GuidanceOutcome> {
  try {
    const result = await client.cancel(runRequestId, id);
    return result.status === "delivered" ? "delivered" : "cancelled";
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "AI_GUIDANCE_DELIVERED") return "delivered";
    // The server holds no such item, so nothing can deliver it later.
    if (error instanceof ApiRequestError && (error.code === "AI_GUIDANCE_NOT_FOUND" || error.code === "AI_RUN_NOT_FOUND")) return "cancelled";
    return "unknown";
  }
}

/** One controller per workspace; `host` may change every render. */
export function useSteerController(host: SteerHost): SteerController {
  const hostRef = useRef(host);
  hostRef.current = host;
  const [controller] = useState(() => new SteerController(() => hostRef.current));
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const unsubscribe = controller.subscribe(rerender);
    controller.attach();
    return () => { unsubscribe(); controller.detach(); };
  }, [controller]);
  return controller;
}
