/** Loopback-only, disposable UX fixture. Real auth/quota/storage/routes; ONLY the
 * external provider boundary is simulated here. Never deploy.
 *
 * Simulated provider surface (everything else is real product code):
 *   POST {base}/images/generations -> a real, openable PNG (base64, b64_json only)
 *   POST {base}/videos            -> queued task id
 *   GET  {base}/videos/{id}       -> queued -> processing -> completed
 *   GET  {base}/videos/{id}/content -> a real playable MP4 file
 *   POST {base}/chat|responses    -> text / dispatch / plan / presentation JSON
 * The reply text and every asset are labelled as simulated. Do not read them as
 * real model quality, real video consistency or real provider billing. */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import bcrypt from "bcryptjs";
import { createRuntime } from "../server/app";
import type { AppConfig } from "../server/config";
import { AiPersonaRepository } from "../server/ai/persona";
import { AiWorkspaceRepository } from "../server/ai/workspace";
import { emptyQuota } from "../server/ai/storage";
import { defaultAiPersonaProfile } from "../shared/aiPersona";
import type { AiWorkspaceState } from "../shared/aiWorkspace";

const evidence = (line: string) => console.log(`[fixture] ${line}`);

// ---------- a real, openable PNG built without any dependency ----------
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function fixturePng(size = 512): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const inBlock = x > size * 0.3 && x < size * 0.7 && y > size * 0.3 && y < size * 0.7;
      raw[offset++] = inBlock ? 30 : Math.round((x / size) * 200) + 20;
      raw[offset++] = inBlock ? 60 : Math.round((y / size) * 180) + 20;
      raw[offset++] = inBlock ? 220 : 120;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const directory = await mkdtemp(path.join(tmpdir(), "tongpin-ai-ux-"));
const fixturePort = Number(process.env.TONGPIN_FIXTURE_PORT || 4318);
const fixtureOrigin = process.env.TONGPIN_FIXTURE_ORIGIN || "http://127.0.0.1:5173";
if (![4318, 4319, 4320].includes(fixturePort) || !/^http:\/\/127\.0\.0\.1:(5173|5174|5175)$/.test(fixtureOrigin)) throw new Error("Only dedicated loopback fixture ports are permitted");
const fixtureApi = `http://127.0.0.1:${fixturePort}`;
const fixtureAnswer = "【本地模拟回复，不调用真实模型】\n\n本周任务可按下面的进度继续推进：\n\n| 事项 | 状态 |\n| --- | --- |\n| 需求核对 | 已完成 |\n| 发布验收 | 待验证 |\n\n示例代码：\n\n```ts\n  const answer = 42;\n\n  console.log(answer);\n```\n\n先核对验收证据，再决定是否发布。";
const fixturePngBase64 = fixturePng().toString("base64");
const fixtureVideo = await readFile(path.resolve("scripts/video-chat-fixture.mp4"));
const fixtureSlides = {
  title: "【本地模拟】验收演示文稿",
  subtitle: "不调用真实模型，仅用于验证生成与导出流程",
  slides: [
    { title: "封面", bullets: ["本地模拟内容", "仅验证生成与导出流程"] },
    { title: "进度", bullets: ["需求核对 已完成", "发布验收 待验证"] },
    { title: "下一步", bullets: ["核对验收证据", "再决定是否发布"] },
  ],
};

