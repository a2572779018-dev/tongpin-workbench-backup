import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AiQuota } from "../../../shared/ai";
import { AI_QUOTA_BILLING_NOTE, formatAiPoints, formatQuotaPercent, quotaPercent, quotaRemainingSummary } from "./quotaFormatting";
import { TongpinAIQuotaSummary } from "./TongpinAIQuotaSummary";

const quota: AiQuota = { limitTokens: 10_000, usedTokens: 2_836, reservedTokens: 0, remainingTokens: 7_164, inputTokens: 1234, outputTokens: 1602 };
const summaryMarkup = (usage = quota, quotaSynced = true) => renderToStaticMarkup(createElement(TongpinAIQuotaSummary, { usage, quotaSynced }));

describe("member percentage-only quota summary", () => {
  it("only shows a percentage, not raw assigned, used, or remaining points", () => {
    const markup = summaryMarkup();
    expect(markup).toContain("剩余 71.6%");
    expect(markup).toContain("点击查看使用详情");
    expect(markup).toContain('role="tooltip"');
    for (const value of ["7,164", "7164", "10,000", "10000", "2,836", "2836", "输入", "输出", "已用"]) expect(markup).not.toContain(value);
  });

  it("does not subtract in-flight reservations a second time or call them already consumed", () => {
    const reserved = { ...quota, usedTokens: 2000, reservedTokens: 1000, remainingTokens: 7000 };
    expect(quotaRemainingSummary(reserved)).toMatchObject({ percent: 70, label: "剩余 70%" });
    const markup = summaryMarkup(reserved);
    expect(markup).toContain("处理中预留");
    expect(markup).not.toContain("已耗尽");
    expect(markup).not.toContain("1,000");
    expect(summaryMarkup({ ...reserved, reservedTokens: 8000, remainingTokens: 0 })).toContain("剩余 0%");
    expect(summaryMarkup({ ...reserved, reservedTokens: 8000, remainingTokens: 0 })).not.toContain("已耗尽");
  });

  it("distinguishes unallocated, exhausted, and not-yet-synced states", () => {
    const zero = { ...quota, limitTokens: 0, usedTokens: 0, reservedTokens: 0, remainingTokens: 0 };
    expect(summaryMarkup(zero)).toContain("尚未分配");
    expect(summaryMarkup(zero)).toContain("剩余 0%");
    expect(summaryMarkup({ ...quota, usedTokens: 10000, remainingTokens: 0 })).toContain("已耗尽");
    expect(summaryMarkup(quota, false)).toContain("尚未同步");
    expect(summaryMarkup(quota, false)).not.toContain("剩余 0%");
    expect(summaryMarkup(quota, false)).not.toContain("width:");
  });

  it.each([
    [0, "0%"], [0.001, "<0.1%"], [0.05, "<0.1%"], [0.1, "0.1%"],
    [0.14, "0.1%"], [71.64, "71.6%"], [71.66, "71.7%"], [99.9, "99.9%"],
    [99.9999, ">99.9%"], [100, "100%"],
  ])("formats %s without turning a tiny positive balance into zero or a nearly-full one into full", (percent, expected) => {
    expect(formatQuotaPercent(percent)).toBe(expected);
  });

  it("keeps a single point out of a large quota visibly positive", () => {
    expect(quotaRemainingSummary({ limitTokens: 1_000_000_000, remainingTokens: 1, reservedTokens: 0 }).label).toBe("剩余 <0.1%");
    expect(quotaRemainingSummary({ limitTokens: 1000, remainingTokens: 1, reservedTokens: 0 }).label).toBe("剩余 0.1%");
  });

  it("bounds the display and treats invalid numbers as unknown", () => {
    expect(quotaPercent(120, 100)).toBe(100);
    expect(quotaPercent(0, 0)).toBe(0);
    for (const invalid of [NaN, Infinity, -1]) {
      expect(quotaPercent(invalid, 100)).toBeNull();
      expect(quotaPercent(100, invalid)).toBeNull();
      expect(quotaRemainingSummary({ ...quota, remainingTokens: invalid }).label).toBe("尚未同步");
    }
  });
});

describe("point labels preserve underlying quota and token accounting", () => {
  it("adds only a unit and leaves the supplied values unchanged", () => {
    const frozen = Object.freeze({ ...quota });
    expect(formatAiPoints(frozen.limitTokens)).toBe("10,000 同频点");
    expect(formatAiPoints(frozen.usedTokens)).toBe("2,836 同频点");
    expect(formatAiPoints(frozen.remainingTokens)).toBe("7,164 同频点");
    quotaRemainingSummary(frozen);
    expect(frozen).toEqual(quota);
    expect(AI_QUOTA_BILLING_NOTE).toContain("每 1 Token 计 1 同频点");
    expect(AI_QUOTA_BILLING_NOTE).toContain("图片与联网搜索");
  });

  it("retains independent real input/output counters and the original ledger endpoint in details", () => {
    const source = readFileSync(new URL("./TongpinAIAccountUsage.tsx", import.meta.url), "utf8");
    expect(source).toContain('<TongpinAIQuotaSummary usage={usage} quotaSynced={quotaSynced} />');
    expect(source).toContain('"/api/ai/usage"');
    expect(source).toContain('label: "输入 Token", value: usage.inputTokens');
    expect(source).toContain('label: "输出 Token", value: usage.outputTokens');
    expect(source).toContain('label: "处理中预留 · 同频点", value: usage.reservedTokens');
    expect(source).toContain('aiUsageDescription(entry)');
    expect(source).toContain('formatAiPoints(entry.limitTokens ?? 0)');
    expect(source).not.toContain('1 Token 计入 1 额度');
  });

  it("labels administrator balances and tool conversions in points, while keeping the text output cap in Token", () => {
    const admin = readFileSync(new URL("./AdminAiQuotaPanel.tsx", import.meta.url), "utf8");
    const provider = readFileSync(new URL("./AdminAiProviderSettings.tsx", import.meta.url), "utf8");
    const harness = readFileSync(new URL("./AdminAiHarnessSettings.tsx", import.meta.url), "utf8");
    expect(admin).toContain('JSON.stringify({ limitTokens: next.limitTokens,');
    expect(admin).toContain('formatAiPoints(member.quota.limitTokens)');
    expect(admin).toContain('AI_QUOTA_BILLING_NOTE');
    expect(provider).toContain('每张图片折算 · 同频点');
    expect(provider).toContain('每次联网搜索折算 · 同频点');
    expect(harness).toContain('单次输出上限 · Token');
    expect(harness).toContain('value={route.maxOutputTokens}');
    expect(provider).toContain('imageQuotaTokens: input.imageQuotaTokens ?? 0');
    expect(provider).toContain('webSearchQuotaTokens: input.webSearchQuotaTokens ?? 0');
  });
});
