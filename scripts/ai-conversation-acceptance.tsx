/** Real workspace/components, synthetic transport. No provider/network requests.
 * Open only on loopback: /scripts/ai-conversation-acceptance.html. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "../src/auth/AuthContext";
import { TongpinAIPage } from "../src/pages/TongpinAIPage";
import { defaultAiPersonaProfile } from "../shared/aiPersona";
import { hydrateWorkspace, serializeWorkspace } from "../src/features/tongpin-ai/workspaceState";
import type { User } from "../src/types";
import type { AiWorkspaceSnapshot } from "../shared/aiWorkspace";
import "../src/styles.css";
if (location.hostname !== "127.0.0.1") throw Error("Loopback-only test fixture");
const account = "conversation-acceptance-synthetic";
const parameters = new URLSearchParams(location.search);
const storageKey = `tongpin-conversation-acceptance:${parameters.get("run") ?? "manual"}`;
const streamDelay = parameters.has("fast") ? 100 : 5000;
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=";
const user = { id: account, name: "隔离验收", email: "test@example.invalid", role: "member", status: "active" } as User;
const quota = { limitTokens: 1000000, remainingTokens: 999900, usedTokens: 100, reservedTokens: 0, inputTokens: 50, outputTokens: 50 };
const imageEdit = parameters.has("imageEdit");
const status = { configured: true, accessGranted: true, imageEnabled: true, imageQuotaTokens: 120, imageEditTiers: imageEdit ? ["deep"] : [], visionEnabled: !imageEdit, webSearchEnabled: false, quota, defaultMode: "quick" };
let snapshot: AiWorkspaceSnapshot = JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? { revision: 1, schemaVersion: 1, updatedAt: new Date().toISOString(), state: { ...serializeWorkspace(hydrateWorkspace(null)), mode: "deep" as const, activeConversationId: "a", activeProjectId: "project-a", projects: [{ id: "project-a", title: "A 项目", timeLabel: "", instructions: "A immutable project instructions" }], conversations: [{ id: "a", title: "A 异步任务", projectId: "project-a", timeLabel: "", messages: [] }, { id: "b", title: "B 编辑中", timeLabel: "", messages: [] }, { id: "c", title: "C 后台视频", timeLabel: "", messages: [{ id: "video-c-reply", role: "assistant", content: "视频生成任务", artifactId: "video-c", status: "ready", time: "" }] }], artifacts: [{ id: "video-c", conversationId: "c", title: "隔离合成视频", kind: "视频", summary: "仅验证后台状态", updatedLabel: "", sections: [], data: { videoJobId: "fixture-video-c", videoStatus: "processing" } }], drafts: { a: "@image 生成一只橘猫", b: "B 的草稿不能丢" }, draftAttachments: { b: [{ id: "b-ref", name: "B.txt", mimeType: "text/plain", content: "B 的参考不能串入 A" }] } } };
const videoCreatedAt = Number(localStorage.getItem(`${storageKey}:video-start`) ?? Date.now());
localStorage.setItem(`${storageKey}:video-start`, String(videoCreatedAt));
const evidence: string[] = [];
type SyntheticTask = {
  tenantId: string; userId: string; requestId: string; runId: string; conversationId: string;
  version: number; status: "queued" | "awaiting_authorization" | "running" | "completed";
  createdAt: number; updatedAt: number; deadlineAt: number; dueAt: number | null;
  requestText: string;
  hasGrant: boolean;
  authorization?: { grantId: string };
  videoParameters?: { model: string; seconds: number; resolution: string; aspectRatio: string; referenceIds: string[] };
  tool: { capability: "image" | "video"; estimatedPoints: number; sourceAssetIds: string[]; serviceRequestId?: string; artifactIds?: string[] };
};
const taskStorageKey = `${storageKey}:media-tasks`;
const tasks = new Map<string, SyntheticTask>(JSON.parse(localStorage.getItem(taskStorageKey) ?? "[]"));
if (parameters.has("multiImage") && !snapshot.state?.artifacts.some(item => item.id === "multi-image-source")) {
  const sourceIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const conversation = snapshot.state?.conversations.find(item => item.id === "a");
  if (!snapshot.state || !conversation) throw Error("Multi-image fixture has no source conversation");
  conversation.messages.push({ id: "multi-image-source-message", role: "assistant", content: "已经生成两张人物图片。", artifactId: "multi-image-source", status: "ready", time: "" });
  snapshot.state.artifacts.unshift({ id: "multi-image-source", conversationId: "a", projectId: "project-a", title: "两张人物图片", kind: "图片", summary: "人物图片", updatedLabel: "", sections: [], data: { images: sourceIds.map(assetId => ({ assetId })) } });
  snapshot.state.drafts.a = "用刚才同一个人物做视频";
  const now = Date.now();
  tasks.set("multi-image-source-request", { tenantId: "fixture-tenant", userId: account, requestId: "multi-image-source-request", runId: "multi-image-source-run", conversationId: "a",
    version: 2, status: "completed", createdAt: now - 10_000, updatedAt: now - 9_000, deadlineAt: now + 60_000, dueAt: null,
    requestText: "生成两张人物图片", hasGrant: true, tool: { capability: "image", estimatedPoints: 120, sourceAssetIds: [], artifactIds: sourceIds } });
  localStorage.setItem(storageKey, JSON.stringify(snapshot));
  localStorage.setItem(taskStorageKey, JSON.stringify([...tasks]));
}
const references = new Map<string, { conversationId: string; generatedAssetId?: string; sourceVideo?: { documentId: string; name: string; timeSeconds: number } }>();
let referenceSequence = 0;
const nativeFetch = window.fetch.bind(window);
const persistTasks = () => localStorage.setItem(taskStorageKey, JSON.stringify([...tasks]));
function taskOnRead(task: SyntheticTask): SyntheticTask {
  const elapsed = Date.now() - task.createdAt;
  if (task.status === "queued" && elapsed >= 900 || task.status === "awaiting_authorization" && task.hasGrant) {
    task.status = task.hasGrant ? "running" : "awaiting_authorization"; task.version++; task.updatedAt = Date.now();
    if (task.hasGrant && task.tool.capability === "video") task.tool.serviceRequestId = `fixture-video-${task.requestId}`;
    record(`media-task-${task.status}:${task.tool.capability}:${task.conversationId}`);
  }
  if (task.status === "running" && elapsed >= 3100) {
    task.status = "completed"; task.version++; task.updatedAt = Date.now(); task.dueAt = null;
    task.tool.artifactIds = [task.tool.capability === "video" ? task.tool.serviceRequestId! : `fixture-image-${task.requestId}`];
    record(`media-task-completed:${task.tool.capability}:${task.conversationId}`);
  }
  persistTasks();
  return task;
}
let start = 0, feedbackPrompt = "", awaitingFirstDelta = false;
const record = (text: string) => { evidence.push(text); window.dispatchEvent(new Event("fixture-evidence")); };
document.addEventListener("click", event => { if ((event.target as HTMLElement).closest("button[aria-label='发送消息']")) { start = performance.now(); feedbackPrompt = (document.querySelector("textarea") as HTMLTextAreaElement | null)?.value ?? ""; } }, true);
const feedbackObserver = new MutationObserver(() => {
  if (start && feedbackPrompt && Array.from(document.querySelectorAll(".tp-ai-message.is-user")).some(row => row.textContent?.includes(feedbackPrompt))) { record(`visible_feedback_ms=${(performance.now() - start).toFixed(1)}`); start = 0; feedbackPrompt = ""; }
  if (awaitingFirstDelta && Array.from(document.querySelectorAll(".tp-ai-message")).some(row => row.textContent?.includes("这是来自真实数据流的逐步回复。") && !row.textContent.includes("第二段在稍后抵达"))) { awaitingFirstDelta = false; record("DOM:first-delta-visible-before-finish"); }
});
feedbackObserver.observe(document.body, { childList: true, subtree: true });
window.fetch = async (target, init) => {
  const url = new URL(String(target), location.href), method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.pathname.startsWith("/api/auth/")) return Response.json({ user, accessToken: "synthetic-only", refreshToken: "synthetic-only" });
  if (url.pathname === "/api/ai/status") return Response.json(status);
  if (url.pathname === "/api/ai/availability") return Response.json({ status, check: { state: "reachable", checkedAt: new Date().toISOString(), message: "isolated fixture" } });
  if (url.pathname === "/api/ai/persona") return Response.json({ revision: 1, profile: { ...defaultAiPersonaProfile(), name: "验收 AI", onboardingComplete: true, expression: "none" } });
  if (url.pathname === "/api/ai/workspace") {
    if (method === "PUT") {
      if (parameters.has("failSelectionSaveOnce") && !localStorage.getItem(`${storageKey}:selection-save-failed`)
        && body.state?.artifacts?.some((item: { data?: { generatedImageSelection?: unknown } }) => item.data?.generatedImageSelection)) {
        localStorage.setItem(`${storageKey}:selection-save-failed`, "1");
        record("workspace-selection-save-rejected");
        return Response.json({ error: { code: "AI_WORKSPACE_WRITE_FAILED", message: "合成验收：选图任务保存失败" } }, { status: 503 });
      }
      if (parameters.has("failMediaSave") && body.state?.artifacts?.some((item: { data?: { mediaTaskRequestId?: string; mediaTaskSubmitError?: string } }) => item.data?.mediaTaskRequestId && !item.data?.mediaTaskSubmitError)) {
        record("workspace-media-save-rejected");
        return Response.json({ error: { code: "AI_WORKSPACE_WRITE_FAILED", message: "合成验收：媒体提交前保存失败" } }, { status: 503 });
      }
      snapshot = { ...snapshot, revision: snapshot.revision + 1, state: body.state };
      localStorage.setItem(storageKey, JSON.stringify(snapshot));
    }
    return Response.json(snapshot);
  }
  if (url.pathname === "/api/ai/media-tasks" && method === "POST") {
    if (new Headers(init?.headers).get("X-Tongpin-Account") !== account) throw Error("Media task lost current account scope");
    const conversation = snapshot.state?.conversations.find(item => item.id === body.conversationId);
    const submitted = conversation?.messages.some(item => item.role === "user" && item.content === body.requestText);
    const artifact = snapshot.state?.artifacts.find(item => item.conversationId === body.conversationId && item.data?.mediaTaskRequestId === body.requestId);
    if (!submitted || !artifact) throw Error("Media task POST preceded durable workspace source and artifact");
    if (body.intent === "image") {
      const documents = conversation?.messages.filter(item => item.role === "user").flatMap(item => item.attachments ?? []) ?? [];
      for (const id of body.sourceAssetIds ?? []) {
        const source = documents.find(item => item.id === id);
        if (!source?.media || source.media.kind !== "image" || !source.media.frames[0]?.dataUrl.startsWith("data:image/")) throw Error("Image task lost the exact persisted reference image");
      }
      record(`image-source-validated:${body.sourceAssetIds?.length ?? 0}`);
    } else if (body.intent === "video") {
      if (JSON.stringify(body.videoParameters?.referenceIds) !== JSON.stringify(body.sourceAssetIds)) throw Error("Video task reference list changed between upload and POST");
      if (JSON.stringify(artifact.data?.videoRequest?.referenceIds) !== JSON.stringify(body.sourceAssetIds)) throw Error("Video task POST preceded durable reference ID save");
      for (const id of body.sourceAssetIds ?? []) if (references.get(id)?.conversationId !== body.conversationId) throw Error("Video task used a foreign or missing reference ID");
    } else throw Error("Fixture received unsupported media intent");
    const hasGrant = body.confirmedMediaExecution?.confirmed === true;
    if (hasGrant && (!Number.isSafeInteger(body.confirmedMediaExecution.maxPointsPerTool) || body.confirmedMediaExecution.maxPointsPerTool < (body.intent === "image" ? 120 : 250))) throw Error("Media task confirmed budget below fixture cost");
    if (!hasGrant && (!(parameters.has("dispatch") || parameters.has("multiImage")) || body.entrypoint !== "natural")) throw Error("Direct media submission lacked click-scoped persisted grant");
    let task = tasks.get(body.requestId);
    if (!task) {
      const now = Date.now();
      task = { tenantId: "fixture-tenant", userId: account, requestId: body.requestId, runId: crypto.randomUUID(), conversationId: body.conversationId,
        version: 1, status: "queued", createdAt: now, updatedAt: now, deadlineAt: now + 60_000, dueAt: now, requestText: body.requestText, hasGrant,
        ...(body.videoParameters ? { videoParameters: body.videoParameters } : {}),
        tool: { capability: body.intent, estimatedPoints: body.intent === "image" ? 120 : 250, sourceAssetIds: [...(body.sourceAssetIds ?? [])] } };
      tasks.set(body.requestId, task); persistTasks();
      record(`media-task-post:${body.intent}:${body.conversationId}:refs=${body.sourceAssetIds?.length ?? 0}`);
      record(`media-task-grant:${body.intent}:${hasGrant ? "yes" : "no"}`);
      if (conversation?.projectId === "project-a" && snapshot.state?.projects.find(item => item.id === "project-a")?.instructions === "A immutable project instructions") record("project-context:A immutable project instructions");
    } else record(`media-task-duplicate-post:${body.requestId}`);
    return Response.json({ task }, { status: 202 });
  }
  if (url.pathname.startsWith("/api/ai/media-tasks/by-request/") && method === "GET") {
    const requestId = decodeURIComponent(url.pathname.split("/").at(-1)!);
    const task = tasks.get(requestId);
    return task ? Response.json({ task: taskOnRead(task) }) : Response.json({ error: { code: "AI_MEDIA_TASK_NOT_FOUND", message: "尚未提交" } }, { status: 404 });
  }
  if (/^\/api\/ai\/media-tasks\/[^/]+\/authorize$/.test(url.pathname) && method === "POST") {
    const runId = decodeURIComponent(url.pathname.split("/")[4]);
    const task = [...tasks.values()].find(item => item.runId === runId);
    if (!task || task.status !== "awaiting_authorization" || body.confirmed !== true || body.maxPointsPerTool < task.tool.estimatedPoints) throw Error("Fixture rejected an invalid media authorization");
    task.hasGrant = true; task.authorization = { grantId: crypto.randomUUID() }; task.version++; task.updatedAt = Date.now();
    persistTasks(); record(`media-task-authorize:${task.tool.capability}:${task.conversationId}`);
    return Response.json({ task });
  }
  if (url.pathname.startsWith("/api/ai/media-tasks/") && method === "GET") {
    const runId = decodeURIComponent(url.pathname.split("/").at(-1)!);
    const task = [...tasks.values()].find(item => item.runId === runId);
    return task ? Response.json({ task: taskOnRead(task) }) : Response.json({ error: { code: "AI_MEDIA_TASK_NOT_FOUND", message: "尚未提交" } }, { status: 404 });
  }
  if (url.pathname === "/api/ai/videos/fixture-video-c") {
    const ready = Date.now() - videoCreatedAt > 7000;
    record(`video:c:${ready ? "completed" : "processing"}`);
    return Response.json({ job: { id: "fixture-video-c", prompt: "隔离视频", seconds: 3, model: "minimax_h3", resolution: "768p", aspectRatio: "16:9", status: ready ? "completed" : "processing", progress: ready ? 100 : 0, createdAt: new Date(videoCreatedAt).toISOString(), updatedAt: new Date().toISOString(), quotaPoints: 0, reserved: !ready } });
  }
  if (url.pathname === "/api/ai/videos") {
    if (method === "POST") throw Error("Fixture forbids legacy paid /api/ai/videos POST");
    return Response.json({ settings: { enabled: true, apiKeyConfigured: true, quotaPoints: 250, defaultModel: "minimax_h3", availableModels: ["minimax_h3"], modelsVerified: true }, jobs: [], quota });
  }
  if (url.pathname.startsWith("/api/ai/videos/")) {
    if (url.pathname.endsWith("/content")) return nativeFetch("/scripts/video-chat-fixture.mp4");
    const id = decodeURIComponent(url.pathname.split("/")[4]);
    const task = [...tasks.values()].find(item => item.tool.serviceRequestId === id);
    const parameters = task?.videoParameters;
    const job = task && parameters ? { id, prompt: task.requestText, model: parameters.model, seconds: parameters.seconds, resolution: parameters.resolution,
      aspectRatio: parameters.aspectRatio, status: taskOnRead(task).status === "completed" ? "completed" : "processing", progress: task.status === "completed" ? 100 : 0,
      createdAt: new Date(task.createdAt).toISOString(), updatedAt: new Date(task.updatedAt).toISOString(), quotaPoints: 250, reserved: task.status !== "completed", referenceIds: task.tool.sourceAssetIds } : null;
    return job ? Response.json({ job }) : Response.json({ error: { code: "AI_VIDEO_NOT_FOUND", message: "尚未提交" } }, { status: 404 });
  }
  if (url.pathname === "/api/ai/video-references/generated-asset" && method === "POST") {
    if (parameters.has("slowSelection")) { record("generated-asset-read-start"); await new Promise(resolve => setTimeout(resolve, 1200)); }
    const task = [...tasks.values()].find(item => item.conversationId === body.conversationId && item.tool.capability === "image" && item.tool.artifactIds?.includes(body.assetId));
    if (!task || taskOnRead(task).status !== "completed") throw Error("Generated image reference is not owned by this conversation");
    record(`generated-asset:${body.conversationId}:${body.assetId}`);
    return Response.json({ assetId: body.assetId, conversationId: body.conversationId, mimeType: "image/png", base64: pixel.split(",")[1], sourceFingerprint: `fixture-fingerprint-${body.assetId}` });
  }
  if (url.pathname === "/api/ai/video-references") {
    if (!body.generatedAsset && !body.sourceVideo) {
      const inTurn = snapshot.state?.conversations.find(item => item.id === body.conversationId)?.messages
        .filter(message => message.role === "user").flatMap(message => message.attachments ?? [])
        .some(item => item.media?.kind === "image" && item.media.frames.some(frame => frame.dataUrl === body.dataUrl));
      if (!inTurn) throw Error("Plain video reference was not saved in this conversation before upload");
    }
    if (body.sourceVideo) {
      const source = snapshot.state?.conversations.find(item => item.id === body.sourceVideo.conversationId)?.messages.flatMap(message => message.attachments ?? []).find(item => item.id === body.sourceVideo.documentId);
      const frame = source?.media?.frames[source.media.selectedFrameIndex ?? -1];
      if (!frame || frame.dataUrl !== body.dataUrl || frame.timeSeconds !== body.sourceVideo.timeSeconds) throw Error("Reference upload preceded durable selected source");
    }
    if (body.generatedAsset) {
      const task = [...tasks.values()].find(item => item.tool.capability === "image" && item.conversationId === body.conversationId && item.tool.artifactIds?.includes(body.generatedAsset.assetId));
      if (!task || body.generatedAsset.conversationId !== body.conversationId || body.generatedAsset.sourceFingerprint !== `fixture-fingerprint-${body.generatedAsset.assetId}`) throw Error("Generated image upload lost source authorization");
    }
    const id = (String(++referenceSequence).padStart(64, "a"));
    references.set(id, { conversationId: body.conversationId, ...(body.generatedAsset ? { generatedAssetId: body.generatedAsset.assetId } : {}), ...(body.sourceVideo ? { sourceVideo: body.sourceVideo } : {}) });
    record(`video-reference:${JSON.stringify(body.sourceVideo ?? body.generatedAsset ?? {})}`);
    return Response.json({ id });
  }
  if (url.pathname.startsWith("/api/ai/assets/") && method === "GET") {
    const assetId = decodeURIComponent(url.pathname.split("/").at(-1)!);
    const task = [...tasks.values()].find(item => item.tool.capability === "image" && item.tool.artifactIds?.includes(assetId));
    return task && taskOnRead(task).status === "completed"
      ? Response.json({ assetId, mimeType: "image/png", base64: pixel.split(",")[1] })
      : Response.json({ error: { code: "AI_ASSET_NOT_FOUND", message: "尚未生成" } }, { status: 404 });
  }
  if (url.pathname === "/api/ai/preflight") return Response.json({ canSend: true, quota, budget: { inputTokens: 20, maxOutputTokens: 1000, searchInputReserve: 0 } });
  if (url.pathname === "/api/ai/chat/stream") {
    record(`stream:${body.conversationId}:${body.mode}:${body.requestId}:retry=${body.retryOf ?? "none"}:attachments=${(body.attachments ?? []).map((item: { name: string }) => item.name).join(",")}`);
    const encoder = new TextEncoder();
    const content = "这是来自真实数据流的逐步回复。第二段在稍后抵达，并不会等待完整回答后重播。";
    const latestUserText = (body.messages ?? []).filter((item: { role: string }) => item.role === "user").at(-1)?.content ?? "";
    const dispatchKind = parameters.has("dispatch") && /给猫咪来幅画/.test(latestUserText) ? "image"
      : parameters.has("dispatch") && /让这个图动起来/.test(latestUserText) ? "video" : undefined;
    return new Response(new ReadableStream({ async start(controller) {
      let seq = 0;
      const emit = (type: string, data: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data, requestId: body.requestId, runId: body.requestId, stepId: body.requestId, seq: seq++, timestamp: Date.now() })}\n\n`));
      emit("run_started", { startedAt: Date.now() });
      emit("public_summary_delta", { delta: "我会先给出简洁答复。" });
      awaitingFirstDelta = true;
      emit("answer_delta", { delta: "这是来自真实数据流的逐步回复。" });
      record("stream:first-delta");
      const partial = new URLSearchParams(location.search).has("partial") && !body.retryOf;
      await new Promise(resolve => setTimeout(resolve, partial ? 1000 : streamDelay));
      emit("answer_delta", { delta: "第二段在稍后抵达，并不会等待完整回答后重播。" });
      emit("run_finished", { response: { requestId: body.requestId, content, model: "synthetic", quota, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, ...(dispatchKind ? { dispatch: { kind: dispatchKind, prompt: latestUserText } } : {}), ...(partial ? { completion: { state: "partial", reason: "output_limit", canContinue: true } } : {}) } });
      record("stream:finished"); controller.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
  }
  if (url.pathname === "/api/ai/chat") {
    record(`chat:${body.outputFormat}:${body.conversationId}:${body.mode}:${body.projectContext ?? "none"}`);
    if (body.outputFormat === "image_plan" || body.outputFormat === "video_plan") {
      throw Error("Fixture forbids legacy image/video planner POST");
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    return Response.json({ requestId: body.requestId, content: "B 的普通回复", dispatch: { kind: "text", content: "B 的普通回复" }, model: "synthetic", quota, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } });
  }
  if (url.pathname === "/api/ai/images") {
    throw Error("Fixture forbids legacy paid /api/ai/images POST");
  }
  throw Error(`Fixture rejects network: ${method} ${url.pathname}`);
};
function Preview() {
  const { session, login } = useAuth(); const [events, setEvents] = useState("");
  useEffect(() => { void login(user.email, "synthetic-only", false); }, [login]);
  useEffect(() => { const update = () => setEvents(evidence.join("\n")); window.addEventListener("fixture-evidence", update); return () => window.removeEventListener("fixture-evidence", update); }, []);
  return <main style={{ height: "100vh", background: "#faf7ee" }}><div style={{ height: 42, padding: 8 }}>真实组件 · 合成数据 · 禁止外部请求</div><div style={{ height: "calc(100vh - 142px)" }}>{session ? <TongpinAIPage user={user} /> : "正在准备"}</div><output aria-label="验收证据" style={{ whiteSpace: "pre-wrap", display: "block", height: 100, overflow: "auto", fontSize: 12 }}>{events}</output></main>;
}
createRoot(document.getElementById("root")!).render(<AuthProvider><Preview /></AuthProvider>);
