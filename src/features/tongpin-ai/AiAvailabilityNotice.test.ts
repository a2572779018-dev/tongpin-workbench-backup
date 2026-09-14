import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiAvailabilityNotice } from "./AiAvailabilityNotice";
import { generationAvailabilityFailure } from "./useAiAvailability";
import { ApiRequestError } from "../../lib/api";

describe("AI service entry notices", () => {
  it("shows checking and disables repeat checks", () => {
    const html = renderToStaticMarkup(createElement(AiAvailabilityNotice, { checking: true, check: null, onRetry() {} }));
    expect(html).toContain("正在检查服务连接"); expect(html).toContain("disabled"); expect(html).toContain("历史对话可正常查看");
  });
  it("distinguishes reachable from actual generation success", () => {
    const html = renderToStaticMarkup(createElement(AiAvailabilityNotice, { checking: false, check: { state: "reachable", code: "OK", message: "生成以实际请求结果为准", checkedAt: "now" }, onRetry() {} }));
    expect(html).toBe("");
  });
  it("blocks explicit service failures but not pending or content-specific rejection", () => {
    expect(generationAvailabilityFailure(new ApiRequestError(502, "AI_PROVIDER_GATEWAY_BLOCK", "网关拦截"))?.state).toBe("unavailable");
    for (const code of ["AI_REQUEST_IN_PROGRESS", "AI_PROVIDER_ACCESS_DENIED", "AI_PROVIDER_REJECTED", "AI_WAIT_TIMEOUT"]) {
      expect(generationAvailabilityFailure(new ApiRequestError(409, code, "request-specific"))).toBeNull();
    }
  });
});
