/** Own disposable loopback server + browser. Never uses production accounts, API keys or transport. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import bcrypt from "bcryptjs";
import { createRuntime } from "../server/app";
import { AiPersonaRepository } from "../server/ai/persona";
import { AiWorkspaceRepository } from "../server/ai/workspace";
import { emptyQuota } from "../server/ai/storage";
import { defaultAiPersonaProfile } from "../shared/aiPersona";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/sam/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const root = path.resolve(import.meta.dirname, "..");
const origin = "http://127.0.0.1:5176";
const out = process.env.TONGPIN_MEDIA_QA_OUT || path.resolve(root, "../tongpin-release-downloads/qa-media-20260908");
const directory = await mkdtemp(path.join(tmpdir(), "tongpin-media-qa-"));
await mkdir(out, { recursive: true });
const image = path.join(directory, "image.png"), video = path.join(directory, "video.mp4");
await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=640x480:d=1", "-vf", "drawbox=x=40:y=40:w=180:h=180:c=red:t=fill,drawbox=x=340:y=260:w=220:h=140:c=blue:t=fill", "-frames:v", "1", image]);
await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=640x480:r=10:d=2", "-f", "lavfi", "-i", "color=c=blue:s=640x480:r=10:d=2", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video]);
const report: any = { startedAt: new Date().toISOString(), localOnly: true, providerIsSimulated: true, checks: [], errors: [], blocked: [], directory, screenshots: [] };
const providerRequests: any[] = [];
const runtime = await createRuntime({ host: "127.0.0.1", port: 0, dataFile: path.join(directory, "fixture.json"), jwtSecret: crypto.randomUUID() + crypto.randomUUID(), clientOrigins: [origin],
  bootstrapAdminEmail: "admin@media.test", bootstrapAdminPassword: "MediaFixture123!", bootstrapAdminName: "媒体隔离验收管理员", devEmailPreview: true, isProduction: false,
  loraExplorerApi: "", loraRpcUrl: "", resend: { apiKey: "", from: "" }, smtp: { host: "", port: 587, secure: false, user: "", pass: "", from: "" },
}, { startLoraCollector: false, aiTransport: async (_url, init) => {
  const body = JSON.parse(String(init.body)); providerRequests.push(body);
  const frameCount = body.input?.at(-1)?.content?.filter((part: any) => part.type === "input_image").length || 0;
  return Response.json({ status: "completed", output_text: `【隔离模拟验收】已收到 ${frameCount} 张视觉帧。本回复只验证传输，不证明真实模型的识别准确性。`, usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } });
} });
let browser: any, vite: any;
try {
  const now = new Date().toISOString(), passwordHash = await bcrypt.hash("MediaFixture123!", 10), userId = crypto.randomUUID();
  await runtime.store.mutate(db => { db.users.push({ id: userId, email: "member@media.test", name: "媒体隔离验收", passwordHash, role: "member", status: "active", jobTitle: "测试", avatarSeed: 1, avatarVersion: 0, avatarDataUrl: null, emailVerifiedAt: now, lastLoginAt: null, createdAt: now, updatedAt: now }); });
  runtime.aiStore.saveQuota(userId, { ...emptyQuota(), limitTokens: 100000 });
  new AiPersonaRepository(runtime.aiStore.sql).save(userId, { expectedRevision: 0, profile: { ...defaultAiPersonaProfile(), name: "媒体测试 AI", onboardingComplete: true } });
  await new Promise<void>(resolve => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address(); assert.ok(address && typeof address !== "string");
  const api = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${api}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@media.test", password: "MediaFixture123!" }) });
  assert.equal(login.status, 200); const admin = await login.json() as { accessToken: string };
  const config = await fetch(`${api}/api/admin/ai/provider`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.accessToken}` }, body: JSON.stringify({ name: "隔离模拟模型", baseUrl: "https://fixture.example.com/v1", protocol: "responses", apiKey: "fixture-not-real", quickModel: "fixture-vision", deepModel: "fixture-vision", maxOutputTokens: 512, reasoningEffort: "", enabled: true, visionEnabled: true }) });
  assert.equal(config.status, 200);
  process.env.VITE_API_URL = api;
  vite = await (await import("vite")).createServer({ root, server: { host: "127.0.0.1", port: 5176, strictPort: true }, clearScreen: false, logLevel: "error" });
  await vite.listen();
  browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1203, height: 769 } });
  await context.route("**/*", async (route: any) => {
    const url = new URL(route.request().url());
    if ([new URL(origin).host, new URL(api).host].includes(url.host) || ["blob:", "data:"].includes(url.protocol)) { await route.continue(); return; }
    report.blocked.push(url.origin); await route.abort("blockedbyclient");
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on("pageerror", (error: Error) => report.errors.push(error.message));
  let lastSavedState: any = null;
  page.on("response", async (response: any) => {
    if (new URL(response.url()).pathname === "/api/ai/workspace" && response.request().method() === "PUT" && response.ok()) lastSavedState = (await response.json()).state;
  });
  async function waitSaved(predicate: (state: any) => boolean) {
    const deadline = Date.now() + 12000;
    while (!predicate(lastSavedState)) { if (Date.now() >= deadline) throw new Error("Expected durable workspace save did not arrive"); await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  async function reloadAi() { await page.reload(); await page.getByRole("button", { name: "同频 AI", exact: true }).click(); }
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  assert.ok((await page.locator("body").innerText()).trim());
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  await page.getByRole("textbox", { name: "邮箱", exact: true }).fill("member@media.test");
  await page.locator('input[type="password"]').fill("MediaFixture123!");
  await page.getByRole("button", { name: "登录同频", exact: true }).click();
  await page.getByRole("button", { name: "同频 AI", exact: true }).click();
  await page.getByRole("button", { name: "添加附件或生成内容" }).click();
  assert.equal(await page.getByRole("menuitem", { name: "上传图片" }).isEnabled(), true);
  assert.equal(await page.getByRole("menuitem", { name: "上传视频" }).isEnabled(), true);
  await page.keyboard.press("Escape");
  await page.locator('input[aria-label="选择图片"]').setInputFiles(image);
  await page.locator(".tp-ai-file-thumbnail").waitFor();
  assert.equal(await page.getByRole("button", { name: "发送消息", exact: true }).isEnabled(), true, "Attachments alone can send");
  await waitSaved(state => state?.draftAttachments?.["new-conversation"]?.[0]?.media?.kind === "image");
  await reloadAi();
  await page.locator(".tp-ai-file-thumbnail").waitFor();
  report.checks.push({ name: "image-upload-preview-draft-reload", passed: true });
  await page.getByRole("textbox", { name: "输入你的任务", exact: true }).fill("描述附件中的颜色和形状。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("已收到 1 张视觉帧"));
  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].input.at(-1).content.filter((part: any) => part.type === "input_image").length, 1);
  await waitSaved(state => state?.conversations?.[0]?.messages?.some((message: any) => message.role === "assistant" && message.content.includes("已收到 1 张视觉帧")));
  await reloadAi(); await page.locator(".tp-ai-message-frames img").waitFor();
  report.checks.push({ name: "image-provider-contract-and-message-reload", passed: true });
  await page.getByRole("textbox", { name: "输入你的任务", exact: true }).fill("继续分析刚才上传的图片。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".tp-ai-message.is-assistant").length === 2 && document.body.innerText.includes("已收到 1 张视觉帧"));
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  assert.equal(providerRequests.length, 2); assert.equal(providerRequests[1].input.at(-1).content.filter((part: any) => part.type === "input_image").length, 1);
  report.checks.push({ name: "image-follow-up-retains-visual-input", passed: true });
  await page.locator('input[aria-label="选择视频"]').setInputFiles(video);
  await page.getByText("2 个采样画面 · 不含音频", { exact: true }).waitFor();
  const firstFrameColor = await page.locator('.tp-ai-file-thumbnail').evaluate(async (element: HTMLImageElement) => {
    await element.decode(); const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!; context.drawImage(element, 0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data];
  });
  assert.ok(firstFrameColor[0] > 220 && firstFrameColor[1] < 30 && firstFrameColor[2] < 30, `First video frame must be red, not an undecoded blank: ${firstFrameColor}`);
  await page.getByRole("textbox", { name: "输入你的任务", exact: true }).fill("按时间顺序描述这个视频的采样画面。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("已收到 3 张视觉帧"));
  assert.equal(providerRequests.length, 3);
  const parts = providerRequests[2].input.at(-1).content;
  assert.equal(parts.filter((part: any) => part.type === "input_image").length, 3);
  assert.match(parts[0].text, /0\.00 秒/); assert.match(parts[0].text, /3\.95 秒/); assert.match(parts[0].text, /不包含音频/);
  await waitSaved(state => state?.conversations?.[0]?.messages?.some((message: any) => message.role === "assistant" && message.content.includes("已收到 3 张视觉帧")));
  await reloadAi(); await page.getByText("仅分析采样画面，不含音频", { exact: true }).waitFor();
  assert.equal(await page.locator(".tp-ai-message-frames img").count(), 3);
  const frameColors = await page.locator(".tp-ai-message-attachment-media").last().locator("img").evaluateAll(async (elements: HTMLImageElement[]) => {
    return Promise.all(elements.map(async image => { await image.decode(); const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1; const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; }));
  });
  assert.ok(frameColors[0][0] > 220 && frameColors[0][2] < 30); assert.ok(frameColors[1][2] > 220 && frameColors[1][0] < 30);
  report.videoFrameColors = frameColors;
  report.checks.push({ name: "video-decode-sampling-timestamps-contract-and-reload", passed: true });
  const screenshot = path.join(out, "media-message-frames.png"); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
  // Direct decoder cancellation uses the same lazy module as the picker and cannot call a provider.
  const videoBase64 = (await readFile(video)).toString("base64");
  const cancellation = await page.evaluate(async (base64: string) => {
    const urlModule = "/src/features/tongpin-ai/attachments.ts";
    const { extractAttachment } = await import(/* @vite-ignore */ urlModule);
    const bytes = Uint8Array.from(atob(base64), letter => letter.charCodeAt(0));
    const controller = new AbortController();
    const pending = extractAttachment(new File([bytes], "cancel.mp4", { type: "video/mp4" }), { signal: controller.signal });
    controller.abort();
    try { await pending; return false; } catch (error: any) { return error.name === "AbortError"; }
  }, videoBase64);
  assert.equal(cancellation, true); assert.equal(providerRequests.length, 3);
  report.checks.push({ name: "media-cancel-no-provider-call", passed: true });
  assert.equal(await page.locator(".tp-ai-sync-error").count(), 0);
  const latest = runtime.aiStore.quota(userId); report.quota = latest;
  assert.equal(latest.reservedTokens, 0); assert.equal(latest.usedTokens, 450);
  report.checks.push({ name: "real-local-ledger-settles-only-provider-reported-tokens", passed: true });
  // Seed only this disposable member with legal old history outside the active chat.
  await page.goto("about:blank");
  const repository = new AiWorkspaceRepository(runtime.aiStore.sql);
  const snapshot = repository.read(userId); assert.ok(snapshot.state);
  await repository.save(userId, { expectedRevision: snapshot.revision, mutationId: crypto.randomUUID(), state: {
    ...snapshot.state,
    conversations: [...snapshot.state.conversations, { id: "capacity-fixture-history", title: "容量保护历史测试", timeLabel: "昨天", messages: Array.from({ length: 12 }, (_, index) => ({ id: `capacity-message-${index}`, role: "assistant", content: "x".repeat(100000), time: "10:00", status: "ready" })) }],
  } });
  await page.goto(origin); await page.getByRole("button", { name: "同频 AI", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "输入你的任务", exact: true });
  await draft.fill("容量保护测试草稿");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const notice = page.locator(".tp-ai-capacity-notice"); await notice.waitFor();
  await page.waitForTimeout(5000); assert.equal(await notice.isVisible(), true, "Capacity notice must outlive ordinary toast expiry");
  assert.equal(await draft.inputValue(), "容量保护测试草稿");
  assert.equal(providerRequests.length, 3); assert.equal(runtime.aiStore.quota(userId).usedTokens, 450);
  const downloadEvent = page.waitForEvent("download"); await notice.getByRole("button", { name: "导出当前内容" }).click();
  const download = await downloadEvent, exported = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.ok(Object.values(exported.drafts).includes("容量保护测试草稿"));
  assert.ok(exported.conversations.some((conversation: any) => conversation.id === "capacity-fixture-history"));
  await notice.getByRole("button", { name: "关闭存储空间提示" }).click(); assert.equal(await notice.count(), 0);
  await page.getByRole("button", { name: "发送消息", exact: true }).click(); await notice.waitFor();
  await page.getByRole("button", { name: "打开“容量保护历史测试”对话菜单", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除对话", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await waitSaved(state => state && !state.conversations.some((conversation: any) => conversation.id === "capacity-fixture-history"));
  await page.locator('input[aria-label="选择图片"]').setInputFiles(image);
  await page.locator(".tp-ai-file-thumbnail").waitFor();
  assert.equal(await notice.count(), 0, "Next successful capacity check clears the notice");
  assert.equal(await draft.inputValue(), "容量保护测试草稿");
  assert.equal(providerRequests.length, 3); assert.equal(runtime.aiStore.quota(userId).usedTokens, 450);
  report.checks.push({ name: "capacity-notice-export-dismiss-retry-and-clear-without-paid-request", passed: true });
  report.passed = report.checks.length === 7 && !report.errors.length && !report.blocked.length;
} catch (error: any) {
  report.passed = false; report.failure = error.stack || error.message;
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) { report.failureText = (await page.locator("body").innerText()).slice(-4000); await page.screenshot({ path: path.join(out, "media-failure.png") }); }
}
finally {
  await browser?.close(); await vite?.close(); await runtime.close();
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(out, "media-summary.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1;
}
