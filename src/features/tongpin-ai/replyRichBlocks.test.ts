import { describe, expect, it } from "vitest";
import { openFenceLanguage, parseReplyCards, parseReplyChart, parseReplyFollowups, pendingReplyTail } from "./replyRichBlocks";

const base = { title: "月度营收", unit: "万元", source: "示例数据，仅用于演示" };
const chart = (extra: Record<string, unknown>) => JSON.stringify({ ...base, ...extra });

describe("parseReplyChart", () => {
  it("keeps accepting the original single-series format, normalized to labels + series", () => {
    expect(parseReplyChart(chart({ type: "bar", series: [{ label: "1月", value: 120 }, { label: "2月", value: 135.5 }] }))).toEqual({
      ...base, type: "bar", labels: ["1月", "2月"], series: [{ name: "", values: [120, 135.5] }],
    });
  });

  it("accepts multi-series bar and line charts with shared labels and null gaps", () => {
    const line = parseReplyChart(chart({ type: "line", labels: ["Q1", "Q2", "Q3"], series: [
      { name: "2024", values: [10, 12, 15] },
      { name: "2025", values: [11, null, 18] },
    ] }));
    expect(line?.labels).toEqual(["Q1", "Q2", "Q3"]);
    expect(line?.series).toEqual([{ name: "2024", values: [10, 12, 15] }, { name: "2025", values: [11, null, 18] }]);
    // A lone series may stay unnamed; the chart title names it.
    expect(parseReplyChart(chart({ type: "bar", labels: ["a"], series: [{ values: [1] }] }))?.series).toEqual([{ name: "", values: [1] }]);
  });

  it("accepts donut and pie part-to-whole charts in either shape", () => {
    const donut = parseReplyChart(chart({ type: "donut", series: [{ label: "直营", value: 45 }, { label: "电商", value: 30 }, { label: "其他", value: 0 }] }));
    expect(donut).toMatchObject({ type: "donut", labels: ["直营", "电商", "其他"], series: [{ name: "", values: [45, 30, 0] }] });
    expect(parseReplyChart(chart({ type: "pie", labels: ["A", "B"], series: [{ name: "占比", values: [1, 3] }] }))?.type).toBe("pie");
  });

  it("rejects a chart without unit or source - an unlabelled picture would mislead", () => {
    expect(parseReplyChart(JSON.stringify({ title: "t", type: "bar", series: [{ label: "a", value: 1 }] }))).toBeNull();
    expect(parseReplyChart(JSON.stringify({ title: "t", unit: "元", type: "bar", series: [{ label: "a", value: 1 }] }))).toBeNull();
  });

  it("rejects malformed JSON and unknown chart types", () => {
    expect(parseReplyChart("{not json")).toBeNull();
    expect(parseReplyChart(chart({ type: "radar", series: [{ label: "a", value: 1 }] }))).toBeNull();
    expect(parseReplyChart(chart({ type: "bar", series: {} }))).toBeNull();
  });

  it("rejects non-finite, non-numeric or all-missing values instead of drawing NaN", () => {
    expect(parseReplyChart(chart({ type: "bar", series: [{ label: "a", value: "x" }] }))).toBeNull();
    expect(parseReplyChart(chart({ type: "bar", series: [{ label: "a", value: Number.NaN }] }))).toBeNull();
    expect(parseReplyChart(chart({ type: "line", labels: ["a"], series: [{ name: "s", values: ["1"] }] }))).toBeNull();
    expect(parseReplyChart(chart({ type: "line", labels: ["a", "b"], series: [{ name: "s", values: [null, null] }] }))).toBeNull();
    expect(parseReplyChart(chart({ type: "bar", labels: ["a"], series: [{ name: "s", values: [1e16] }] }))).toBeNull();
  });

  it("rejects mismatched, unnamed or oversized multi-series data", () => {
    expect(parseReplyChart(chart({ type: "bar", labels: ["a", "b"], series: [{ name: "s", values: [1] }] }))).toBeNull();
    expect(parseReplyChart(chart({ type: "bar", labels: ["a"], series: [{ name: "s", values: [1] }, { values: [2] }] }))).toBeNull();
    expect(parseReplyChart(chart({ type: "bar", labels: ["", "b"], series: [{ name: "s", values: [1, 2] }] }))).toBeNull();
    const seven = Array.from({ length: 7 }, (_, i) => ({ name: `s${i}`, values: [i] }));
    expect(parseReplyChart(chart({ type: "line", labels: ["a"], series: seven }))).toBeNull();
    expect(parseReplyChart(chart({ type: "line", labels: ["a"], series: seven.slice(0, 6) }))?.series).toHaveLength(6);
  });

  it("caps the category count so one block cannot stall the message", () => {
    const big = Array.from({ length: 25 }, (_, i) => ({ label: `p${i}`, value: i }));
    expect(parseReplyChart(chart({ type: "bar", series: big }))).toBeNull();
    expect(parseReplyChart(chart({ type: "bar", series: big.slice(0, 24) }))).not.toBeNull();
    expect(parseReplyChart(chart({ type: "line", labels: big.map(p => p.label), series: [{ name: "s", values: big.map(p => p.value) }] }))).toBeNull();
    expect(parseReplyChart("x".repeat(8_001))).toBeNull();
  });

  it("rejects part-to-whole charts that cannot be drawn honestly", () => {
    const slices = (values: unknown[]) => chart({ type: "donut", series: values.map((value, i) => ({ label: `s${i}`, value })) });
    expect(parseReplyChart(slices([3, -1]))).toBeNull();
    expect(parseReplyChart(slices([0, 0]))).toBeNull();
    expect(parseReplyChart(slices([1, 1, 1, 1, 1, 1, 1]))).toBeNull();
    expect(parseReplyChart(slices([1, 1, 1, 1, 1, 1]))).not.toBeNull();
    expect(parseReplyChart(chart({ type: "pie", labels: ["a", "b"], series: [{ name: "x", values: [1, 2] }, { name: "y", values: [3, 4] }] }))).toBeNull();
    expect(parseReplyChart(chart({ type: "pie", labels: ["a", "b"], series: [{ name: "x", values: [1, null] }] }))).toBeNull();
  });
});

