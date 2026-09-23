import { describe, expect, it } from "vitest";
import { codeBlockFromHast } from "./replyCodeData";

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
});
