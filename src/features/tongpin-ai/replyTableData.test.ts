import { describe, expect, it } from "vitest";
import { tableRowsFromHast, tableToCsv, tableToMarkdown, tableToTsv } from "./replyTableData";

const text = (value: string) => ({ type: "text", value });
const element = (tagName: string, children: unknown[]) => ({ type: "element", tagName, children });

describe("AI reply table data", () => {
  it("extracts only the current table, preserving nested inline text", () => {
    const table = element("table", [
      element("thead", [element("tr", [element("th", [text("项目")]), element("th", [text("进度")])])]),
      element("tbody", [element("tr", [element("td", [element("strong", [text("中文")]), text("内容")]), element("td", [text("完成")])])]),
    ]);
    expect(tableRowsFromHast(table)).toEqual([["项目", "进度"], ["中文内容", "完成"]]);
    expect(tableRowsFromHast(element("p", [text("非表格")]))).toEqual([]);
  });

  it("copies Markdown with escaped cell syntax and a stable rectangular header", () => {
    expect(tableToMarkdown([["字段", "说明"], ["a|b", "第一行\n第二行"], ["反斜杠\\", ""]]))
      .toBe("| 字段 | 说明 |\n| --- | --- |\n| a\\|b | 第一行<br>第二行 |\n| 反斜杠\\\\ |  |");
  });

  it("exports CSV with quoted data and neutralizes spreadsheet formula prefixes", () => {
    const rows = [["姓名", "值"], ["小秋", "=HYPERLINK(\"https://bad.example\")"], ["说明", "第一行,\n第二行"], ["负值", "-42"]];
    expect(tableToCsv(rows)).toBe('\uFEFF姓名,值\r\n小秋,"\'=HYPERLINK(""https://bad.example"")"\r\n说明,"第一行,\n第二行"\r\n负值,\'-42\r\n');
  });

  it("copies TSV without breaking cells or allowing a formula on paste", () => {
    expect(tableToTsv([["项", "值"], ["附件", " \t@IMPORT(foo)"], ["换行", "a\nb\tc"]]))
      .toBe("项\t值\n附件\t' @IMPORT(foo)\n换行\ta b c");
  });
});

describe("table CSV export (#13)", () => {
  it("uses a timestamped name so a new export never collides with an older file", async () => {
    const { csvFilename } = await import("./MarkdownReply");
    const name = csvFilename([["日期", "最高气温"], ["今天", "32"]], new Date(2026, 8, 26, 14, 5, 9));
    expect(name).toBe("同频AI-表格-日期-20260926-140509.csv");
    expect(csvFilename([], new Date(2026, 0, 2, 3, 4, 5))).toBe("同频AI-表格-20260102-030405.csv");
    expect(csvFilename([["a/b:c*?"]], new Date(2026, 0, 2, 3, 4, 5))).toBe("同频AI-表格-abc-20260102-030405.csv");
  });
  it("saves through the shared native-save path and reports its real outcome", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./MarkdownReply.tsx", import.meta.url), "utf8");
    expect(source).toContain("saveBlobWithFeedback(blob, csvFilename(rows))");
    expect(source).not.toContain("下载已开始");
    expect(source).not.toContain("anchor.download");
  });
});
