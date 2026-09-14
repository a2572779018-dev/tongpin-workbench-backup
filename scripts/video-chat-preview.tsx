/** Loopback-only UI fixture. No provider requests and no real credentials. */
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "../src/auth/AuthContext";
import { TongpinAIPage } from "../src/pages/TongpinAIPage";
import { CustomCursor } from "../src/components/CustomCursor";
import { defaultAiPersonaProfile } from "../shared/aiPersona";
import "../src/styles.css";
if (location.hostname !== "127.0.0.1" || location.port !== "5176") throw Error("Isolated port required");
document.documentElement.dataset.appView = "ai";
const key = "video-chat-isolated-fixture";
let saved = JSON.parse(localStorage.getItem(key) || '{"revision":0,"state":null,"jobs":[],"posts":0}');
const save = () => localStorage.setItem(key, JSON.stringify(saved));
const user = { id: "fixture-video", name: "视频验收", email: "video@example.invalid", role: "member", status: "active" };
const quota = { limitTokens: 1000000, remainingTokens: 1000000, usedTokens: 0, reservedTokens: 0, inputTokens: 0, outputTokens: 0 };
const status = { accessGranted: true, configured: true, quickModel: "fixture", deepModel: "fixture", maxOutputTokens: 2048, quota };
const nativeFetch = window.fetch.bind(window);
window.fetch = async (target, init) => {
  const url = new URL(String(target), location.href), method = init?.method || "GET";
  if (url.pathname.startsWith("/api/auth/")) return Response.json({ user, accessToken: "synthetic-only", refreshToken: "synthetic-only" });
  if (url.pathname === "/api/ai/status") return Response.json(status);
  if (url.pathname === "/api/ai/availability") return Response.json({ status, check: { state: "reachable", code: "fixture", message: "隔离模拟", checkedAt: new Date().toISOString() } });
  if (url.pathname === "/api/ai/persona") return Response.json({ revision: 1, profile: { ...defaultAiPersonaProfile(), name: "同频 AI", onboardingComplete: true } });
  if (url.pathname === "/api/ai/workspace") {
    if (method === "PUT") { const body = JSON.parse(String(init?.body)); if ("workspaceDialog" in body.state) throw Error("Invalid persisted UI field"); saved = { ...saved, state: body.state, revision: saved.revision + 1 }; save(); }
    return Response.json({ revision: saved.revision, state: saved.state, schemaVersion: 1, updatedAt: new Date().toISOString() });
  }
  if (url.pathname === "/api/ai/video-references") return Response.json({ id: "a".repeat(64) });
  if (url.pathname === "/api/ai/videos") {
    if (method === "POST") {
      const body = JSON.parse(String(init?.body));
      if (!saved.state?.artifacts.some(a => a.data?.videoJobId === body.requestId)) throw Error("Video POST before durable message!");
      saved.posts++; const job = { ...body, id: body.requestId, status: "processing", progress: 25, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quotaPoints: 1000, reserved: true };
      saved.jobs.unshift(job); save(); return Response.json({ job });
    }
    return Response.json({ settings: { enabled: true, quotaPoints: 1000, apiKeyConfigured: true }, jobs: saved.jobs, quota });
  }
  if (/^\/api\/ai\/videos\//.test(url.pathname)) {
    const job = saved.jobs.find(j => url.pathname.split("/")[4] === j.id);
    if (!job) return Response.json({ error: { message: "未找到", code: "AI_VIDEO_NOT_FOUND" } }, { status: 404 });
    if (url.pathname.endsWith("/content")) return nativeFetch(new URL("/scripts/video-chat-fixture.mp4", location.origin));
    if (Date.now() - Date.parse(job.createdAt) > 20000) { job.status = "completed"; job.progress = 100; job.reserved = false; save(); }
    return Response.json({ job });
  }
  throw Error(`Fixture rejects network: ${url.pathname}`);
};
function Preview() {
  const { login, session } = useAuth();
  useEffect(() => { void login("video@example.invalid", "synthetic", false); }, [login]);
  return <><div style={{ fontSize: 12, padding: 6 }}>隔离验收 · 合成视频 · 不调用服务商 · 测试提交次数 {saved.posts}</div><div style={{ height: "calc(100vh - 30px)", padding: 12 }}>{session ? <TongpinAIPage user={session.user} /> : "加载中"}</div><CustomCursor /></>;
}
createRoot(document.getElementById("root")!).render(<AuthProvider><Preview /></AuthProvider>);
