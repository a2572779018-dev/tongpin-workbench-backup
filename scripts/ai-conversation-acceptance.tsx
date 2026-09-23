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
const status = { configured: true, accessGranted: true, imageEnabled: true, imageEditTiers: imageEdit ? ["deep"] : [], visionEnabled: !imageEdit, webSearchEnabled: false, quota, defaultMode: "quick" };
let snapshot: AiWorkspaceSnapshot = JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? { revision: 1, schemaVersion: 1, updatedAt: new Date().toISOString(), state: { ...serializeWorkspace(hydrateWorkspace(null)), mode: "deep" as const, activeConversationId: "a", activeProjectId: "project-a", projects: [{ id: "project-a", title: "A 项目", timeLabel: "", instructions: "A immutable project instructions" }], conversations: [{ id: "a", title: "A 异步任务", projectId: "project-a", timeLabel: "", messages: [] }, { id: "b", title: "B 编辑中", timeLabel: "", messages: [] }, { id: "c", title: "C 后台视频", timeLabel: "", messages: [{ id: "video-c-reply", role: "assistant", content: "视频生成任务", artifactId: "video-c", status: "ready", time: "" }] }], artifacts: [{ id: "video-c", conversationId: "c", title: "隔离合成视频", kind: "视频", summary: "仅验证后台状态", updatedLabel: "", sections: [], data: { videoJobId: "fixture-video-c", videoStatus: "processing" } }], drafts: { a: "@image 生成一只橘猫", b: "B 的草稿不能丢" }, draftAttachments: { b: [{ id: "b-ref", name: "B.txt", mimeType: "text/plain", content: "B 的参考不能串入 A" }] } } };
const videoCreatedAt = Number(localStorage.getItem(`${storageKey}:video-start`) ?? Date.now());
localStorage.setItem(`${storageKey}:video-start`, String(videoCreatedAt));
const evidence: string[] = [];
const submittedVideos = new Map<string, object>();
const imagePlans = new Map<string, string>();
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
  if (url.pathname === "/api/ai/workspace") { if (method === "PUT") { snapshot = { ...snapshot, revision: snapshot.revision + 1, state: body.state }; localStorage.setItem(storageKey, JSON.stringify(snapshot)); } return Response.json(snapshot); }
  if (url.pathname === "/api/ai/videos/fixture-video-c") {
    const ready = Date.now() - videoCreatedAt > 7000;
    record(`video:c:${ready ? "completed" : "processing"}`);
    return Response.json({ job: { id: "fixture-video-c", prompt: "隔离视频", seconds: 3, model: "minimax_h3", resolution: "768p", aspectRatio: "16:9", status: ready ? "completed" : "processing", progress: ready ? 100 : 0, createdAt: new Date(videoCreatedAt).toISOString(), updatedAt: new Date().toISOString(), quotaPoints: 0, reserved: !ready } });
  }
  if (url.pathname === "/api/ai/videos") {
    if (method === "POST") {
      record(`video-post:references=${body.referenceIds?.length ?? 0}`);
      const job = { ...body, id: body.requestId, status: "processing", progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quotaPoints: 0, reserved: true };
      submittedVideos.set(body.requestId, job); return Response.json({ job });
    }
    return Response.json({ settings: { enabled: true, apiKeyConfigured: true, quotaPoints: 0, defaultModel: "minimax_h3", availableModels: ["minimax_h3"], modelsVerified: true }, jobs: [], quota });
  }
  if (url.pathname.startsWith("/api/ai/videos/")) {
    const job = submittedVideos.get(url.pathname.split("/")[4]);
    return job ? Response.json({ job }) : Response.json({ error: { code: "AI_VIDEO_NOT_FOUND", message: "尚未提交" } }, { status: 404 });
  }
  if (url.pathname === "/api/ai/video-references") {
    if (body.sourceVideo) {
      const source = snapshot.state?.conversations.find(item => item.id === body.sourceVideo.conversationId)?.messages.flatMap(message => message.attachments ?? []).find(item => item.id === body.sourceVideo.documentId);
      const frame = source?.media?.frames[source.media.selectedFrameIndex ?? -1];
      if (!frame || frame.dataUrl !== body.dataUrl || frame.timeSeconds !== body.sourceVideo.timeSeconds) throw Error("Reference upload preceded durable selected source");
    }
    record(`video-reference:${JSON.stringify(body.sourceVideo ?? {})}`); return Response.json({ id: "a".repeat(64) });
  }
  if (url.pathname === "/api/ai/preflight") return Response.json({ canSend: true, quota, budget: { inputTokens: 20, maxOutputTokens: 1000, searchInputReserve: 0 } });
  if (url.pathname === "/api/ai/chat/stream") {
    record(`stream:${body.conversationId}:${body.mode}:${body.requestId}:retry=${body.retryOf ?? "none"}:attachments=${(body.attachments ?? []).map((item: { name: string }) => item.name).join(",")}`);
    const encoder = new TextEncoder();
    const content = "这是来自真实数据流的逐步回复。第二段在稍后抵达，并不会等待完整回答后重播。";
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
      emit("run_finished", { response: { requestId: body.requestId, content, model: "synthetic", quota, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, ...(partial ? { completion: { state: "partial", reason: "output_limit", canContinue: true } } : {}) } });
      record("stream:finished"); controller.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
  }
  if (url.pathname === "/api/ai/chat") {
    record(`chat:${body.outputFormat}:${body.conversationId}:${body.mode}:${body.projectContext ?? "none"}`);
    if (body.outputFormat === "image_plan" || body.outputFormat === "video_plan") {
      if (body.outputFormat === "image_plan") { imagePlans.set(body.requestId, JSON.stringify(body.attachments ?? [])); record(`image-plan:refs=${body.attachments?.length ?? 0}`); }
      await new Promise(resolve => setTimeout(resolve, 3000));
      return Response.json({ requestId: body.requestId, content: "", toolPlan: { kind: body.outputFormat === "image_plan" ? "image" : "video", prompt: "A orange cat image", summary: "隔离合成规划", planRequestId: body.requestId }, model: "synthetic", quota, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } });
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    return Response.json({ requestId: body.requestId, content: "B 的普通回复", dispatch: { kind: "text", content: "B 的普通回复" }, model: "synthetic", quota, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } });
  }
  if (url.pathname === "/api/ai/images") {
    if (!imagePlans.has(body.planRequestId) || imagePlans.get(body.planRequestId) !== JSON.stringify(body.attachments ?? [])) throw Error("Image generation lost or changed the planned reference bytes");
    record(`image:${body.conversationId}:${body.projectContext}:${body.prompt}:refs=${body.attachments?.length ?? 0}`);
    return Response.json({ requestId: body.requestId, images: [{ base64: pixel.split(",")[1], mimeType: "image/png" }], model: "synthetic", quota, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
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
