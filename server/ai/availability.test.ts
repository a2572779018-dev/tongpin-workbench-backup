import { afterEach, describe, expect, it, vi } from "vitest";
import { AvailabilityProbe } from "./availability";
import { createSecretBox } from "./security";
import type { AiTransport } from "./provider";

describe("non-generating service availability", () => {
  afterEach(() => vi.useRealTimers());
  async function fixture(transport: AiTransport) {
    const box = await createSecretBox("availability-test-secret-long-enough");
    const encrypted = await box.encrypt("fixture-secret-never-disclose");
    const probe = new AvailabilityProbe(transport, async () => box);
    return () => probe.check("chat", "https://provider.example/v1", encrypted);
  }
  it.each([404, 405, 501])("marks unsupported probe %s as unverified, not a regional restriction", async status => {
    const check = await fixture(async () => new Response("unsupported", { status }));
    expect(await check()).toMatchObject({ state: "unverified", code: "AI_PROBE_UNSUPPORTED" });
  });
  it("preserves gateway blocking separately from invalid credentials without leaking provider HTML", async () => {
    const check = await fixture(async () => new Response('<html><div id="cf-error-details">Sorry, you have been blocked fixture-secret-never-disclose</div></html>', { status: 403, headers: { "content-type": "text/html", server: "cloudflare" } }));
    const response = await check();
    expect(response).toMatchObject({ state: "unavailable", code: "AI_PROVIDER_GATEWAY_BLOCK" });
    expect(JSON.stringify(response)).not.toContain("fixture-secret");
    expect(JSON.stringify(response)).not.toContain("<html>");
  });
  it.each([401, 429, 503])("reports explicit connection failure %s without generating", async status => {
    const transport = vi.fn<AiTransport>().mockImplementation(async () => new Response("failure", { status }));
    const check = await fixture(transport);
    expect((await check()).state).toBe("unavailable");
    expect(transport.mock.calls.every(([, init]) => init.method === "GET" && !init.body)).toBe(true);
  });
  it("does not call malformed model output verified inference", async () => {
    const check = await fixture(async () => Response.json({ hello: "world" }));
    expect((await check()).state).toBe("unverified");
  });
  it("sanitizes network and decryption errors", async () => {
    const check = await fixture(async () => { throw new Error("fixture-secret-never-disclose"); });
    const response = await check();
    expect(response.code).toBe("AI_CONNECTION_FAILED");
    expect(JSON.stringify(response)).not.toContain("fixture-secret");
  });
  it("coalesces concurrent probes and expires both positive and negative cached results", async () => {
    const transport = vi.fn<AiTransport>().mockImplementation(async () => new Response("failure", { status: 503 }));
    const check = await fixture(transport);
    vi.useFakeTimers();
    await Promise.all([check(), check(), check()]);
    await check(); expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_001);
    transport.mockImplementation(async () => Response.json({ data: [] }));
    expect((await check()).state).toBe("reachable"); expect(transport).toHaveBeenCalledTimes(2);
    await check(); expect(transport).toHaveBeenCalledTimes(2);
  });
});
