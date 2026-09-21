/** Loopback-only interaction fixture. All requests use synthetic data. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "../src/auth/AuthContext";
import { AdminAiQuotaPanel } from "../src/features/tongpin-ai/AdminAiQuotaPanel";
import { ChatWorkspace } from "../src/features/tongpin-ai/ChatWorkspace";
import { AI_BUSINESS_TIERS } from "../shared/ai";
import { VIDEO_MODELS, videoSeconds } from "../shared/aiVideoModels";
import "../src/styles.css";
import "../src/features/tongpin-ai/tongpin-ai.css";
import "../src/features/tongpin-ai/chat-layout.css";
import "../src/features/tongpin-ai/ai-metal-theme.css";
import "../src/features/tongpin-ai/ai-refinements.css";
if (location.hostname !== "127.0.0.1" || location.port !== "5176") throw Error("Isolated port required");
const user = { id: "settings-fixture", name: "验收管理员", email: "fixture@example.invalid", role: "admin", status: "active" };
const quota = { limitTokens: 1_000_000, remainingTokens: 1_000_000, usedTokens: 0, reservedTokens: 0, inputTokens: 0, outputTokens: 0 };
const models = ["gpt-6-astra", "hy3", "mimo-v2.5", "qwen3.8-flash", "image-preview", ...VIDEO_MODELS.map(m => m.id)];
const primary = { id: "primary", name: "文字与图片服务", baseUrl: "https://example.invalid/v1", protocol: "chat_completions", enabled: true, apiKeyConfigured: true, availableModels: models, modelsVerified: true, modelsVerifiedAt: new Date().toISOString() };
let harness = { providers: [primary, { ...primary, id: "video", name: "视频服务", baseUrl: "https://www.75api.com/v1" }], tiers: Object.fromEntries(AI_BUSINESS_TIERS.map(tier => [tier, { providerId: "primary", modelId: tier === "quick" ? "hy3" : "gpt-6-astra", protocol: "chat_completions", maxOutputTokens: 2048, reasoningEffort: "", capabilities: ["chat", "image", "video"], imageProviderId: "primary", imageModelId: "image-preview", videoProviderId: "video", videoModelId: "minimax_h3", enabled: true }])), policy: { strategy: "react", maxToolSteps: 3, requireApproval: true, autoWebSearch: true }, updatedAt: new Date().toISOString(), migratedFromLegacy: false };
window.fetch = async (target, init) => {
  const url = new URL(String(target), location.href), method = init?.method ?? "GET";
  if (url.pathname.startsWith("/api/auth/")) return Response.json({ user, accessToken: "synthetic-only", refreshToken: "synthetic-only" });
  if (url.pathname === "/api/admin/ai/harness") {
    if (method === "PUT") { const input = JSON.parse(String(init?.body)); harness = { ...harness, ...input, providers: input.providers.map(p => ({ ...p, apiKey: undefined, apiKeyConfigured: true, availableModels: models, modelsVerified: true })) }; }
    return Response.json({ harness });
  }
  if (url.pathname.endsWith("/discover")) return Response.json({ models, provider: primary });
  if (url.pathname.endsWith("/provider/test")) return Response.json({ ok: true, models });
  if (url.pathname === "/api/admin/ai/provider") return Response.json({ provider: { name: "原接入", baseUrl: "https://example.invalid/v1", protocol: "chat_completions", quickModel: "hy3", deepModel: "gpt-6-astra", maxOutputTokens: 2048, reasoningEffort: "high", enabled: true, imageModel: "image-preview", imageQuotaTokens: 1000, imageApiKeyConfigured: true, apiKeyConfigured: true, availableModels: models } });
  if (url.pathname === "/api/admin/ai/members") return Response.json({ members: [{ ...user, quota }] });
  const settings = { enabled: true, quotaPoints: 1000, apiKeyConfigured: true, defaultModel: "minimax_h3", availableModels: VIDEO_MODELS.map(m => m.id), modelsVerified: true, profile: { resolutions: ["480p", "768p"], seconds: { "480p": videoSeconds("minimax_h3", "480p"), "768p": videoSeconds("minimax_h3", "768p") }, maxImages: 8, requiresImage: false } };
  if (url.pathname === "/api/admin/ai/video") return Response.json({ settings, pending: [] });
  if (url.pathname === "/api/ai/videos") return Response.json({ settings, jobs: [], quota });
  if (url.pathname === "/api/admin/ai/observability") return Response.json({ generatedAt: new Date().toISOString(), totals: { requests: 0, successRate: 0, averageLatencyMs: 0 }, slices: [], alerts: [], alertHistory: [] });
  throw Error(`Fixture rejects network: ${url.pathname}`);
};
function Preview() {
  const { session, login } = useAuth();
  const [page, setPage] = useState("admin");
  const [draft, setDraft] = useState("帮我生成一段品牌宣传视频");
  const [events, setEvents] = useState<string[]>([]);
  const [selectedTool, setSelectedTool] = useState<"text" | "image" | "presentation">("text");
  const [clarification, setClarification] = useState("");
  useEffect(() => { void login("fixture@example.invalid", "synthetic-only", false); }, [login]);
  const record = (event: string) => setEvents(current => [...current, event]);
  return <main style={{ height: "100vh", overflow: "auto", padding: 24, background: "#faf7ee" }}>
    <nav style={{ display: "flex", gap: 16, paddingBottom: 16 }}><button onClick={() => setPage("admin")}>管理员配置验收</button><button onClick={() => setPage("chat")}>对话发送验收</button><small>合成数据 · 无外部请求</small></nav>
    {session && (page === "admin" ? <AdminAiQuotaPanel /> : <div className="tp-ai-page" style={{ display: "block", height: "calc(100vh - 140px)" }}><ChatWorkspace
      artifactById={new Map()} composerFocusRequest={0} conversationId="fixture-chat" conversationTitle="视频发送验收" draft={draft} enabledSkills={[]}
      messages={[{ id: "summary", role: "assistant", content: "建议先用品牌图形建立识别，再展示产品场景。", analysisSummary: "这段视频用于品牌宣传，重点是品牌辨识度和画面节奏。参考图里的标志应保持一致；短片先展示标志，再切换到产品场景。", time: "12:00", status: "ready" }, ...(clarification ? [{ id: "clarification", role: "assistant" as const, content: clarification, time: "12:01", status: "ready" as const }] : [])]}
      mode="quick" notificationUnread={0} quotaInsufficient={false} responding={false} serviceConnected={true} onDraftChange={setDraft}
      composerTool={selectedTool} onComposerToolChange={setSelectedTool} imageEnabled
      onModeChange={() => {}} onOpenArtifact={() => {}} onSubmit={plan => { record(plan ? `execute:${plan.kind}:${plan.planRequestId}` : "text-dispatch"); setDraft(""); }} characterPaused
      onPlanTool={async (kind, prompt, request) => { record(`plan:${kind}:${request?.model ?? "default"}`); await new Promise(resolve => setTimeout(resolve, 500)); if (prompt === "帮我生成一张图片") { setClarification("你想生成什么内容的图片？"); setDraft(""); record("clarification-only"); return null; } return { kind, prompt: `${prompt}，镜头平稳推进`, summary: "突出品牌标志和科技感", planRequestId: "fixture-plan" }; }}
      onSubmitVideo={async request => { record(`generate:${request.model}:${request.seconds}s:${request.planRequestId}`); setDraft(""); return true; }}
    /></div>)}
    <output aria-label="验收操作记录" style={{ display: "block", whiteSpace: "pre-wrap", fontSize: 12 }}>{events.join("\n")}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<AuthProvider><Preview /></AuthProvider>);