const IMAGE_PROMPT = "一只橘色的猫坐在窗台上，柔和自然光";
const VIDEO_PROMPT = "让参考图片里的猫轻轻转头并眨眼";
// A rich-content demo reply: every number is explicitly labelled as simulated
// data, the chart carries unit + source + a raw-data view, and the followup
// chips stay within the 0-3 cap. Triggered by chart/math keywords only.
const fixtureRichAnswer = [
  "【本地模拟回复，不调用真实模型】",
  "",
  "以下全部为**演示数据**，不代表真实统计：",
  "",
  "```chart",
  JSON.stringify({ title: "季度演示营收", unit: "万元", source: "本地模拟示例数据，非真实统计", type: "bar", series: [{ label: "Q1", value: 120 }, { label: "Q2", value: 135.5 }, { label: "Q3", value: 150 }, { label: "Q4", value: 178.2 }] }),
  "```",
  "",
  "圆的面积公式 $A = \\pi r^2$；行间公式：",
  "",
  "$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$",
  "",
  "```followups",
  JSON.stringify(["把图表换成折线图", "解释公式的含义", "总结本季度要点"]),
  "```",
].join("\n");
const videoJobs = new Map<string, number>();
let videoSeq = 0;
let imageCalls = 0;
const jsonReply = (value: unknown) => Response.json({
  status: "completed",
  output_text: JSON.stringify(value),
  usage: { input_tokens: 40, output_tokens: 40, total_tokens: 80 },
});

