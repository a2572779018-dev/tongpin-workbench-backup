import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_OPENSQUILLA_ROUTING, type AiOpenSquillaRoutingSettings } from "../../../shared/aiOpenSquilla";
import { AdminAiOpenSquillaForm } from "./AdminAiOpenSquillaSettings";

const render = (draft: AiOpenSquillaRoutingSettings, busy = false) =>
  renderToStaticMarkup(createElement(AdminAiOpenSquillaForm, { draft, busy, onChange: () => undefined, onSubmit: () => undefined }));
const section = (html: string, tier: "quick" | "standard") => {
  const start = html.indexOf(`data-tier="${tier}"`);
  return html.slice(start, html.indexOf("</fieldset>", start));
};

describe("AI 管理 · OpenSquilla routing form (快速档与标准档)", () => {
  it("offers every action per OpenSquilla tier for both tiers and marks each tier's defaults", () => {
    const html = render({ ...DEFAULT_OPENSQUILLA_ROUTING, tiers: { ...DEFAULT_OPENSQUILLA_ROUTING.tiers, c1: "search" } });
    for (const label of ["C0 快速/简单 · 寒暄、确认、简单改写和简短事实", "C1 均衡", "C2 强推理 · 排错、多步骤实现计划和技术分析", "C3 最高质量"]) expect(html).toContain(label);
    expect(html.match(/<select/g)).toHaveLength(8);
    expect(html.match(/（默认）/g)).toHaveLength(8);
    const quick = section(html, "quick"), standard = section(html, "standard");
    expect(quick).toContain("<legend>快速档</legend>");
    expect(quick).toContain("快速档使用 OpenSquilla 路由结果");
    expect(quick).toContain('<option value="direct" selected="">直接回答（默认）</option>');
    expect(quick).toContain('<option value="search" selected="">按需联网核实</option>');
    expect(quick).toContain('<option value="suggest_upgrade" selected="">先回答，建议切换更高档位（默认）</option>');
    expect(standard).toContain("<legend>标准档</legend>");
    expect(standard).toContain("标准档使用 OpenSquilla 路由结果");
    // 标准档 reasons harder on C2 by default.
    expect(standard).toContain('<option value="reasoning" selected="">加深推理（默认）</option>');
    expect(html).toContain("不满足条件时按“直接回答”处理，并在回复过程中注明。");
    expect(html).not.toMatch(/<select[^>]*disabled/);
  });

  it("locks one tier's mapping while its routing is off, and everything while saving", () => {
    const off = render({ ...DEFAULT_OPENSQUILLA_ROUTING, standard: { ...DEFAULT_OPENSQUILLA_ROUTING.standard, enabled: false } });
    expect(section(off, "standard").match(/<select[^>]*disabled=""/g)).toHaveLength(4);
    expect(section(off, "quick")).not.toMatch(/<select[^>]*disabled/);
    expect(render(DEFAULT_OPENSQUILLA_ROUTING, true)).toContain("保存中…");
  });
});
