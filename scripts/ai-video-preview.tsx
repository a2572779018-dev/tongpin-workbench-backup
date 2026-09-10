/** DEV ONLY: isolated port, synthetic account, no real provider/auth/network requests. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "../src/auth/AuthContext";
import { AiVideoPanel } from "../src/features/tongpin-ai/AiVideoPanel";
import { AdminAiVideoSettings } from "../src/features/tongpin-ai/AdminAiVideoSettings";
import "../src/styles.css";
import "../src/features/tongpin-ai/AdminAiQuotaPanel.css";
import type { AiVideoJob } from "../shared/aiVideo";
if (location.port !== "5176") throw new Error("Fixture requires isolated port 5176");
let settings = { enabled: true, quotaPoints: 1000, apiKeyConfigured: true };
let jobs: AiVideoJob[] = [];
const user = { id: "fixture-only", name: "预览成员", email: "fixture@example.invalid", role: "admin", status: "active" };
window.fetch = async (target, init) => {
  const url = new URL(String(target), location.href), method = init?.method || "GET";
  if (url.pathname.startsWith("/api/auth/")) return Response.json({ user, accessToken: "nonsecret-fixture", refreshToken: "nonsecret-fixture" });
  if (url.pathname === "/api/admin/ai/video") { if (method === "PUT") settings = { ...settings, ...JSON.parse(String(init?.body)), apiKey: undefined }; return Response.json({ settings, pending: [] }); }
  if (url.pathname === "/api/admin/ai/video/test") return Response.json({ message: "隔离测试：未调用真实服务" });
  if (url.pathname === "/api/ai/videos") {
    if (method === "POST") { const data = JSON.parse(String(init?.body)); const job = { ...data, id: data.requestId, status: "queued", progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quotaPoints: 1000, reserved: true }; jobs.unshift(job); return Response.json({ job }); }
    return Response.json({ settings, jobs, quota: { limitTokens: 10000, usedTokens: 0, reservedTokens: 0, remainingTokens: 10000, inputTokens: 0, outputTokens: 0 } });
  }
  if (/^\/api\/ai\/videos\//.test(url.pathname)) { jobs = jobs.map(j => ({ ...j, status: "completed", progress: 100, reserved: false })); return Response.json({ job: jobs[0] }); }
  throw new Error("No fixture route; network disabled");
};
function Preview() {
  const { login, session } = useAuth(); const [open, setOpen] = useState(false);
  useEffect(() => { void login("fixture@example.invalid", "fixture-only", false); }, [login]);
  return <main style={{ padding: 36, maxWidth: 1100, margin: "auto" }}><p>隔离验收 · 合成数据 · 不调用真实服务</p><button onClick={() => setOpen(true)}>打开成员视频窗口</button>{session ? <AdminAiVideoSettings /> : null}{open ? <AiVideoPanel onClose={() => setOpen(false)} /> : null}</main>;
}
createRoot(document.getElementById("root")!).render(<AuthProvider><Preview /></AuthProvider>);
