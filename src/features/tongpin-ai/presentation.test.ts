import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPresentationBytes, parsePresentationJson, presentationFileName, slideFontSizes, validatePresentation } from "./presentation";

const document = { title: "客户提案", subtitle: "同频", slides: [
  { title: "需求与目标", bullets: ["保留中文内容", "每一个文本框都可以编辑"], notes: "演讲者备注与材料来源" },
  { title: "下一步安排", bullets: ["先确认范围", "再安排成员验收"] },
] };

describe("editable PPTX export", () => {
  it("strictly validates structured content and rejects eval-like or malformed input", () => {
    expect(parsePresentationJson("```json\n" + JSON.stringify(document) + "\n```")).toEqual(document);
    expect(() => parsePresentationJson("require('fs').readFileSync('secret')")).toThrow("JSON");
    expect(() => validatePresentation({ ...document, slides: [] })).toThrow("1 到 30");
    expect(() => validatePresentation({ ...document, slides: Array(31).fill(document.slides[0]) })).toThrow("30");
    expect(() => validatePresentation({ ...document, slides: [{ title: "x", bullets: Array(9).fill("x") }] })).toThrow("8");
    expect(() => validatePresentation({ ...document, slides: [{ title: "x", bullets: ["x".repeat(501)] }] })).toThrow("要点");
  });
  it("creates a real ZIP-based PPTX with native editable text, slide count and notes intact", async () => {
    const bytes = await createPresentationBytes(document);
    expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    const slides = zip.file(/^ppt\/slides\/slide\d+\.xml$/);
    expect(slides).toHaveLength(2);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(xml).toContain("<p:txBody>");
    expect(xml).toContain("保留中文内容");
    expect(xml).toContain("每一个文本框都可以编辑");
    expect(xml).not.toContain("<p:pic>");
    expect(await zip.file("ppt/notesSlides/notesSlide1.xml")!.async("string")).toContain("演讲者备注与材料来源");
  });
  it("avoids unreadable content overflow and strips unsafe filename characters", () => {
    expect(slideFontSizes(document.slides[0]).body).toBeGreaterThanOrEqual(17);
    expect(() => slideFontSizes({ title: "过密", bullets: Array(8).fill("中".repeat(500)) })).toThrow("内容过密");
    expect(() => slideFontSizes({ title: "过密", bullets: ["一\n".repeat(100)] })).toThrow("内容过密");
    expect(presentationFileName('../秘密:提案/示例')).toBe('.._秘密_提案_示例.pptx');
  });
  it("does not accept image inputs into the PPTX image parser dependency", () => {
    const value = { ...document, images: [{ path: "https://example.com/untrusted.icns" }], slides: document.slides.map(slide => ({ ...slide, image: "data:image/heif;base64,AAAA" })) };
    expect(validatePresentation(value)).toEqual(document);
    const source = readFileSync(new URL("./presentation.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.(?:addImage|addMedia|imageSizingCrop|imageSizingContain)\s*\(/);
  });
});
