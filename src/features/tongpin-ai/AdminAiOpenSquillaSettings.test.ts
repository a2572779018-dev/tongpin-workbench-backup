import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_OPENSQUILLA_ROUTING, type AiOpenSquillaRoutingSettings } from "../../../shared/aiOpenSquilla";
import { AdminAiOpenSquillaForm } from "./AdminAiOpenSquillaSettings";

const render = (draft: AiOpenSquillaRoutingSettings, busy = false) =>
  renderToStaticMarkup(createElement(AdminAiOpenSquillaForm, { draft, busy, onChange: () => undefined, onSubmit: () => undefined }));

describe("AI 管理 · OpenSquilla quick-tier routing form", () => {
  it("offers every action per OpenSquilla tier and marks OpenSquilla's defaults", () => {
    const html = render({ ...DEFAULT_OPENSQUILLA_ROUTING, tiers: { ...DEFAULT_OPENSQUILLA_ROUTING.tiers, c1: "search" } });
    for (const label of ["C0 快速/简单 · 寒暄、确认、简单改写和简短事实", "C1 均衡", "C2 强推理 · 排错、多步骤实现计划和技术分析", "C3 最高质量"]) expect(html).toContain(label);
    expect(html.match(/<select/g)).toHaveLength(4);
    expect(html.match(/（默认）/g)).toHaveLength(4);
    expect(html).toContain('<option value="direct" selected="">快速模型直接回答（默认）</option>');
    expect(html).toContain('<option value="search" selected="">快速模型 + 按需联网核实</option>');
    expect(html).toContain('<option value="suggest_upgrade" selected="">快速模型先回答，建议切换更高档位（默认）</option>');
    expect(html).toContain("不满足条件时按“直接回答”处理，并在回复过程中注明。");
    expect(html).not.toMatch(/<select[^>]*disabled/);
  });

  it("locks the mapping while OpenSquilla routing is off and while saving", () => {
    const off = render({ ...DEFAULT_OPENSQUILLA_ROUTING, enabled: false });
    expect(off.match(/<select[^>]*disabled=""/g)).toHaveLength(4);
    expect(render(DEFAULT_OPENSQUILLA_ROUTING, true)).toContain("保存中…");
  });
});