describe("parseReplyCards", () => {
  it("accepts KPI cards, formats numbers and keeps optional fields optional", () => {
    const cards = parseReplyCards(JSON.stringify([
      { title: "月活用户", value: 123456, unit: "人", delta: "+8.2%", trend: "up", note: "较上月" },
      { title: "转化率", value: "3.4%", delta: -0.6 },
      { title: "工单", value: 0, unit: null, delta: "", trend: null, note: "  " },
    ]));
    expect(cards).toEqual([
      { title: "月活用户", value: "123,456", unit: "人", delta: "+8.2%", trend: "up", note: "较上月" },
      { title: "转化率", value: "3.4%", unit: "", delta: "-0.6", trend: "down", note: "" },
      { title: "工单", value: "0", unit: "", delta: "", trend: null, note: "" },
    ]);
  });

  it("infers direction only from an explicit sign when trend is omitted", () => {
    const trend = (delta: unknown) => parseReplyCards(JSON.stringify([{ title: "t", value: 1, delta }]))?.[0].trend;
    expect(trend("+3")).toBe("up");
    expect(trend("−3")).toBe("down");
    expect(trend(0)).toBe("flat");
    expect(trend("约 3%")).toBeNull();
    expect(parseReplyCards(JSON.stringify([{ title: "t", value: 1, delta: "+3", trend: "flat" }]))?.[0].trend).toBe("flat");
  });

  it("returns null for malformed, empty or oversized card sets so the raw text stays visible", () => {
    const card = { title: "t", value: 1 };
    expect(parseReplyCards("[{")).toBeNull();
    expect(parseReplyCards(JSON.stringify(card))).toBeNull();
    expect(parseReplyCards("[]")).toBeNull();
    expect(parseReplyCards(JSON.stringify(Array.from({ length: 7 }, () => card)))).toBeNull();
    expect(parseReplyCards(JSON.stringify(Array.from({ length: 6 }, () => card)))).toHaveLength(6);
    expect(parseReplyCards(JSON.stringify([{ value: 1 }]))).toBeNull();
    expect(parseReplyCards(JSON.stringify([{ title: "t" }]))).toBeNull();
    expect(parseReplyCards(JSON.stringify([{ title: "t", value: Number.POSITIVE_INFINITY }]))).toBeNull();
    expect(parseReplyCards(JSON.stringify([{ title: "t", value: 1, trend: "rising" }]))).toBeNull();
    expect(parseReplyCards(JSON.stringify([{ title: "t", value: 1, unit: 5 }]))).toBeNull();
    expect(parseReplyCards(JSON.stringify([{ title: "t", value: { nested: true } }]))).toBeNull();
    expect(parseReplyCards(`[${"x".repeat(4_000)}]`)).toBeNull();
  });
});

describe("parseReplyFollowups", () => {
  it("keeps at most three short suggestions", () => {
    expect(parseReplyFollowups(JSON.stringify(["一", "二", "三", "四"]))).toEqual(["一", "二", "三"]);
  });

  it("drops empty and oversized entries", () => {
    expect(parseReplyFollowups(JSON.stringify(["", "  ", "x".repeat(200), "有效"]))).toEqual(["有效"]);
  });

  it("returns nothing for malformed payloads", () => {
    expect(parseReplyFollowups("nope")).toEqual([]);
    expect(parseReplyFollowups(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(parseReplyFollowups(JSON.stringify([1, 2]))).toEqual([]);
  });
});

describe("open fences", () => {
  it("reports the language of a still-open fence only", () => {
    expect(openFenceLanguage("```TS\nconst a = 1")).toBe("ts");
    expect(openFenceLanguage("```\nplain")).toBe("");
    expect(openFenceLanguage("```ts\nconst a = 1\n```")).toBeNull();
    expect(openFenceLanguage("~~~~py\nx = 1\n~~~")).toBe("py");
    expect(openFenceLanguage("正文")).toBeNull();
  });

  it("gives an unfinished cards fence its own placeholder", () => {
    expect(pendingReplyTail('```cards\n[{"title":"营')).toBe("cards");
    expect(pendingReplyTail('```cards\n[{"title":"营收","value":1}]\n```')).toBeNull();
  });
});
