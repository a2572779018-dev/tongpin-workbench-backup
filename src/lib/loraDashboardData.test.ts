import { describe, expect, it } from "vitest";
import {
  LORA_DASHBOARD_POLL_MS,
  chartCount,
  compactExplorerValue,
  displayLoraValue,
  statusLabel,
} from "./loraDashboardData";

describe("LORA dashboard display policy", () => {
  it("refreshes the cached dashboard once per minute", () => {
    expect(LORA_DASHBOARD_POLL_MS).toBe(60_000);
  });

  it("never substitutes zero for unavailable data", () => {
    expect(displayLoraValue(null, "暂无可信价格")).toBe("暂无可信价格");
    expect(displayLoraValue(undefined, "基线建立中")).toBe("基线建立中");
  });

  it("keeps decimal amounts as strings", () => {
    expect(displayLoraValue("1000.000000000000000001", "—")).toBe(
      "1000.000000000000000001",
    );
  });

  it("maps explicit data states to concise labels", () => {
    expect(statusLabel("building")).toBe("基线建立中");
    expect(statusLabel("missing")).toBe("暂无完整日基线");
    expect(statusLabel("config-error")).toBe("配置错误");
  });

  it("uses counts only for chart geometry", () => {
    expect(chartCount("42")).toBe(42);
    expect(chartCount("1.2")).toBe(0);
    expect(chartCount(null)).toBe(0);
  });

  it("shortens explorer identifiers without changing their value", () => {
    const address = "0x1234567890123456789012345678901234567890";
    expect(compactExplorerValue(address)).toBe("0x123456…567890");
    expect(address).toBe("0x1234567890123456789012345678901234567890");
  });
});
