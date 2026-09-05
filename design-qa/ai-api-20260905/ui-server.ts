// Isolated browser QA only. Synthetic accounts and injected upstream; no real API key.
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { createRuntime } from "../../server/app";
import type { AppConfig } from "../../server/config";

const directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-ai-ui-qa-"));
const config: AppConfig = {
  host: "127.0.0.1", port: 4329, dataFile: path.join(directory, "qa.json"),
  jwtSecret: "tongpin-isolated-browser-qa-secret-not-production-20260905",
  clientOrigins: ["http://127.0.0.1:5189"],
  bootstrapAdminEmail: "admin@tongpin.test", bootstrapAdminPassword: "QaOnly20260905!", bootstrapAdminName: "AI 验收管理员",
  devEmailPreview: true, isProduction: false, loraExplorerApi: "https://unused.example.com", loraRpcUrl: "https://unused.example.com",
  resend: { apiKey: "", from: "" }, smtp: { host: "", port: 587, secure: false, user: "", pass: "", from: "" },
};
const runtime = await createRuntime(config, { attachSockets: false, startLoraCollector: false,
  aiTransport: async (url, init) => {
    if (init.headers.Authorization !== "Bearer sk-ui-qa-not-real") return Response.json({ error: "Invalid QA key" }, { status: 401 });
    if (init.method === "GET") return Response.json({ data: [{ id: "qa-fast" }, { id: "qa-deep" }, { id: "qa-image" }] });
    await new Promise(resolve => setTimeout(resolve, 1200));
    const body = JSON.parse(init.body ?? "{}");
    if (new URL(url).pathname.endsWith("/images/generations")) return Response.json({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2bAAAAABJRU5ErkJggg==" }] });
    const content = JSON.stringify(body).includes('slides') ? JSON.stringify({ title: "客户提案验收", subtitle: "隔离测试内容", slides: [
      { title: "同频 AI 客户提案", bullets: ["这是隔离验收数据", "验证可编辑文字与文件下载"], notes: "这不是实际模型生成。" },
      { title: "执行安排", bullets: ["整理客户目标", "明确负责人和交付日期"] },
      { title: "验收标准", bullets: ["项目与对话持久保存", "额度不足停止调用", "下载得到真实 PPTX 文件"] },
    ] }) : "这是隔离测试服务的回复。你好！当前对话已经过同频后端的账号验证和额度检查。\n\n这次记录输入 24 Token、输出 48 Token，共 72 Token。真实 API 接入后，这里会显示服务商实际返回的回答与用量。";
    return body.input ? Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: content }] }], usage: { input_tokens: 24, output_tokens: 48, total_tokens: 72 } })
      : Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 24, completion_tokens: 48, total_tokens: 72 } });
  },
});
const now = new Date().toISOString();
const passwordHash = await bcrypt.hash("QaOnly20260905!", 10);
await runtime.store.mutate(database => {
  database.users.push({ id: crypto.randomUUID(), email: "member@tongpin.test", name: "AI 验收成员", passwordHash,
    role: "member", status: "active", jobTitle: "测试", avatarSeed: 2, avatarVersion: 0, avatarDataUrl: null,
    emailVerifiedAt: now, lastLoginAt: null, createdAt: now, updatedAt: now });
});
runtime.server.listen(config.port, config.host, () => console.log("Isolated AI browser QA ready on 127.0.0.1:4329"));
process.on("SIGINT", () => { runtime.closeAi(); runtime.server.close(() => process.exit(0)); });
