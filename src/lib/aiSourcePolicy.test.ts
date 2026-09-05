import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
type Result = "opened" | "cancelled" | "blocked" | "failed" | "busy";
const { validateAiSourceUrl, createAiSourceOpener }: {
  validateAiSourceUrl(value: unknown): string | null;
  createAiSourceOpener(options: { isAllowedSender(event: unknown): boolean; confirmOpen(url: string): Promise<boolean>; openExternal(url: string): Promise<void> }): (event: unknown, url: unknown) => Promise<Result>;
} = require("../../electron/ai-source-policy.cjs");

describe("AI citation desktop boundary", () => {
  it.each(["https://example.com/article?q=tongpin#sources", "http://example.com/reference", "https://www.example.com:443/报告"])("accepts a public HTTP(S) reference: %s", value => {
    expect(validateAiSourceUrl(value)).toBe(new URL(value).href);
  });

  it.each([null, {}, "", "javascript:alert(1)", "file:///tmp/document", "data:text/html,test", "blob:https://example.com/id", "mailto:a@example.com", "https://user:password@example.com", "https://user@example.com", "https://localhost", "http://127.0.0.1", "https://0x7f000001", "https://[::1]", "https://10.0.0.1", "https://169.254.169.254", "https://host.internal", "https://example.test", "https://example.com:8443", "https://example.com\\@evil.com", "https://exam\nple.com", "https://example.com/%0d%0a", `https://example.com/${"a".repeat(2100)}`])("blocks unsafe input without invoking the OS: %s", value => {
    expect(validateAiSourceUrl(value)).toBeNull();
  });

  function fixture() {
    const isAllowedSender = vi.fn(() => true);
    const confirmOpen = vi.fn(async () => true);
    const openExternal = vi.fn(async (_url: string) => {});
    return { isAllowedSender, confirmOpen, openExternal, open: createAiSourceOpener({ isAllowedSender, confirmOpen, openExternal }) };
  }

  it("requires the trusted main frame and a valid URL before showing confirmation", async () => {
    const f = fixture();
    f.isAllowedSender.mockReturnValue(false);
    expect(await f.open({}, "https://example.com")).toBe("blocked");
    f.isAllowedSender.mockReturnValue(true);
    expect(await f.open({}, "file:///tmp/file")).toBe("blocked");
    expect(f.confirmOpen).not.toHaveBeenCalled();
    expect(f.openExternal).not.toHaveBeenCalled();
  });

  it("opens only after confirmation and does not pass renderer-provided OS options", async () => {
    const f = fixture();
    expect(await f.open({}, "https://example.com")).toBe("opened");
    expect(f.confirmOpen).toHaveBeenCalledWith("https://example.com/");
    expect(f.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/");
    expect(f.isAllowedSender).toHaveBeenCalledTimes(2);
  });

  it("treats cancellation as a normal result and rechecks sender after the dialog", async () => {
    const f = fixture();
    f.confirmOpen.mockResolvedValueOnce(false);
    expect(await f.open({}, "https://example.com")).toBe("cancelled");
    f.isAllowedSender.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await f.open({}, "https://example.com")).toBe("blocked");
    expect(f.openExternal).not.toHaveBeenCalled();
  });

  it("suppresses concurrent dialogs and recovers from OS failures", async () => {
    const f = fixture();
    let confirm!: (value: boolean) => void;
    f.confirmOpen.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    const first = f.open({}, "https://example.com");
    expect(await f.open({}, "https://other.example.com")).toBe("busy");
    confirm(true);
    expect(await first).toBe("opened");
    f.openExternal.mockRejectedValueOnce(new Error("OS refused"));
    expect(await f.open({}, "https://example.com")).toBe("failed");
    expect(await f.open({}, "https://example.com")).toBe("opened");
  });

  it("wires a dedicated IPC without widening the original LORA popup policy", () => {
    const main = readFileSync(new URL("../../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../../electron/preload.cjs", import.meta.url), "utf8");
    const link = readFileSync(new URL("../features/tongpin-ai/AiSourceLink.tsx", import.meta.url), "utf8");
    const popup = main.slice(main.indexOf('mainWindow.webContents.setWindowOpenHandler'), main.indexOf('mainWindow.webContents.on("will-navigate"'));
    expect(popup).toContain("validateLoraExplorerUrl(url)");
    expect(popup).toContain('return { action: "deny" }');
    expect(popup).not.toContain("validateAiSourceUrl");
    expect(main).toContain('ipcMain.handle("ai-source:open", createAiSourceOpener({');
    expect(main).toContain("isAllowedSender: isMainRendererEvent");
    expect(preload).toContain('ipcRenderer.invoke("ai-source:open", url)');
    expect(link).toContain("window.tongpin.openAiSource(url.href)");
    expect(link).toContain('rel="noopener noreferrer"');
  });
});
