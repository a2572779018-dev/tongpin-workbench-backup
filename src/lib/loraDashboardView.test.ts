import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoraChainDashboardView } from "../pages/LoraChainDashboard";
import type { LoraDashboardData } from "./loraDashboardData";

const addressA = "0x1111111111111111111111111111111111111111";
const addressB = "0x2222222222222222222222222222222222222222";
const hash = `0x${"ab".repeat(32)}`;

const fixture: LoraDashboardData = {
  reportDate: "2026-08-14",
  timezone: "Asia/Shanghai",
  generatedAt: "2026-08-14T02:30:00.000Z",
  dataUpdatedAt: "2026-08-14T02:29:55.000Z",
  lastSuccessfulSyncAt: "2026-08-14T02:29:55.000Z",
  stale: false,
  baselineStatus: "ready",
  nodes: {
    todayCount: "3",
    todayNodeBurnLrb: "3000",
    todayOtherBurnLrb: "25.5",
    cumulativeBurnLrb: "120025.5",
    cumulativeConfirmedCount: "120",
    hourly: [{ hour: "10", count: "3" }],
  },
  addresses: {
    label: "今日新增链上地址",
    todayNew: "18",
    baselineStatus: "ready",
  },
  transactions: {
    todayTotal: "420",
    success: "410",
    failed: "10",
    successRate: "97.6190",
    successRateLabel: "97.62%",
    nativeTransfers: "96",
    activeAddresses: "181",
    yesterdayTotal: "680",
    hourly: [{ hour: "10", count: "42" }],
  },
  largeTransfers: {
    count: "1",
    totalLrb: "150.25",
    maxLrb: "150.25",
    rows: [],
    top5: [
      {
        time: "2026-08-14T02:20:00.000Z",
        from: addressA,
        to: addressB,
        amountLrb: "150.25",
        type: "普通转账",
        status: "成功",
        hash,
      },
    ],
  },
  swaps: {
    enabled: true,
    status: "ready",
    rows: [
      {
        time: "2026-08-14T02:25:00.000Z",
        side: "买入",
        lrbAmount: "120.5",
        usdtAmount: "24.1",
        price: "0.2",
        initiator: addressA,
        currentNativeBalanceLrb: "900",
        hash,
      },
    ],
    latestPrice: "0.2",
    latestAt: "2026-08-14T02:25:00.000Z",
  },
  price: {
    status: "ready",
    priceUsdt: "0.2",
    source: "WLRB/USDT Pair",
    pair: "0x55b4Ea7Bc8D22b156381b01cA9c58dBfB6345454",
    blockNumber: "888888",
    updatedAt: "2026-08-14T02:29:00.000Z",
    latestSwapPrice: "0.2",
    latestSwapAt: "2026-08-14T02:25:00.000Z",
  },
  chain: {
    blockHeight: "888888",
    lastBlockAt: "2026-08-14T02:29:58.000Z",
    averageBlockTime: "3.02 秒",
    gasUsed: "12345678",
    averageGasPrice: "1.5 Gwei",
  },
  health: {
    rpc: "ready",
    explorer: "ready",
    collector: "ready",
    lastSuccessfulSyncAt: "2026-08-14T02:29:55.000Z",
  },
};

function render(data: LoraDashboardData | null): string {
  return renderToStaticMarkup(
    createElement(LoraChainDashboardView, {
      data,
      clock: "10:30:00",
      busy: false,
      error: "",
      onRefresh: () => undefined,
    }),
  );
}

describe("LORA dashboard fixed fixture", () => {
  it("renders every required dashboard section without explanatory small text", () => {
    const markup = render(fixture);
    expect(markup).toContain("LORA 链数据驾驶舱");
    expect(markup).toContain("按 1000 LRB 销毁规则统计");
    expect(markup).toContain("每小时交易趋势");
    expect(markup).toContain("每小时新增节点趋势");
    expect(markup).toContain("超过 100 LRB 的转账 · Top 5");
    expect(markup).toContain("超过 100 LRB 的 Swap");
    expect(markup).toContain("价格时间");
    expect(markup).toContain("RPC 正常");
    expect(markup).not.toContain("<small");
  });

  it("shows honest unavailable states instead of zero", () => {
    const markup = render(null);
    expect(markup).toContain("采集中");
    expect(markup).toContain("无日基线");
    expect(markup).toContain("暂无可信价格");
    expect(markup).not.toContain(">0<");
  });

  it("shows a stale cached Pair value as an explicitly cached price", () => {
    const markup = render({
      ...fixture,
      price: { ...fixture.price, status: "stale" },
    });
    expect(markup).toContain("0.2");
    expect(markup).toContain("缓存价格");
  });
});
