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
