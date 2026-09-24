import { describe, expect, it } from "vitest";
import { parseReplyChart, parseReplyFollowups } from "./replyRichBlocks";

const validChart = JSON.stringify({
  title: "月度营收",
  unit: "万元",
  source: "示例数据，仅用于演示",
  type: "bar",
  series: [{ label: "1月", value: 120 }, { label: "2月", value: 135.5 }],
});

describe("parseReplyChart", () => {
  it("accepts a fully labelled bar chart", () => {
    const chart = parseReplyChart(validChart);
    expect(chart).toEqual({ title: "月度营收", unit: "万元", source: "示例数据，仅用于演示", type: "bar", series: [{ label: "1月", value: 120 }, { label: "2月", value: 135.5 }] });
  });

  it("rejects a chart without unit or source - an unlabelled picture would mislead", () => {
    expect(parseReplyChart(JSON.stringify({ title: "t", type: "bar", series: [{ label: "a", value: 1 }] }))).toBeNull();
    expect(parseReplyChart(JSON.stringify({ title: "t", unit: "元", type: "bar", series: [{ label: "a", value: 1 }] }))).toBeNull();
  });

  it("rejects malformed JSON and unknown chart types", () => {
    expect(parseReplyChart("{not json")).toBeNull();
    expect(parseReplyChart(JSON.stringify({ title: "t", unit: "元", source: "s", type: "pie", series: [{ label: "a", value: 1 }] }))).toBeNull();
  });

  it("rejects non-finite or non-numeric values instead of drawing NaN", () => {
    expect(parseReplyChart(JSON.stringify({ title: "t", unit: "元", source: "s", type: "bar", series: [{ label: "a", value: "x" }] }))).toBeNull();
    expect(parseReplyChart(JSON.stringify({ title: "t", unit: "元", source: "s", type: "bar", series: [{ label: "a", value: Number.NaN }] }))).toBeNull();
  });

  it("caps the series length so one block cannot stall the message", () => {
    const big = Array.from({ length: 25 }, (_, i) => ({ label: `p${i}`, value: i }));
    expect(parseReplyChart(JSON.stringify({ title: "t", unit: "元", source: "s", type: "bar", series: big }))).toBeNull();
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
