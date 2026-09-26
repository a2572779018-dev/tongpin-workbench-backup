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

/** remark-math treats any `$...$` pair as inline math, so "$5 到 $10" would
 * render "5 到 " as a formula. A `$` directly followed by a plain amount that
 * ends at whitespace, sentence punctuation, a range dash, CJK text or the end (and is not itself
 * closed by `$`, like `$10$`) is escaped to a literal dollar sign. Inline code
 * spans and fenced code/math blocks are left untouched. */
const CURRENCY_OR_CODE = /(`+)[\s\S]*?\1|(?<![\\$])\$(?![\d.,]*\$)(?=\d[\d,]*(?:\.\d+)?(?:[kKmMbB]|万|亿)?(?:[\s\p{Script=Han},.;:!?)，。、；：！？）~～–—]|$))/gu;

export function escapeCurrencyDollars(source: string): string {
  if (!source.includes("$") || /^ {0,3}(?:`{3,}|~{3,}|\${2,})/.test(source)) return source;
  return source.replace(CURRENCY_OR_CODE, match => match === "$" ? "\\$" : match);
}
