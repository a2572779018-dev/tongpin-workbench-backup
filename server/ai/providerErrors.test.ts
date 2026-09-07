import { describe, expect, it } from "vitest";
import { isProviderRejection, providerHttpError, readProviderHttpError } from "./provider";

describe("Safe upstream HTTP diagnostics", () => {
  it.each([400, 401, 403, 404, 405, 413, 415, 422, 429, 302])("classifies explicit HTTP %i refusal without exposing the upstream body", async status => {
    const error = await readProviderHttpError(Response.json({ error: { code: "model_not_found", param: "model", message: "Bearer test-private-key prompt-secret" }, prompt: "prompt-secret" }, { status }), "image");
    expect(error.diagnostic).toMatchObject({ operation: "image", httpStatus: status, billing: "rejected", code: "model_not_found", param: "model" });
    expect(isProviderRejection(status)).toBe(true);
    expect(JSON.stringify(error)).not.toMatch(/test-private-key|prompt-secret/);
    expect(error.message).toContain(`HTTP ${status}`);
  });
  it.each([408, 409, 425, 500, 502, 503, 504, 524])("keeps HTTP %i billing uncertain even if an error body claims otherwise", async status => {
    const error = await readProviderHttpError(Response.json({ error: { code: "model_not_found", param: "model", message: "no charge, refund now" } }, { status }), "image");
    expect(error.diagnostic).toMatchObject({ httpStatus: status, billing: "unknown" });
    expect(isProviderRejection(status)).toBe(false);
    if (status >= 500) expect(error.code).toBe("AI_PROVIDER_UNAVAILABLE");
  });
  it("rejects arbitrary strings even when they resemble harmless error identifiers", async () => {
    const error = await readProviderHttpError(Response.json({ error: { code: "private_customer_name", param: "sk_test_private_key", type: "secret", message: "secret" } }, { status: 400 }), "image");
    expect(error.diagnostic).toEqual({ operation: "image", httpStatus: 400, category: "invalid_request", billing: "rejected" });
    expect(JSON.stringify(error)).not.toMatch(/customer|sk_test|secret/);
    expect(providerHttpError(400, "image", { code: "key_should_not_leak", param: "prompt_should_not_leak" }).diagnostic).not.toHaveProperty("code");
  });
  it("does not describe a model-list GET failure as a paid generation", () => {
    const error = providerHttpError(503, "models");
    expect(error.message).toContain("本次测试未发起生成");
    expect(error.message).not.toContain("用量待核对");
  });
  it.each(["<html>private proxy error</html>", JSON.stringify({ error: { message: "x".repeat(17_000), code: "model_not_found" } })])("retains HTTP status with invalid or oversized error responses", async body => {
    const error = await readProviderHttpError(new Response(body, { status: 502 }), "image");
    expect(error).toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", diagnostic: { httpStatus: 502, billing: "unknown" } });
    expect(error.diagnostic).not.toHaveProperty("code");
  });
  it("retains a received status if reading or cancelling the error body fails", async () => {
    const response = new Response(new ReadableStream({ pull(controller) { controller.error(new Error("secret-network-error")); } }), { status: 403 });
    const error = await readProviderHttpError(response, "models");
    expect(error).toMatchObject({ code: "AI_PROVIDER_AUTH", diagnostic: { httpStatus: 403, operation: "models" } });
    expect(error.message).not.toContain("secret-network-error");
  });
});
