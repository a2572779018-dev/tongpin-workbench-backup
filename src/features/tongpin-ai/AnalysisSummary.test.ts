import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnalysisSummary } from "./AnalysisSummary";

describe("AnalysisSummary", () => {
  it("renders a compact native disclosure collapsed by default", () => {
    const markup = renderToStaticMarkup(createElement(AnalysisSummary, null, "依据任务约束比较后，先处理高风险项。"));
    expect(markup).toContain("<details class=\"tp-ai-analysis-summary\">");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("<summary>分析摘要</summary>");
    expect(markup).toContain("依据任务约束比较后，先处理高风险项。");
  });

  it("escapes markup instead of treating a summary as executable HTML", () => {
    const markup = renderToStaticMarkup(createElement(AnalysisSummary, null, "<img src=x onerror=alert(1) />"));
    expect(markup).toContain("&lt;img src=x onerror=alert(1) /&gt;");
    expect(markup).not.toContain("<img");
  });
});
