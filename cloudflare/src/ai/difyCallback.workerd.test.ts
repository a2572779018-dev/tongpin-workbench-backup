import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Dify callback through the bundled Worker and SQLite Durable Object", () => {
  let directory: string;
  let mf: Miniflare;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-dify-worker-"));
    const bundled = await build({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, format: "esm", write: false, platform: "browser", target: "es2022", external: ["cloudflare:*", "node:*"] });
    mf = new Miniflare({ ...convertV4MiniflareOptions({
      name: "tongpin-dify-worker-fixture", modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
      resourcePersistencePath: directory,
      bindings: { JWT_SECRET: "dify-worker-fixture-secret-".repeat(4), BOOTSTRAP_ADMIN_EMAIL: "admin@fixture.local", DEV_EMAIL_PREVIEW: "true", CLIENT_ORIGINS: "http://tongpin-fixture.local", AI_ALLOWED_HOSTS: "provider.example.com", LORA_EXPLORER_API: "https://unused.example.com", LORA_RPC_URL: "https://unused.example.com" },
      log: new Log(LogLevel.ERROR),
    }), unsafeInspectDurableObjects: true });
    await mf.ready;
  }, 30_000);
  afterAll(async () => { if (mf) await mf.dispose(); if (directory) await rm(directory, { recursive: true }); });

  it("routes capability callbacks without a browser session and bounds their body before Durable Object parsing", async () => {
    const callback = "http://tongpin-fixture.local/api/dify/tools/invoke";
    const missing = await mf.dispatchFetch(callback, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { code: "DIFY_TOOL_AUTH_INVALID" } });
    const tooLarge = await mf.dispatchFetch(callback, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(17_000) }) });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  }, 30_000);
});
