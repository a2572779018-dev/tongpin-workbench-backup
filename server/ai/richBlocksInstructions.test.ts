import { describe, expect, it } from "vitest";
import type { AiChatRequest } from "../../shared/ai";
import { parseReplyCards, parseReplyChart, parseReplyFollowups } from "../../src/features/tongpin-ai/replyRichBlocks";
import { chatInstructions, RICH_BLOCKS } from "./capabilities";

const chat = (extra: Partial<AiChatRequest> = {}): AiChatRequest => ({ requestId: crypto.randomUUID(), mode: "quick", messages: [{ role: "user", content: "对比两个季度" }], ...extra });
const template = (pattern: RegExp) => {
  const match = pattern.exec(RICH_BLOCKS)?.[0];
  expect(match, String(pattern)).toBeTruthy();
  return match!;
};

describe("rich reply block instructions", () => {
  it("reaches ordinary answers, including the main chat dispatch path", () => {
    for (const request of [chat(), chat({ outputFormat: "dispatch" })]) {
      const instructions = chatInstructions(request);
      expect(instructions).toContain(RICH_BLOCKS);
      expect(instructions).toContain("宁简勿繁");
    }
    // The optional blocks are explicitly on demand, not a template.
    expect(RICH_BLOCKS).toContain("仅在确有帮助时使用，多数回复不需要");
  });

  it("stays out of JSON-only tool plans, PPT generation and the agent continuation protocol", () => {
    for (const outputFormat of ["image_plan", "presentation_plan", "computer_plan"] as const) {
      const instructions = chatInstructions(chat({ outputFormat }));
      expect(instructions).not.toContain("```chart");
      expect(instructions).not.toContain("```cards");
    }
    expect(chatInstructions(chat({ outputFormat: "presentation", toolPlanRequestId: "plan-request-0000001" }))).not.toContain("```chart");
    expect(chatInstructions(chat({ skillIds: ["agent-continuation-v1"] }))).not.toContain("```followups");
  });

  it("documents one chart shape that the renderer accepts for every chart type", () => {
    const shape = template(/\{"type":"bar\|line\|donut\|pie".*?"values":\[数字\]\}\]\}/);
    const fill = (type: string, value: string) => shape.replace('"bar|line|donut|pie"', `"${type}"`).replace("数字", value);
    for (const type of ["bar", "line", "donut", "pie"]) {
      expect(parseReplyChart(fill(type, "42")), type).toEqual({ type, title: "标题", unit: "单位", source: "数据来源", labels: ["类别"], series: [{ name: "系列名", values: [42] }] });
    }
    // A missing value needs at least one real number beside it on an axis, and
    // is never a valid share of a whole.
    expect(parseReplyChart(fill("bar", "null"))).toBeNull();
    expect(parseReplyChart(fill("pie", "-1"))).toBeNull();
    expect(RICH_BLOCKS).toContain("values 与 labels 一一对应，缺失填 null");
  });

  it("documents chart limits at or below what the renderer accepts", () => {
    expect(RICH_BLOCKS).toContain("最多 4 个系列、24 个类别");
    const labels = Array.from({ length: 24 }, (_, i) => `第${i + 1}月`);
    const series = Array.from({ length: 4 }, (_, i) => ({ name: `系列${i}`, values: labels.map((_, j) => i * j) }));
    const wide = (extraLabel: boolean) => JSON.stringify({ type: "bar", title: "t", unit: "u", source: "s", labels: extraLabel ? [...labels, "多"] : labels,
      series: series.map(item => ({ ...item, values: extraLabel ? [...item.values, 1] : item.values })) });
    expect(parseReplyChart(wide(false))?.series).toHaveLength(4);
    expect(parseReplyChart(wide(true))).toBeNull();
    expect(RICH_BLOCKS).toContain("donut/pie 表示占比，只用 1 个系列、最多 6 个类别，数值不为负且不缺失");
    const shares = (count: number, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "donut", title: "t", unit: "u", source: "s",
      labels: Array.from({ length: count }, (_, i) => `项${i}`), series: [{ name: "占比", values: Array.from({ length: count }, (_, i) => i + 1) }], ...extra });
    expect(parseReplyChart(shares(6))).not.toBeNull();
    expect(parseReplyChart(shares(7))).toBeNull();
    expect(parseReplyChart(shares(2, { series: [{ name: "a", values: [1, 2] }, { name: "b", values: [3, 4] }] }))).toBeNull();
  });

  it("documents KPI cards in the shape the renderer accepts, with optional fields optional", () => {
    const cards = template(/\[\{"title":"指标".*?\}\]/);
    const filled = cards.replace("数字", "1280").replace('"up|down|flat"', '"up"');
    expect(parseReplyCards(filled)).toEqual([{ title: "指标", value: "1,280", unit: "单位", delta: "变化", trend: "up", note: "说明" }]);
    expect(parseReplyCards('[{"title":"指标","value":"98%"}]')).toEqual([{ title: "指标", value: "98%", unit: "", delta: "", trend: null, note: "" }]);
    expect(RICH_BLOCKS).toContain("```cards 代码块");
    expect(RICH_BLOCKS).toContain("unit、delta、trend、note 可省略");
    expect(RICH_BLOCKS).toMatch(/```cards.*最多 6 项/);
    const six = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ title: `指标${i}`, value: i })));
    expect(parseReplyCards(six)).toHaveLength(6);
    expect(parseReplyCards(JSON.stringify([...JSON.parse(six), { title: "多", value: 1 }]))).toBeNull();
  });

  it("mentions task lists, followups and the ruled-out syntaxes", () => {
    expect(RICH_BLOCKS).toContain("待办清单可用 - [ ] / - [x]");
    expect(RICH_BLOCKS).toContain("最多 3 条");
    expect(parseReplyFollowups('["一", "二", "三", "四"]')).toHaveLength(3);
    // Unsupported syntaxes and media links are ruled out rather than silently degraded.
    for (const text of ["不输出 HTML、Mermaid", "$...$", "不用 \\( \\) 或 \\[ \\]", "界面不会显示回复中的图片或视频链接", "不得编造数据或来源"]) expect(RICH_BLOCKS).toContain(text);
  });
});
