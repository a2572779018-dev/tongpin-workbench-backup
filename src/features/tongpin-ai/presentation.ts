import { saveBlobWithFeedback } from "./downloadFeedback";

/** Serializable slide content; all visible content becomes editable PowerPoint text. */
export interface PresentationDocument {
  title: string;
  subtitle?: string;
  slides: Array<{ title: string; bullets: string[]; notes?: string }>;
}

export const PRESENTATION_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const MAX_PRESENTATION_SLIDES = 30;

function text(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`${label}格式不正确`);
  return value.trim();
}

export function validatePresentation(value: unknown): PresentationDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PPT 内容不是有效的结构化数据");
  const document = value as Record<string, unknown>;
  const title = text(document.title, "PPT 标题", 160);
  const subtitle = document.subtitle === undefined ? undefined : text(document.subtitle, "PPT 副标题", 500, true);
  if (!Array.isArray(document.slides) || !document.slides.length || document.slides.length > MAX_PRESENTATION_SLIDES) throw new Error("PPT 需要包含 1 到 30 页");
  const slides = document.slides.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`第 ${index + 1} 页结构不正确`);
    const slide = value as Record<string, unknown>;
    if (!Array.isArray(slide.bullets) || slide.bullets.length > 8) throw new Error(`第 ${index + 1} 页最多 8 个要点`);
    return {
      title: text(slide.title, `第 ${index + 1} 页标题`, 160),
      bullets: slide.bullets.map((bullet, point) => text(bullet, `第 ${index + 1} 页要点 ${point + 1}`, 500)),
      ...(slide.notes === undefined ? {} : { notes: text(slide.notes, `第 ${index + 1} 页备注`, 2_000, true) }),
    };
  });
  return { title, ...(subtitle === undefined ? {} : { subtitle }), slides };
}

/** Only a complete JSON document is accepted, never evaluated JavaScript or arbitrary prose. */
export function parsePresentationJson(source: string): PresentationDocument {
  if (source.length > 160_000) throw new Error("PPT 内容过大");
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(source);
  try { return validatePresentation(JSON.parse(match ? match[1] : source)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("PPT 返回内容不是有效的 JSON，请重新生成");
    throw error;
  }
}

const displayWidth = (value: string) => Array.from(value).reduce((sum, character) => sum + (/^[\x20-\x7e]$/.test(character) ? 0.55 : 1), 0);

/** Reject an overcrowded slide instead of silently deleting text or exporting microscopic type. */
export function slideFontSizes(slide: PresentationDocument["slides"][number]): { title: number; body: number } {
  const title = [32, 30, 28, 26, 24].find(size => Math.ceil(displayWidth(slide.title) / (11.8 * 72 / size)) * size * 1.25 <= 1.65 * 72);
  const body = [22, 21, 20, 19, 18, 17].find(size => {
    const lines = slide.bullets.reduce((sum, bullet) => sum + bullet.split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(displayWidth(line) / (11.5 * 72 / size))), 0), 0);
    return lines * size * 1.3 + slide.bullets.length * 10 <= 4.45 * 72;
  });
  if (!title || !body) throw new Error(`“${slide.title.slice(0, 24)}”内容过密，请让 AI 精简这一页后再导出`);
  return { title, body };
}

export function presentationFileName(title: string): string {
  const safe = title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 80);
  return `${safe || "同频 AI 演示文稿"}.pptx`;
}

export async function createPresentationBytes(value: unknown): Promise<Uint8Array> {
  const document = validatePresentation(value);
  const sizes = document.slides.map(slideFontSizes);
  // Do not load the export library while users are simply chatting.
  const { default: PptxGenJS } = await import("pptxgenjs");
  const presentation = new PptxGenJS();
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "同频 AI";
  presentation.subject = document.subtitle || document.title;
  presentation.title = document.title;
  presentation.company = "同频";
  presentation.theme = { headFontFace: "Microsoft YaHei", bodyFontFace: "Microsoft YaHei" };
  document.slides.forEach((content, index) => {
    const slide = presentation.addSlide();
    slide.background = { color: index === 0 ? "F1D974" : "FFF9EE" };
    slide.addText(content.title, { x: 0.7, y: 0.45, w: 11.9, h: 1.65, fontFace: "Microsoft YaHei", fontSize: sizes[index].title, bold: true, color: "20211E", margin: 0, breakLine: false, valign: "middle", lang: "zh-CN" });
    if (content.bullets.length) {
      slide.addText(content.bullets.map(bullet => ({ text: bullet, options: { bullet: { indent: sizes[index].body }, hanging: 4, breakLine: true } })), {
        x: 0.85, y: 2.22, w: 11.55, h: 4.45, fontFace: "Microsoft YaHei", fontSize: sizes[index].body,
        color: "30322D", margin: 0, paraSpaceAfter: 10, valign: "top", lineSpacingMultiple: 1.2, lang: "zh-CN",
      });
    }
    slide.addText(`${index + 1} / ${document.slides.length}`, { x: 11.85, y: 7.02, w: 0.8, h: 0.2, fontSize: 11, color: "62645D", align: "right", margin: 0 });
    if (content.notes) slide.addNotes(content.notes);
  });
  const output = await presentation.write({ outputType: "arraybuffer", compression: true });
  if (!(output instanceof ArrayBuffer)) throw new Error("PPTX 导出失败，请重试");
  return new Uint8Array(output);
}

export async function downloadPresentation(value: unknown): Promise<void> {
  const document = validatePresentation(value);
  const bytes = await createPresentationBytes(document);
  const result = await saveBlobWithFeedback(new Blob([new Uint8Array(bytes)], { type: PRESENTATION_MIME }), presentationFileName(document.title));
  if (result.state === "error") throw new Error(result.message);
}
