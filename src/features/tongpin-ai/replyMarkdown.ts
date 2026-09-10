import type { Root, RootContent, Text } from "mdast";

/** Tolerate common model output such as **中文结论。 **, without rewriting
 * stored answers, code blocks, inline code, or deliberately escaped markers. */
export function remarkReplyEmphasis() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    function visit(parent: { children: RootContent[] }) {
      parent.children = parent.children.flatMap(node => {
        if (node.type !== "text") {
          if ("children" in node && node.type !== "linkReference") visit(node as typeof parent);
          return [node];
        }
        const raw = source.slice(node.position?.start.offset, node.position?.end.offset);
        if (raw.includes("\\*")) return [node];
        const parts: RootContent[] = [];
        let end = 0;
        for (const match of node.value.matchAll(/\*\*([^\n*]*?\S)[ \t]*\*\*/g)) {
          if (match.index! > end) parts.push({ type: "text", value: node.value.slice(end, match.index) });
          parts.push({ type: "strong", children: [{ type: "text", value: match[1].trim() } as Text] });
          end = match.index! + match[0].length;
        }
        if (!parts.length) return [node];
        if (end < node.value.length) parts.push({ type: "text", value: node.value.slice(end) });
        return parts;
      });
    }
    visit(tree);
  };
}

/** No model-supplied HTML, data/file/javascript URLs or automatic remote images. */
export function replyUrlTransform(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
