type HastNode = { type?: unknown; tagName?: unknown; value?: unknown; children?: unknown; properties?: unknown; className?: unknown };

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