const config: AppConfig = {
  host: "127.0.0.1", port: fixturePort, dataFile: path.join(directory, "fixture.json"),
  jwtSecret: crypto.randomUUID() + crypto.randomUUID(), clientOrigins: [fixtureOrigin],
  bootstrapAdminEmail: "admin@tongpin.test", bootstrapAdminPassword: "Fixture123!", bootstrapAdminName: "本地验收管理员",
  devEmailPreview: true, isProduction: false, loraExplorerApi: "", loraRpcUrl: "",
  resend: { apiKey: "", from: "" }, smtp: { host: "", port: 587, secure: false, user: "", pass: "", from: "" },
};
const runtime = await createRuntime(config, {
  startLoraCollector: false,
  aiTransport: async (target, init) => {
    const url = new URL(String(target));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const instructions = typeof body.instructions === "string" ? body.instructions : "";
    const markers = [
      instructions.includes("受限 Hub 工作流") ? " workflow=INJECTED" : "",
      instructions.includes("情绪觉察") ? " persona-upstream=INJECTED" : "",
    ].join("");
    evidence(`transport ${method} ${url.pathname} stream=${String(body.stream)}${markers}`);
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "fixture-model", object: "model" }, { id: "fixture-image", object: "model" }, { id: "minimax_h3", object: "model" }, { id: "sd-2-c6", object: "model" }] });

    // A provider-boundary "failure" switch. The product code that consumes this
    // must still go through the real task machine and settle as failed/cancelled;
    // it is never wired to bypass quota or to inject a success card.
    const prompt = String(body.prompt ?? "");
    const wantsFailure = /失败|模拟失败|fail/i.test(prompt);

    // --- image generation: the product only accepts b64_json, never a URL ---
    if (url.pathname.endsWith("/images/generations") || url.pathname.endsWith("/images/edits")) {
      imageCalls += 1;
      evidence(`image ${url.pathname.split("/").pop()} #${imageCalls} model=${String(body.model ?? "?")} fail=${wantsFailure}`);
      if (wantsFailure) {
        return new Response(`data: ${JSON.stringify({ type: "error", error: { message: "fixture simulated provider failure" } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ data: [{ b64_json: fixturePngBase64 }] });
    }

    // --- video: submit / query / content, all through this boundary ---
    if (url.pathname.endsWith("/videos") && method === "POST") {
      const images = Array.isArray(body.images) ? body.images.map(value => String(value).split("/").pop()) : [];
      evidence(`video-submit images=[${images.join(",")}] seconds=${String(body.seconds)} resolution=${String(body.resolution)} model=${String(body.model)} prompt="${String(body.prompt ?? "").slice(0, 40)}" fail=${wantsFailure}`);
      const id = `video_fixture_${++videoSeq}`;
      videoJobs.set(id, wantsFailure ? -1 : Date.now());
      return Response.json({ id, status: wantsFailure ? "failed" : "queued", progress: 0 });
    }
    if (url.pathname.endsWith("/content")) {
      evidence(`video-content bytes=${fixtureVideo.byteLength}`);
      return new Response(new Uint8Array(fixtureVideo), { headers: { "content-type": "video/mp4", "content-length": String(fixtureVideo.byteLength) } });
    }
    if (/\/videos\/[^/]+$/.test(url.pathname) && method === "GET") {
      const id = url.pathname.split("/").pop()!;
      const startedAt = videoJobs.get(id);
      if (startedAt === -1) { evidence(`video-status ${id} failed`); return Response.json({ id, status: "failed", progress: 0 }); }
      const elapsed = Date.now() - (startedAt ?? Date.now());
      const state = elapsed < 1200 ? { status: "queued", progress: 0 } : elapsed < 3000 ? { status: "processing", progress: 60 } : { status: "completed", progress: 100 };
      evidence(`video-status ${id} ${state.status} ${state.progress}`);
      return Response.json({ id, ...state });
    }

    // --- text side ---
    // The product asks for a structured envelope through a deterministic
    // instruction block, not through a field the provider would see. Match those
    // blocks exactly so the real planner/parser code is what gets exercised.
    const bodyUsers = Array.isArray(body.input)
      ? (body.input as Array<{ role?: string; content?: string }>).filter(m => m?.role === "user")
      : Array.isArray(body.messages)
        ? (body.messages as Array<{ role?: string; content?: string }>).filter(m => m?.role === "user")
        : [];
    const lastUser = String(bodyUsers.at(-1)?.content ?? "");
    const failMark = /失败|模拟失败|fail/i.test(lastUser) ? "（模拟失败）" : "";
    if (instructions.includes("图片生成工具整理任务")) return jsonReply({ kind: "image", summary: "准备图片", prompt: `${IMAGE_PROMPT}${failMark}` });
    if (instructions.includes("视频生成工具整理任务")) return jsonReply({ kind: "video", summary: "准备视频", prompt: `${VIDEO_PROMPT}${failMark}` });
    if (instructions.includes("PPT 生成器整理任务")) return jsonReply({ kind: "presentation", summary: "准备演示文稿", prompt: "本周进度汇报" });
    if (instructions.includes("生成可编辑演示文稿的数据")) return jsonReply(fixtureSlides);
    if (instructions.includes("受限代理决策")) return jsonReply({ action: "complete", summary: "本地模拟：任务已完成。" });
    const request = { stream: Boolean(body.stream) };
    // The ordinary text send uses outputFormat "dispatch": the server parses a
    // <tool_request> envelope out of the body. Detect the member's last turn so
    // the real dispatch parser routes image/video/presentation correctly.
    const wantsPpt = /ppt|演示文稿|幻灯片|汇报材料/i.test(lastUser);
    const wantsVideo = /视频|影片|动起来|生成视频/i.test(lastUser);
    const wantsImage = /图片|图|画|海报|插画|照片|logo/i.test(lastUser);
    const wantsRich = /图表|chart|公式|数据可视化/i.test(lastUser);
    const answerText = wantsRich
      ? fixtureRichAnswer
      : wantsPpt
      ? `<tool_request>{"kind":"presentation","prompt":"本周进度汇报${failMark}"}</tool_request>`
      : wantsVideo
        ? `<tool_request>{"kind":"video","prompt":"让参考图片里的猫轻轻转头并眨眼${failMark}"}</tool_request>`
        : wantsImage
          ? `<tool_request>{"kind":"image","prompt":"一只橘色的猫坐在窗台上，柔和自然光${failMark}"}</tool_request>`
          : fixtureAnswer;
    const result = { status: "completed", output_text: answerText, usage: { input_tokens: 100, output_tokens: 80, total_tokens: 180 } };
    const encoder = new TextEncoder();
    const chunks = [answerText.slice(0, 33), answerText.slice(33, 67), answerText.slice(67)].filter(chunk => chunk);
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const [index, delta] of chunks.entries()) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: index, delta })}\n\n`));
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.completed", sequence_number: chunks.length, response: result })}\n\n`));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
  },
});
const now = new Date().toISOString();
const passwordHash = await bcrypt.hash("Fixture123!", 10);
const personas = new AiPersonaRepository(runtime.aiStore.sql);
const workspaces = new AiWorkspaceRepository(runtime.aiStore.sql);
for (const kind of ["locked", "setup", "ready", "long", "exhausted", "boss", "search"]) {
  const id = crypto.randomUUID();
  await runtime.store.mutate(db => { db.users.push({ id, email: `${kind}@tongpin.test`, name: `本地验收 · ${kind}`, passwordHash, role: kind === "boss" ? "boss" : "member", status: "active", jobTitle: "隔离测试账号", avatarSeed: 1, avatarVersion: 0, avatarDataUrl: null, emailVerifiedAt: now, lastLoginAt: null, createdAt: now, updatedAt: now }); });
  if (kind === "locked") continue;
  runtime.aiStore.saveQuota(id, { ...emptyQuota(), limitTokens: ["boss", "search"].includes(kind) ? 10000 : 100000, usedTokens: kind === "exhausted" ? 100000 : 0 });
  if (kind === "setup") continue;
  personas.save(id, { expectedRevision: 0, profile: { ...defaultAiPersonaProfile(), name: "小频", tone: "concise", preferences: "用中文，先给结论。", onboardingComplete: true } });
  if (kind === "long") {
    const conversationId = crypto.randomUUID();
    const state: AiWorkspaceState = { view: "chat", mode: "quick", projects: [], artifacts: [], drafts: {}, activeConversationId: conversationId, activeProjectId: null, enabledSkillIds: [], conversations: [{ id: conversationId, title: "长对话性能验收 · 160 条模拟消息", timeLabel: "今天", messages: Array.from({ length: 160 }, (_, index) => ({ id: crypto.randomUUID(), role: index % 2 ? "assistant" : "user", content: `第 ${index + 1} 条模拟记录。` + "这里是仅用于性能验收的长文本，不包含真实客户信息。".repeat(30), time: "10:00", status: "ready" })) }] };
    await workspaces.save(id, { expectedRevision: 0, mutationId: crypto.randomUUID(), state });
  }
}
await new Promise<void>(resolve => runtime.server.listen(config.port, config.host, resolve));
const adminResponse = await fetch(`${fixtureApi}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: config.bootstrapAdminEmail, password: "Fixture123!" }) });
const admin = await adminResponse.json() as { accessToken: string };
const adminPut = async (route: string, body: unknown) => {
  const response = await fetch(`${fixtureApi}/api/admin/ai/${route}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.accessToken}` }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Fixture ${route} setup failed: ${response.status} ${await response.text()}`);
  return response;
};
await adminPut("provider", { name: "本地模拟模型", baseUrl: "https://fixture.example.com/v1", protocol: "responses", apiKey: "fixture-key-not-a-real-secret", quickModel: "fixture-model", deepModel: "fixture-model", maxOutputTokens: 2048, reasoningEffort: "", enabled: true, webSearchEnabled: true, webSearchQuotaTokens: 100, imageModel: "fixture-image", imageQuotaTokens: 1000 });
await adminPut("video", { enabled: true, quotaPoints: 30, defaultModel: "minimax_h3", apiKey: "fixture-video-key-not-a-real-secret" });
// Video generation requires the model to be verified against the provider list.
const videoTest = await fetch(`${fixtureApi}/api/admin/ai/video/test`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.accessToken}` }, body: "{}" });
console.log("Video model verification:", videoTest.status, (await videoTest.text()).slice(0, 200));
console.log("Local UX fixture listening on", fixtureApi, "; isolated data:", directory);
console.log("Accounts: locked/setup/ready/long/exhausted/boss/search@tongpin.test; password: Fixture123!; text/image/video providers are simulated, no external calls.");
console.log(`Simulated assets: PNG ${fixturePngBase64.length} b64 chars; video ${fixtureVideo.byteLength} bytes; presentation ${fixtureSlides.slides.length} slides.`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void runtime.close().finally(() => process.exit(0)); });
