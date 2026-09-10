/** One explicitly authorized 15-second acceptance job; never automatically resubmit. */
import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { nodeAiTransport } from "../server/ai/node";
import { h3VideoContentUrl, queryH3Video, submitH3Video } from "../server/ai/videoProvider";
import { AiError } from "../server/ai/security";
import { readBoundedJson } from "../server/ai/provider";

const dir = path.resolve("artifacts/h3-acceptance-20260910");
const marker = path.join(dir, "submission.json");
const baseUrl = "https://www.75api.com/v1";
const key = execFileSync("pbpaste", { encoding: "utf8" }).trim();
if (!/^sk-[A-Za-z0-9_-]{20,200}$/.test(key)) throw new Error("Clipboard has no valid token; no request sent");
execFileSync("pbcopy", { input: "" });
await mkdir(dir, { recursive: true, mode: 0o700 });
let evidence: Record<string, unknown> = {};
const save = async () => { await writeFile(marker, JSON.stringify(evidence, null, 2), { mode: 0o600 }); };
const connection = { baseUrl, apiKey: key };
try {
  let job;
  if (process.argv.includes("--resume")) {
    evidence = JSON.parse(await readFile(marker, "utf8"));
    const id = String(evidence.providerId ?? "");
    if (!/^task_[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error("No safe task ID to resume; do not submit again");
    job = await queryH3Video(nodeAiTransport, connection, id);
  } else {
    const models = await nodeAiTransport(`${baseUrl}/models`, { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(20000), maxResponseBytes: 512000 });
    if (!models.ok) throw new Error(`Read-only model test failed: HTTP ${models.status}; no generation submitted`);
    const catalog = await readBoundedJson(models, 512000) as { data?: Array<{ id?: string }> };
    if (!catalog.data?.some(m => m.id === "minimax_h3")) throw new Error("H3 not in authorized model list; no generation submitted");
    console.log("H3 model permission verified; preparing the single authorized submission.");
    const lock = await open(marker, "wx", 0o600);
    evidence = { startedAt: new Date().toISOString(), authorizedVideos: 1, duration: 15, phase: "submission_started", model: "minimax_h3", resolution: "768p", aspectRatio: "16:9" };
    await lock.writeFile(JSON.stringify(evidence, null, 2)); await lock.close();
    job = await submitH3Video(async (url, init) => {
      const response = await nodeAiTransport(url, init);
      evidence.submitHttpStatus = response.status;
      if (response.ok) {
        const json = await readBoundedJson(response, 32768) as Record<string, unknown>;
        const id = json.id ?? json.task_id;
        if (typeof id === "string" && /^task_[A-Za-z0-9_-]{8,128}$/.test(id)) evidence.providerId = id;
        evidence.responseFields = Object.keys(json).filter(k => /^[a-z_]{1,40}$/i.test(k));
        evidence.providerStatus = typeof json.status === "string" ? json.status.slice(0,40) : null;
        evidence.providerProgress = typeof json.progress === "number" ? json.progress : null;
        await save();
        return Response.json(json);
      }
      await save(); return response;
    }, connection, { prompt: "一只橘猫坐在温暖的窗台上，清晨阳光穿过白色薄纱窗帘，猫缓慢眨眼并轻轻转头。镜头平稳缓慢推进，真实摄影风格，柔和自然光，画面干净，无文字、无标志、无水印。", seconds: 15, resolution: "768p", aspectRatio: "16:9" });
  }
  evidence.providerId = job.id;
  for (let i = 0; i < 45; i++) {
    evidence.phase = job.status; evidence.progress = job.progress; evidence.checkedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({ taskId: job.id, status: job.status, progress: job.progress }));
    if (job.status === "completed" || job.status === "failed") break;
    await new Promise(resolve => setTimeout(resolve, 20000));
    job = await queryH3Video(nodeAiTransport, connection, job.id);
  }
  if (job.status !== "completed") { console.log("No completed video yet. Only GET resume is allowed; do not resubmit."); process.exitCode = 2; }
  else {
    const response = await nodeAiTransport(h3VideoContentUrl(baseUrl, job.id), { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "video/mp4" }, signal: AbortSignal.timeout(120000), maxResponseBytes: 64 * 1024 * 1024 });
    if (!response.ok || !response.body || !/^video\/mp4(?:;|$)/i.test(response.headers.get("content-type") ?? "")) { await response.body?.cancel(); throw new Error(`Video download not ready: HTTP ${response.status}`); }
    const output = path.join(dir, "tongpin-h3-15s.mp4");
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(output, { flags: "wx", mode: 0o600 }));
    evidence.file = output; evidence.phase = "downloaded"; await save(); console.log(JSON.stringify({ downloaded: output }));
  }
} catch (error) {
  const safe = error instanceof AiError ? { code: error.code, message: error.message, diagnostic: error.diagnostic } : { message: String(error instanceof Error ? error.message : "Acceptance failed").replaceAll(key, "[redacted]") };
  console.log(JSON.stringify({ error: safe, resubmit: false }));
  if (evidence.startedAt) { evidence.error = safe; await save(); }
  process.exitCode = 1;
}
