type TreeNode = { type?: unknown; tagName?: unknown; value?: unknown; children?: unknown };

function node(value: unknown): TreeNode | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as TreeNode : null;
}

function children(value: TreeNode): unknown[] {
  return Array.isArray(value.children) ? value.children : [];
}

function isTag(value: unknown, tagName: string): value is TreeNode {
  const item = node(value);
  return item?.type === "element" && item.tagName === tagName;
}

function cellText(value: unknown): string {
  const item = node(value);
  if (!item) return "";
  if (item.type === "text") return typeof item.value === "string" ? item.value : "";
  if (item.type !== "element") return "";
  if (item.tagName === "br") return "\n";
  return children(item).map(cellText).join("");
}

/** Extracts one react-markdown/HAST table only; never reads mutable DOM or a different table. */
export function tableRowsFromHast(value: unknown): string[][] {
  if (!isTag(value, "table")) return [];
  const rows: string[][] = [];
  const addRow = (candidate: unknown) => {
    if (!isTag(candidate, "tr")) return;
    const cells = children(candidate).filter(child => isTag(child, "td") || isTag(child, "th"));
    if (cells.length) rows.push(cells.map(cell => cellText(cell).trim()));
  };
  for (const item of children(value)) {
    if (isTag(item, "tr")) addRow(item);
    else if (isTag(item, "thead") || isTag(item, "tbody") || isTag(item, "tfoot")) children(item).forEach(addRow);
  }
  return rows;
}

function rectangle(rows: string[][]): string[][] {
  const width = Math.max(0, ...rows.map(row => row.length));
  return rows.map(row => Array.from({ length: width }, (_, index) => row[index] ?? ""));
}

function markdownCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r\n?|\n/g, "<br>");
}

export function tableToMarkdown(rows: string[][]): string {
  const shaped = rectangle(rows);
  if (!shaped.length || !shaped[0].length) return "";
  const row = (cells: string[]) => `| ${cells.map(markdownCell).join(" | ")} |`;
  return [row(shaped[0]), row(shaped[0].map(() => "---")), ...shaped.slice(1).map(row)].join("\n");
}

/** Spreadsheet applications may evaluate even whitespace-prefixed formulas. */
function spreadsheetSafe(value: string): string {
  return /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
}

function csvCell(value: string): string {
  const safe = spreadsheetSafe(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function tableToCsv(rows: string[][]): string {
  return `\uFEFF${rectangle(rows).map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function tableToTsv(rows: string[][]): string {
  return rectangle(rows).map(row => row.map(value => spreadsheetSafe(value.replace(/[\t\r\n]+/g, " ").replace(/ {2,}/g, " "))).join("\t")).join("\n");
}
