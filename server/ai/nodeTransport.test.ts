import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { ClientRequest } from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeAi, nodeAiTransport } from "./node";

function resetConnection(reusedSocket: boolean, completedHandshake: boolean) {
  const request = Object.assign(new EventEmitter(), {
    reusedSocket,
    write: vi.fn(),
    end() {
      queueMicrotask(() => {
        const socket = new EventEmitter();
        request.emit("socket", socket);
        if (completedHandshake) socket.emit("secureConnect");
        request.emit("error", Object.assign(new Error("fixture reset"), { code: "ECONNRESET" }));
      });
    },
  });
  return vi.spyOn(https, "request").mockReturnValue(request as unknown as ClientRequest);
}

describe("Node AI transport paid-request uncertainty", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { label: "fresh connection before TLS", reused: false, handshake: false, unsent: true },
    { label: "fresh established TLS connection", reused: false, handshake: true, unsent: false },
    { label: "reused keep-alive connection without another handshake", reused: true, handshake: false, unsent: false },
  ])("classifies a reset on $label without retrying", async ({ reused, handshake, unsent }) => {
    const transport = resetConnection(reused, handshake);
    await expect(nodeAiTransport("https://api.example.com/v1/responses", {
      method: "POST", headers: { Authorization: "Bearer fixture-not-a-real-key" }, body: "{}", signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "AI_CONNECTION_FAILED", definitelyNotSent: unsent });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("records uncertain keep-alive generation once and does not refund or resend it on retry", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-ai-keepalive-"));
    const runtime = await createNodeAi(path.join(directory, "test.json"));
    try {
      await runtime.service.saveProvider({ name: "Fixture", baseUrl: "https://api.example.com", apiKey: "fixture-not-a-real-key", protocol: "responses", quickModel: "quick", deepModel: "deep", maxOutputTokens: 1024, reasoningEffort: "", enabled: true });
      runtime.service.setQuota("member", "admin", { limitTokens: 50_000 });
      const transport = resetConnection(true, false);
      const request = { requestId: crypto.randomUUID(), mode: "quick", messages: [{ role: "user", content: "你好" }] };
      await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ code: "AI_CONNECTION_FAILED" });
      const first = runtime.service.quota("member");
      expect(first.usedTokens).toBeGreaterThan(0);
      expect(first.reservedTokens).toBe(0);
      await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ code: "AI_CONNECTION_FAILED" });
      expect(runtime.service.quota("member")).toEqual(first);
      expect(runtime.store.usage("member").filter(entry => entry.kind === "chat")).toMatchObject([{ status: "uncertain", estimated: true }]);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      runtime.close();
      await rm(directory, { recursive: true });
    }
  });
});
