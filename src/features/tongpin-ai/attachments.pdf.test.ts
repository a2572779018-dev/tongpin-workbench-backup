import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractAttachment } from "./attachments";

const pdf = vi.hoisted(() => ({ pages: [] as string[], destroy: vi.fn(), cleanup: vi.fn(), reject: false, options: {} as Record<string, unknown>, onRead: undefined as (() => void) | undefined }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/assets/local-pdf.worker.mjs" }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: (options: Record<string, unknown>) => {
    pdf.options = options;
    return {
      destroy: pdf.destroy,
      promise: pdf.reject ? Promise.reject(Object.assign(new Error("locked"), { name: "PasswordException" })) : Promise.resolve({
        numPages: pdf.pages.length,
        getPage: async (page: number) => ({
          getTextContent: async () => { pdf.onRead?.(); return { items: [{ str: pdf.pages[page - 1], hasEOL: true }] }; },
          cleanup: pdf.cleanup,
        }),
      }),
    };
  },
}));

const file = () => new File(["%PDF-1.7\nfixture"], "资料.pdf");

describe("PDF text extraction boundaries", () => {
  beforeEach(() => { pdf.pages = []; pdf.destroy.mockReset().mockResolvedValue(undefined); pdf.cleanup.mockReset(); pdf.reject = false; pdf.onRead = undefined; });
  it("extracts only text from local bytes and releases the worker and page resources", async () => {
    pdf.pages = ["第一段", "第二段"];
    const result = await extractAttachment(file());
    expect(result.text).toBe("第一段\n\n第二段");
    expect(result.warnings).toEqual([]);
    expect(pdf.options.data).toBeInstanceOf(Uint8Array);
    expect(pdf.options).not.toHaveProperty("url");
    expect(pdf.options.enableXfa).toBe(false);
    expect(pdf.cleanup).toHaveBeenCalledTimes(2);
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });
  it("explicitly rejects scanned PDF when OCR is unavailable", async () => {
    pdf.pages = ["", "   "];
    await expect(extractAttachment(file())).rejects.toThrow("OCR 尚未接入");
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });
  it("warns when a mixed PDF has pages without extractable text", async () => {
    pdf.pages = ["文字资料", ""];
    expect((await extractAttachment(file())).warnings).toEqual(["1 页没有可提取文字，图片和扫描内容未识别"]);
  });
  it("bounds page count and extracted text without silently truncating", async () => {
    pdf.pages = Array(61).fill("word");
    await expect(extractAttachment(file())).rejects.toThrow("60 页");
    pdf.pages = ["x".repeat(24_001)];
    await expect(extractAttachment(file())).rejects.toThrow("文字过长");
  });
  it("gives an actionable message for a password-protected PDF", async () => {
    pdf.reject = true;
    await expect(extractAttachment(file())).rejects.toThrow("解除密码");
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });
  it("cancels page extraction immediately and destroys the worker exactly once", async () => {
    pdf.pages = ["第一页", "不应继续读取的第二页"];
    const controller = new AbortController();
    pdf.onRead = () => controller.abort();
    await expect(extractAttachment(file(), { signal: controller.signal })).rejects.toHaveProperty("name", "AbortError");
    expect(pdf.cleanup).toHaveBeenCalledOnce();
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });
});
