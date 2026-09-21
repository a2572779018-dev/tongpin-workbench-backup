import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_DOWNLOAD_FEEDBACK_EVENT, saveBlobWithFeedback } from "./downloadFeedback";

describe("generated file download feedback", () => {
  const click = vi.fn();
  beforeEach(() => {
    const target = new EventTarget();
    vi.stubGlobal("window", Object.assign(target, { setTimeout }));
    vi.stubGlobal("document", {
      body: { append: vi.fn() },
      createElement: vi.fn(() => ({ href: "", download: "", hidden: false, click, remove: vi.fn() })),
    });
  });
  afterEach(() => {
    click.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports a confirmed filename after the chosen file was fully written", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({ write, close }),
    });
    const feedback = vi.fn();
    window.addEventListener(AI_DOWNLOAD_FEEDBACK_EVENT, feedback, { once: true });
    await expect(saveBlobWithFeedback(new Blob(["ok"], { type: "text/plain" }), "结果.txt"))
      .resolves.toMatchObject({ state: "saved", filename: "结果.txt" });
    expect(write).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect((feedback.mock.calls[0][0] as CustomEvent).detail.message).toContain("你选择的位置");
  });

  it("does not claim a browser fallback was saved when only download start is observable", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const result = await saveBlobWithFeedback(new Blob(["ok"]), "result.bin");
    expect(click).toHaveBeenCalledOnce();
    expect(result.state).toBe("started");
    expect(result.message).toContain("浏览器下载记录");
  });

  it("reports cancellation without pretending a file exists", async () => {
    (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn().mockRejectedValue(new DOMException("cancel", "AbortError"));
    await expect(saveBlobWithFeedback(new Blob(["x"]), "x.png")).resolves.toMatchObject({ state: "cancelled" });
  });
});
