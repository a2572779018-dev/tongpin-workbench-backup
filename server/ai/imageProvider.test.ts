import { describe, expect, it } from "vitest";
import { readImageProviderResponse } from "./imageProvider";
import { AiError } from "./security";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const event = (type: string, fields: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const complete = event("image_generation.completed", { b64_json: PNG });
const response = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream; charset=utf-8" } });

describe("Bounded standard Images JSON/SSE parsing", () => {
  it("keeps the complete JSON contract", async () => {
    expect(await readImageProviderResponse(Response.json({ data: [{ b64_json: PNG }] }))).toEqual({ data: [{ b64_json: PNG }] });
  });
  it.each([complete, `: heartbeat\n\n${complete}data: [DONE]\n\n`, complete.replace(/\n/g, "\r\n"), complete.trimEnd()])("accepts exactly one explicit completed image and harmless framing", async value => {
    expect(await readImageProviderResponse(response(value))).toEqual({ data: [{ b64_json: PNG }] });
  });
  it("detects SSE with a generic content type and handles network chunk splits", async () => {
    const bytes = new TextEncoder().encode(complete);
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } });
    expect(await readImageProviderResponse(new Response(body))).toEqual({ data: [{ b64_json: PNG }] });
  });
  it("never delivers a partial preview as final, but accepts a later completed image", async () => {
    const partial = event("image_generation.partial_image", { partial_image_index: 0, b64_json: "not-a-final-image" });
    expect(await readImageProviderResponse(response(partial + complete))).toEqual({ data: [{ b64_json: PNG }] });
    await expect(readImageProviderResponse(response(partial + "data: [DONE]\n\n"))).rejects.toMatchObject({ code: "AI_IMAGE_STREAM_INTERRUPTED" });
  });
  it.each(["data: [DONE]\n\n", ": heartbeat\n\n", 'data: {"data":[{"b64_json":"unknown-legacy-event"}]}\n\n'])("requires a real completed terminal event", async text => {
    await expect(readImageProviderResponse(response(text))).rejects.toMatchObject({ code: "AI_IMAGE_STREAM_INTERRUPTED" });
  });
  it.each([complete + complete, event("image_generation.completed", { url: "https://example.com/private" }), 'event: image_generation.completed\ndata: {"type":"image_generation.partial_image","b64_json":"x"}\n\n', 'data: {broken\n\n'])("rejects duplicates, URL-only finals, mismatched types and broken JSON", async text => {
    await expect(readImageProviderResponse(response(text))).rejects.toMatchObject({ code: "AI_IMAGE_STREAM_INVALID" });
  });
  it.each([event("error", { message: "private-api-key" }), complete + event("image_generation.failed", { error: { message: "private-api-key" } })])("fails closed on provider stream errors even after a completed event without echoing body", async text => {
    const error = await readImageProviderResponse(response(text)).catch(error => error);
    expect(error).toBeInstanceOf(AiError);
    if (!(error instanceof AiError)) throw new Error("Expected safe image stream error");
    expect(error.code).toBe("AI_IMAGE_STREAM_FAILED");
    expect(error.message).not.toContain("private-api-key");
  });
  it("bounds all stream bytes, including comments and previews", async () => {
    await expect(readImageProviderResponse(response(`:${"x".repeat(6_000_001)}\n\n${complete}`))).rejects.toMatchObject({ code: "AI_PROVIDER_RESPONSE" });
  });
});
