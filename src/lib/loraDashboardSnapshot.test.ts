import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import fixture from "../../scripts/fixtures/lora-dashboard.json";
import { LoraChainDashboardView } from "../pages/LoraChainDashboard";
import {
  chooseLoraDashboardSnapshot,
  readLoraDashboardSnapshot,
} from "./loraDashboardSnapshot";

function render(payload: unknown) {
  const snapshot = readLoraDashboardSnapshot(payload);
  expect(snapshot).not.toBeNull();
  return renderToStaticMarkup(createElement(LoraChainDashboardView, {
    data: snapshot!.data, clock: "10:30:00", busy: false,
    error: "", onRefresh: () => undefined,
  }));
}

describe("untrusted LORA dashboard snapshots", () => {
  it("preserves complete direct and wrapped snapshots", () => {
    expect(readLoraDashboardSnapshot(fixture)).toEqual({ data: fixture, issues: [] });
    expect(readLoraDashboardSnapshot({ dashboard: fixture })).toEqual({ data: fixture, issues: [] });
  });

  it.each([null, [], {}, { reportDate: "2026-08-14" }, { ...fixture, reportDate: {} }])(
    "rejects a non-snapshot without rendering it: %j", payload => {
      expect(readLoraDashboardSnapshot(payload)).toBeNull();
    },
  );

  it("renders available sections when old or partial data lacks entire sections", () => {
    const payload = { reportDate: fixture.reportDate, generatedAt: fixture.generatedAt, nodes: fixture.nodes };
    expect(readLoraDashboardSnapshot(payload)!.issues).toContain("price");
    const markup = render(payload);
    expect(markup).toContain("销毁 3000 LRB");
    expect(markup).toContain("暂无可信价格");
    expect(markup).not.toContain(">0<");
  });

  it("contains invalid nested arrays, entries and metric objects", () => {
    const payload = {
      ...fixture,
      reportDate: fixture.reportDate,
      nodes: { ...fixture.nodes, hourly: { invalid: true } },
      addresses: { ...fixture.addresses, todayNew: { invalid: true } },
      transactions: { ...fixture.transactions, hourly: [null, { hour: {}, count: {} }, { hour: "10", count: 42 }] },
      largeTransfers: { ...fixture.largeTransfers, top5: [null, {}], rows: "invalid" },
      swaps: { ...fixture.swaps, rows: [null, { hash: "bad", side: {} }] },
      chain: { ...fixture.chain, blockHeight: {} },
    };
    expect(readLoraDashboardSnapshot(payload)!.issues.length).toBeGreaterThan(0);
    expect(() => render(payload)).not.toThrow();
    expect(readLoraDashboardSnapshot(payload)!.data.transactions.hourly).toEqual([{ hour: "10", count: "42" }]);
  });

  it("keeps compatible older optional fields usable", () => {
    const payload = structuredClone(fixture) as Record<string, any>;
    delete payload.addresses;
    delete payload.largeTransfers.top5;
    delete payload.transactions.successRateLabel;
    delete payload.price.latestSwapPrice;
    delete payload.price.latestSwapAt;
    expect(readLoraDashboardSnapshot(payload)!.issues).toEqual([]);
    expect(() => render(payload)).not.toThrow();
  });

  it("keeps the last complete snapshot after a partial update", () => {
    const current = readLoraDashboardSnapshot(fixture)!;
    const partial = readLoraDashboardSnapshot({ ...fixture, price: null, generatedAt: "2026-08-14T03:00:00.000Z" })!;
    expect(chooseLoraDashboardSnapshot(current, partial)).toBe(current);
  });

  it("orders equal data timestamps by generated time and rejects exact-time overwrites", () => {
    const current = readLoraDashboardSnapshot(fixture)!;
    const newer = readLoraDashboardSnapshot({ ...fixture, generatedAt: "2026-08-14T03:00:00.000Z" })!;
    expect(chooseLoraDashboardSnapshot(current, newer)).toBe(newer);
    expect(chooseLoraDashboardSnapshot(newer, current)).toBe(newer);
    expect(chooseLoraDashboardSnapshot(current, readLoraDashboardSnapshot(fixture)!)).toBe(current);
  });

  it("allows a new reporting day without presenting yesterday as today", () => {
    const current = readLoraDashboardSnapshot(fixture)!;
    const nextDay = readLoraDashboardSnapshot({ ...fixture, reportDate: "2026-08-15", generatedAt: "2026-08-15T00:00:00.000Z", price: null })!;
    expect(chooseLoraDashboardSnapshot(current, nextDay)).toBe(nextDay);
  });
});
