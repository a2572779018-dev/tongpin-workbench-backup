import { describe, expect, it } from "vitest";
import { codeBlockClosed, codeBlockFromHast } from "./replyCodeData";

describe("reply code block data", () => {
  it("preserves code whitespace and a safe language label", () => {
    expect(codeBlockFromHast({ type: "element", tagName: "pre", children: [
      { type: "element", tagName: "code", properties: { className: ["language-ts"] }, children: [
        { type: "text", value: "  const x = 1;\n\n" },
      ] },
    ] })).toEqual({ text: "  const x = 1;\n\n", language: "ts" });
  });

  it("does not treat arbitrary markup or language metadata as executable content", () => {
    expect(codeBlockFromHast({ type: "element", tagName: "pre", children: [
      { type: "element", tagName: "code", properties: { className: ["language-<script>"] }, children: [
        { type: "text", value: "<script>alert(1)</script>" },
      ] },
    ] })).toEqual({ text: "<script>alert(1)</script>", language: "" });
    expect(codeBlockFromHast({ type: "element", tagName: "div", children: [] })).toEqual({ text: "", language: "" });
  });

  it("tells a closed fence from one whose closing line has not streamed in yet", () => {
    const pre = (text: string, end?: { line: number; column: number }) => ({ type: "element", tagName: "pre",
      ...(end ? { position: { start: { line: 3, column: 1 }, end } } : {}),
      children: [{ type: "element", tagName: "code", properties: { className: ["language-ts"] }, children: [{ type: "text", value: text }] }] });
    // ```ts / a / ``` : the closing fence ends on line 5.
    expect(codeBlockClosed(pre("a\n", { line: 5, column: 4 }))).toBe(true);
    // ```ts / a  (stream stopped mid-line or right after the newline)
    expect(codeBlockClosed(pre("a\n", { line: 4, column: 2 }))).toBe(false);
    expect(codeBlockClosed(pre("a\n", { line: 5, column: 1 }))).toBe(false);
    // Empty closed fence, and an empty fence still waiting for content.
    expect(codeBlockClosed(pre("", { line: 4, column: 4 }))).toBe(true);
    expect(codeBlockClosed(pre("", { line: 3, column: 6 }))).toBe(false);
    // An indented code block (no fences) never counts as a closed fence.
    expect(codeBlockClosed(pre("a\nb\n", { line: 4, column: 6 }))).toBe(false);
    // Without source positions nothing can be inferred: treat as settled.
    expect(codeBlockClosed(pre("a\n"))).toBe(true);
  });
});
