type HastNode = { type?: unknown; tagName?: unknown; value?: unknown; children?: unknown; properties?: unknown; className?: unknown; position?: unknown };

function asNode(value: unknown): HastNode | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as HastNode : null;
}

function nodeChildren(value: HastNode): unknown[] {
  return Array.isArray(value.children) ? value.children : [];
}

function textContent(value: unknown): string {
  const item = asNode(value);
  if (!item) return "";
  if (item.type === "text") return typeof item.value === "string" ? item.value : "";
  if (item.type !== "element") return "";
  return nodeChildren(item).map(textContent).join("");
}

/** Read a react-markdown fenced code block without executing or normalizing its content. */
export function codeBlockFromHast(value: unknown): { text: string; language: string } {
  const pre = asNode(value);
  if (pre?.type !== "element" || pre.tagName !== "pre") return { text: "", language: "" };
  const code = nodeChildren(pre).map(asNode).find(item => item?.type === "element" && item.tagName === "code");
  if (!code) return { text: "", language: "" };
  const props = asNode(code.properties);
  const classes: unknown[] = Array.isArray(props?.className) ? props.className : typeof props?.className === "string" ? props.className.split(/\s+/) : [];
  const language = classes.filter((part): part is string => typeof part === "string")
    .map(part => /^language-([A-Za-z0-9+#.\-]{1,32})$/.exec(part)?.[1] ?? "")
    .find(Boolean) ?? "";
  return { text: nodeChildren(code).map(textContent).join(""), language };
}

function line(point: unknown): { line: number; column: number } | null {
  const value = asNode(point) as { line?: unknown; column?: unknown } | null;
  return value && Number.isInteger(value.line) && Number.isInteger(value.column) ? { line: Number(value.line), column: Number(value.column) } : null;
}

/** Whether a react-markdown `pre` node is a fenced block whose closing fence
 * has been parsed. A closed fence spans its content lines plus the opening and
 * closing fence lines; a fence that is still streaming lacks the closing line
 * (an empty last line, from a chunk ending in a newline, does not count).
 * Indented code blocks never qualify, and nodes without source positions are
 * treated as closed. */
export function codeBlockClosed(value: unknown): boolean {
  const position = asNode(asNode(value)?.position) as { start?: unknown; end?: unknown } | null;
  const start = line(position?.start);
  const end = line(position?.end);
  if (!start || !end) return true;
  const { text } = codeBlockFromHast(value);
  const contentLines = text ? text.split("\n").length - 1 : 0;
  const lastLine = end.column === 1 && end.line > start.line ? end.line - 1 : end.line;
  return lastLine - start.line + 1 >= contentLines + 2;
}
