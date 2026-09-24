/** Real React page with a synthetic, loopback-only transport. This fixture
 * verifies UI sequencing; it is not a production/provider acceptance test. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "../src/auth/AuthContext";
import { TongpinAIPage } from "../src/pages/TongpinAIPage";
import { defaultAiPersonaProfile } from "../shared/aiPersona";
import type { AiWorkspaceMessage } from "../shared/aiWorkspace";
import type { User } from "../src/types";
import "../src/styles.css";

if (location.hostname !== "127.0.0.1") throw Error("Loopback only");
const account = "v2-acceptance-synthetic";
const user = { id: account, name: "V2 隔离验收", email: "v2@example.invalid", role: "member", status: "active" } as User;
const key = `tongpin-v2-fixture:${new URLSearchParams(location.search).get("run") ?? "manual"}`;
type Item = { id: string; title: string; revision: number; messages: AiWorkspaceMessage[]; draft: string; draftRevision: number; attachments: unknown[]; attachmentRevision: number };
type Fixture = { items: Item[]; receipts: Record<string, unknown>; requests: Record<string, { requestId: string; content: string; model: string; usage: object }> };
const state: Fixture = JSON.parse(localStorage.getItem(key) ?? "null") ?? { items: [], receipts: {}, requests: {} };
if (new URLSearchParams(location.search).has("history") && !state.items.length) {
  state.items.push({ id: "history-chat", title: "长对话", revision: 1,
    messages: Array.from({ length: 65 }, (_, index) => ({ id: `history-${index}`, role: "user" as const, content: `历史消息 ${index}`, time: "10:00" })),
    draft: "", draftRevision: 0, attachments: [], attachmentRevision: 0 });
}
const save = () => localStorage.setItem(key, JSON.stringify(state));
const evidence: string[] = [];
const record = (value: string) => { evidence.push(value); window.dispatchEvent(new Event("v2-fixture-evidence")); };
const quota = { limitTokens: 100000, remainingTokens: 99900, usedTokens: 100, reservedTokens: 0, inputTokens: 50, outputTokens: 50 };
const status = { configured: true, accessGranted: true, visionEnabled: true, quota, defaultMode: "quick" };
const entity = (kind: string, entityId: string, revision: number, value: unknown) => ({ kind, entityId, revision, ordinal: 0, deleted: false, value });
const directory = () => state.items.map((item, index) => ({ entityId: item.id, title: item.title, timeLabel: "刚刚", ordinal: -index, revision: item.revision }));
const manifest = { base: { view: "chat", mode: "quick", activeConversationId: null, activeProjectId: null, enabledSkillIds: [] }, hasDraftAttachments: true, hasVideoDraftSettings: false };
const error = (code: string, message: string, statusCode = 409) => Response.json({ error: { code, message } }, { status: statusCode });
const nativeFetch = window.fetch.bind(window);
window.fetch = async (target, init) => {
  const url = new URL(String(target), location.href), method = init?.method ?? "GET";
  if (!url.pathname.startsWith("/api/")) return nativeFetch(target, init);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.pathname.startsWith("/api/auth/")) return Response.json({ user, accessToken: "synthetic", refreshToken: "synthetic" });
  if (url.pathname === "/api/ai/status") return Response.json(status);
  if (url.pathname === "/api/ai/persona") return Response.json({ revision: 1, profile: { ...defaultAiPersonaProfile(), name: "V2 AI", onboardingComplete: true, expression: "none" } });
  if (url.pathname === "/api/ai/workspace") { record("FORBIDDEN_V1_WORKSPACE"); throw Error("V2 attempted whole-account V1 workspace"); }
  const root = "/api/ai/workspace-v2";
  if (url.pathname === `${root}/bootstrap`) return Response.json({ schemaVersion: 2, epoch: 1, manifestRevision: 1, manifest, conversations: directory(), projects: [] });
  const conversationId = url.pathname.match(/\/conversations\/([^/]+)\/(?:messages|context)$/)?.[1];
  if (conversationId) {
    const item = state.items.find(value => value.id === conversationId);
    if (!item) return error("AI_CONVERSATION_NOT_FOUND", "没有找到对话", 404);
    if (url.pathname.endsWith("/context")) return Response.json({ epoch: 1, conversation: directory().find(value => value.entityId === item.id),
      draft: item.draftRevision ? entity("draft", item.id, item.draftRevision, item.draft) : null,
      draftAttachment: item.attachmentRevision ? entity("draftAttachment", item.id, item.attachmentRevision, item.attachments) : null, project: null });
    const limit = Math.min(30, Number(url.searchParams.get("limit") ?? 30));
    const before = url.searchParams.get("before");
    const end = before ? item.messages.findIndex(message => message.id === before) : item.messages.length;
    const start = Math.max(0, end - limit);
    record(`read-page:${item.id}:${start}:${end}`);
    return Response.json({ epoch: 1, revision: item.revision, messages: item.messages.slice(start, end), hasMore: start > 0, nextBefore: start > 0 ? item.messages[start].id : null });
  }
  if (url.pathname === `${root}/mutate` && method === "POST") {
    if (state.receipts[body.mutationId]) return Response.json(state.receipts[body.mutationId]);
    const op = body.ops?.[0];
    if (!op) return error("AI_WORKSPACE_INVALID", "缺少操作", 400);
    let revision = 1;
    if (op.kind === "conversation") {
      if (state.items.some(item => item.id === op.entityId)) return error("AI_WORKSPACE_CONFLICT", "重复对话");
      state.items.unshift({ id: op.entityId, title: op.value.title, revision: 1, messages: [], draft: "", draftRevision: 0, attachments: [], attachmentRevision: 0 });
      record(`create:${op.entityId}`);
    } else {
      const item = state.items.find(value => value.id === op.entityId);
      if (!item) return error("AI_CONVERSATION_NOT_FOUND", "没有找到对话", 404);
      if (op.kind === "draft") {
        if (item.draftRevision !== op.expectedRevision) return error("AI_WORKSPACE_CONFLICT", "草稿冲突");
        item.draft = op.value; revision = ++item.draftRevision; record(`draft:${item.id}:${item.draft}`);
      } else if (op.kind === "draftAttachment") {
        if (item.attachmentRevision !== op.expectedRevision) return error("AI_WORKSPACE_CONFLICT", "附件冲突");
        item.attachments = op.value; revision = ++item.attachmentRevision; record(`attachments:${item.id}:${item.attachments.length}`);
      } else return error("AI_WORKSPACE_INVALID", "不支持的操作", 400);
    }
    const ack = { epoch: 1, entities: [{ kind: op.kind, entityId: op.entityId, revision, deleted: false }] };
    state.receipts[body.mutationId] = ack; save(); return Response.json(ack);
  }
  if (url.pathname === `${root}/append-user` || url.pathname === `${root}/commit-assistant`) {
    if (state.receipts[body.mutationId]) return Response.json(state.receipts[body.mutationId]);
    const item = state.items.find(value => value.id === body.conversationId);
    if (!item || item.revision !== body.expectedRevision) return error("AI_WORKSPACE_CONFLICT", "会话冲突");
    const message: AiWorkspaceMessage = url.pathname.endsWith("append-user") ? body.message : {
      id: body.messageId, role: "assistant", requestId: body.requestId, content: state.requests[body.requestId]?.content ?? "", time: "12:00", status: "ready",
    };
    if (message.role === "assistant" && !item.messages.some(value => value.role === "user" && value.requestId === body.requestId)) return error("AI_WORKSPACE_CONFLICT", "回复没有用户消息");
    item.messages.push(message); item.revision++;
    const ack = { epoch: 1, entityId: item.id, revision: item.revision, messageIds: [message.id] };
    state.receipts[body.mutationId] = ack; save(); record(`${message.role}:${item.id}:${message.content}`); return Response.json(ack);
  }
  if (url.pathname === "/api/ai/chat/stream") {
    const item = state.items.find(value => value.id === body.conversationId);
    if (!item?.messages.some(value => value.role === "user" && value.requestId === body.requestId)) return error("AI_WORKSPACE_CONFLICT", "请求之前没有保存用户消息");
    const answer = { requestId: body.requestId, content: `V2 回复：${item.title} / ${body.messages.at(-1)?.content ?? ""}`,
      model: "synthetic", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, estimated: false } };
    state.requests[body.requestId] = answer; save(); record(`model:${item.id}:${body.attachments?.length ?? 0}`);
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ async start(controller) {
      let seq = 0;
      const emit = (type: string, data: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data, requestId: body.requestId, runId: body.requestId, stepId: body.requestId, seq: ++seq, timestamp: Date.now() })}\n\n`));
      emit("run_started", { startedAt: Date.now() });
      emit("answer_delta", { delta: "V2 回复：" });
      await new Promise(resolve => setTimeout(resolve, 300));
      emit("answer_delta", { delta: answer.content.slice("V2 回复：".length) });
      emit("run_finished", { response: answer }); controller.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
  }
  if (/^\/api\/ai\/requests\/[^/]+$/.test(url.pathname)) {
    const requestId = url.pathname.split("/").at(-1)!;
    const result = state.requests[requestId];
    return result ? Response.json({ status: "completed", result }) : error("AI_REQUEST_NOT_FOUND", "请求尚未提交", 404);
  }
  throw Error(`Fixture rejects ${method} ${url.pathname}`);
};
function Preview() {
  const { session, login } = useAuth();
  const [events, setEvents] = useState("");
  useEffect(() => { void login(user.email, "synthetic", false); }, [login]);
  useEffect(() => { const update = () => setEvents(evidence.join("\n")); window.addEventListener("v2-fixture-evidence", update); return () => window.removeEventListener("v2-fixture-evidence", update); }, []);
  return <main style={{ height: "100vh" }}><div style={{ height: 38 }}>V2 本地合成验收（非生产）</div><div style={{ height: "calc(100vh - 128px)" }}>{session ? <TongpinAIPage user={user} /> : "准备中"}</div><output aria-label="V2 验收证据" style={{ display: "block", height: 90, overflow: "auto", whiteSpace: "pre-wrap" }}>{events}</output></main>;
}
createRoot(document.getElementById("root")!).render(<AuthProvider><Preview /></AuthProvider>);
