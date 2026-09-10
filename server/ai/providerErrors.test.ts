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
    expect(error.diagnostic).toEqual({ operation: "image", httpStatus: 400, category: "invalid_request", billing: "rejected", responseKind: "json" });
    expect(JSON.stringify(error)).not.toMatch(/customer|sk_test|secret/);
    expect(providerHttpError(400, "image", { code: "key_should_not_leak", param: "prompt_should_not_leak" }).diagnostic).not.toHaveProperty("code");
  });
  it.each(["max_tool_calls", "tool_choice", "include", "search_context_size", "store"])("retains the fixed Responses compatibility parameter %s", async param => {
    const error = await readProviderHttpError(Response.json({ error: { code: null, type: "invalid_request_error", param, message: "private request text" } }, { status: 400 }), "chat");
    expect(error.diagnostic).toMatchObject({ code: "invalid_request_error", param, billing: "rejected" });
    expect(error.message).toContain(`参数 ${param}`);
    expect(JSON.stringify(error)).not.toContain("private request text");
  });
  it("recognizes the observed gateway's exact unsupported-parameter message without echoing message text", async () => {
    const error = await readProviderHttpError(Response.json({ error: { message: "Unsupported parameter: max_tool_calls" } }, { status: 400 }), "chat");
    expect(error.diagnostic).toMatchObject({ code: "unsupported_parameter", param: "max_tool_calls", billing: "rejected" });
    expect(error.message).toContain("参数 max_tool_calls");
    expect(error.message).not.toContain("Unsupported parameter:");
  });
  it("distinguishes the observed unavailable image channel while keeping billing uncertain", async () => {
    const error = await readProviderHttpError(Response.json({ error: { message: "No available compatible accounts" } }, { status: 503 }), "image");
    expect(error.diagnostic).toMatchObject({ httpStatus: 503, code: "no_available_compatible_accounts", billing: "unknown" });
    expect(error.message).toContain("暂无可用兼容通道");
    expect(error.message).not.toContain("请管理员检查对应 API 地址");
    const arbitrary = await readProviderHttpError(Response.json({ error: { message: "No available compatible accounts for private-key" } }, { status: 503 }), "image");
    expect(arbitrary.diagnostic).not.toHaveProperty("code");
  });
  it.each(["Unsupported parameter: private_api_key", "Unsupported parameter: max_tool_calls\nprivate prompt", "Unsupported parameter: max_tool_calls private-key", "Private prompt: Unsupported parameter: max_tool_calls"])("does not extract arbitrary or trailing message content: %s", async message => {
    const error = await readProviderHttpError(Response.json({ error: { message } }, { status: 400 }), "chat");
    expect(error.diagnostic).not.toHaveProperty("param");
    expect(error.diagnostic).not.toHaveProperty("code");
    expect(error.message).not.toContain("private");
  });
  it.each(["tools[0].type", "tools.1.type", "tools[0].search_context_size", "tools[0].external_web_access"])("normalizes a known nested search field without retaining the original path: %s", async param => {
    const error = await readProviderHttpError(Response.json({ error: { code: "unsupported_parameter", param } }, { status: 400 }), "chat");
    expect(error.diagnostic?.param).toBe(`tools[].${param.slice(param.lastIndexOf(".") + 1)}`);
  });
  it.each(["tools[private-api-key].type", "tools[0].private-prompt", "tools[1234].type", "tool_choice.private-key"])("does not expose unrecognized nested error path %s", async param => {
    const error = await readProviderHttpError(Response.json({ error: { type: "private-secret-type", param } }, { status: 400 }), "chat");
    expect(error.diagnostic).not.toHaveProperty("param");
    expect(error.diagnostic).not.toHaveProperty("code");
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
    expect(error).toMatchObject({ code: "AI_PROVIDER_ACCESS_DENIED", diagnostic: { httpStatus: 403, operation: "models", responseKind: "unknown" } });
    expect(error.message).not.toContain("secret-network-error");
  });
  it.each(["invalid_api_key", "permission_denied", "model_not_found", "model_not_supported", "invalid_request_error"])("distinguishes a known JSON 403 code: %s", async code => {
    const error = await readProviderHttpError(Response.json({ error: { code, message: "private-key" } }, { status: 403 }), "chat");
    const category = code === "invalid_api_key" ? "authentication" : code === "invalid_request_error" ? "access_denied" : "permission";
    expect(error.diagnostic).toMatchObject({ category, code, responseKind: "json", billing: "rejected" });
    expect(JSON.stringify(error)).not.toContain("private-key");
  });
  it("does not infer a security block from a CDN Ray ID or generic HTML alone", async () => {
    for (const body of ["<html>Access denied</html>", JSON.stringify({ error: { message: "private-key" } })]) {
      const error = await readProviderHttpError(new Response(body, { status: 403, headers: { "cf-ray": "a37be7f308e2b9b6-HKG", server: "cloudflare" } }), "chat");
      expect(error.diagnostic).toMatchObject({ category: "access_denied", cfRay: "a37be7f308e2b9b6-HKG" });
      expect(error.diagnostic).not.toHaveProperty("gatewaySignal");
      expect(error.message).toContain("尚不能确定");
    }
  });
  it.each([403, 503])("recognizes a Cloudflare block template at %i without changing billing", async status => {
    const body = '<!DOCTYPE html><html><div id="cf-error-details">Sorry, you have been blocked. Cloudflare Ray ID private-customer-IP private-key</div></html>';
    const error = await readProviderHttpError(new Response(body, { status, headers: { "cf-ray": "a37be7f308e2b9b6" } }), "chat");
    expect(error.diagnostic).toMatchObject({ category: status === 403 ? "gateway_block" : "upstream_unavailable", responseKind: "html", gatewaySignal: "cloudflare_block_page", billing: status === 403 ? "rejected" : "unknown" });
    expect(JSON.stringify(error)).not.toMatch(/private-customer|private-key|cf-error-details/);
  });
  it("retains the official challenge signal even when the body exceeds the read cap", async () => {
    const error = await readProviderHttpError(new Response("x".repeat(17000), { status: 403, headers: { "cf-mitigated": "challenge" } }), "image");
    expect(error).toMatchObject({ code: "AI_PROVIDER_GATEWAY_BLOCK", diagnostic: { gatewaySignal: "cloudflare_challenge", responseKind: "unknown", billing: "rejected" } });
  });
  it.each(["", "sk-private-key", "a37be7f308e2b9b6-private", "a37be7f308e2b9b6-HKG trailing-secret"])("drops malformed correlation headers: %s", async ray => {
    const error = await readProviderHttpError(new Response(null, { status: 403, headers: { "cf-ray": ray, "x-request-id": "private-prompt", "cf-mitigated": "private-key", server: "private-key" } }), "models");
    expect(error.diagnostic).toEqual({ operation: "models", httpStatus: 403, category: "access_denied", billing: "rejected", responseKind: "empty" });
    expect(JSON.stringify(error)).not.toContain("private");
  });
});
