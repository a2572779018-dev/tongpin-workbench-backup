import { describe, expect, it } from "vitest";
import { pyLen, pyLower, pyRegex, pySplit, pyStrip, pyTail, wellFormed } from "./pyText";

// Expected values were produced by CPython 3.12 (the reference runtime).
describe("CPython text semantics used by OpenSquilla features", () => {
  it("splits and strips on str.isspace, which differs from JavaScript whitespace", () => {
    expect(pySplit("a\x1cb\x1dc\x85d\u3000e\xa0f\u2028g\ufeffh")).toEqual(["a", "b", "c", "d", "e", "f", "g\ufeffh"]);
    expect(pySplit("  lead  trail  ")).toEqual(["lead", "trail"]);
    expect(pySplit("")).toEqual([]);
    expect(pySplit("\t\n\r\x0b\x0c")).toEqual([]);
    expect(pyStrip("\x1c\x85 hi \u3000\x1f")).toBe("hi");
    expect(pyStrip("\ufeffx\ufeff")).toBe("\ufeffx\ufeff");
  });

  it("lowercases with full mappings and the final-sigma rule, independent of the host engine", () => {
    expect(pyLower("\u03a3\u0391\u03a3 \u039f\u0394\u039f\u03a3")).toBe("\u03c3\u03b1\u03c2 \u03bf\u03b4\u03bf\u03c2");
    expect(pyLower("\u0130stanbul")).toBe("i\u0307stanbul");
    expect(pyLower("\u1e9e \u01c5 \u2167 \uff21\uff22\uff23")).toBe("\u00df \u01c6 \u2177 \uff41\uff42\uff43");
    expect(pyLower("\u038c\u03a3\u039f\u03a3.")).toBe("\u03cc\u03c3\u03bf\u03c2.");
    expect(pyLower("A\u03a3")).toBe("a\u03c2");
    expect(pyLower("\u03a3")).toBe("\u03c3");
  });

  it("counts and slices code points, not UTF-16 units", () => {
    expect(pyLen("\u{1f600}\u{20000}a")).toBe(3);
    expect(pyLen("\u{1f468}\u200d\u{1f469}\u200d\u{1f467}")).toBe(5);
    expect(pyTail("ab\u{1f600}c", 2)).toBe("\u{1f600}c");
    expect(wellFormed("a\ud800b\udc00c\u{1f600}")).toBe("a\ufffdb\ufffdc\u{1f600}");
  });

  it("translates CPython regex classes, dot and MULTILINE anchors exactly", () => {
    const all = (source: string, text: string, flags: Parameters<typeof pyRegex>[1] = {}) => [...text.matchAll(pyRegex(source, { ...flags, global: true }))].map(match => match[0]);
    // `.` excludes only \n in CPython (JavaScript also excludes \r, U+2028, U+2029).
    expect(all("a.b", "a\rb")).toEqual(["a\rb"]);
    expect(all("a.b", "a\nb")).toEqual([]);
    expect(all("a.b", "a\u2028b")).toEqual(["a\u2028b"]);
    // \d and \w are Unicode-aware.
    expect(all("\\d+", "\uff11\uff12\uff13")).toEqual(["\uff11\uff12\uff13"]);
    expect(all("\\d+", "\u0662\u0660\u0662\u0666")).toEqual(["\u0662\u0660\u0662\u0666"]);
    expect(all("[\\w]+", "na\u00efve_\u540d\u5b57\uff11")).toEqual(["na\u00efve_\u540d\u5b57\uff11"]);
    expect(all("[\\w]+", "a-b")).toEqual(["a", "b"]);
    // \s follows str.isspace: U+001C and U+0085 are spaces, U+FEFF is not.
    expect(all("x\\sy", "x\x1cy")).toEqual(["x\x1cy"]);
    expect(all("x\\sy", "x\ufeffy")).toEqual([]);
    expect(all("x\\sy", "x\u3000y")).toEqual(["x\u3000y"]);
    expect(all("x\\sy", "x\x85y")).toEqual(["x\x85y"]);
    // MULTILINE ^ starts a line only after \n.
    const numbered = (text: string) => all("^\\d+[.)]\\s", text, { multiline: true }).length;
    expect(numbered("1. a\n2. b")).toBe(2);
    expect(numbered("1. a\r2. b")).toBe(1);
    expect(numbered("x\u20281. y")).toBe(0);
    // Escaped punctuation is literal, as in CPython.
    expect(pyRegex("\\.py\\\", line \\d+").test("app.py\", line 12")).toBe(true);
  });
});
