import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
type SaveResult = { state: "saved"; filePath: string } | { state: "cancelled" } | { state: "busy" };
const { createAiFileSaver, validateAiSaveFilename }: {
  createAiFileSaver(options: {
    assertSender(event: unknown): void;
    showSaveDialog(options: { defaultPath: string; title: string }): Promise<{ canceled: boolean; filePath?: string }>;
    downloadsPath(): string;
  }): (event: unknown, input: unknown) => Promise<SaveResult>;
  validateAiSaveFilename(value: unknown): string | null;
} = require("../../electron/ai-file-save.cjs");

describe("AI desktop file save boundary", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });
  async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "tongpin-ai-save-"));
    directories.push(directory);
    const chosen = path.join(directory, "chosen.mp4");
    const assertSender = vi.fn((_event: unknown) => undefined);
    const showSaveDialog = vi.fn(async (_options: { defaultPath: string; title: string }): Promise<{ canceled: boolean; filePath?: string }> => ({ canceled: false, filePath: chosen }));
    const downloadsPath = vi.fn(() => directory);
    const save = createAiFileSaver({ assertSender, showSaveDialog, downloadsPath });
    return { directory, chosen, assertSender, showSaveDialog, downloadsPath, save };
  }
  const bytes = () => Uint8Array.from([0, 1, 2, 255]).buffer;

  it.each(["../secret.mp4", "folder/a.png", "folder\\a.png", ".mp4", "CON.mp4", "movie.exe", "a.mp4 ", "a\n.mp4", "a".repeat(200) + ".mp4", null, {}])("rejects untrusted filename %s before opening a dialog", async filename => {
    expect(validateAiSaveFilename(filename)).toBeNull();
    const f = await fixture();
    await expect(f.save({}, { filename, bytes: bytes() })).rejects.toThrow();
    expect(f.showSaveDialog).not.toHaveBeenCalled();
  });

  it("requires a trusted main renderer and an ArrayBuffer within the size limit", async () => {
    const f = await fixture();
    f.assertSender.mockImplementationOnce(() => { throw new Error("blocked"); });
    await expect(f.save({}, { filename: "movie.mp4", bytes: bytes() })).rejects.toThrow("blocked");
    await expect(f.save({}, { filename: "movie.mp4", bytes: Uint8Array.from([1, 2]) })).rejects.toThrow();
    await expect(f.save({}, { filename: "movie.mp4", bytes: new ArrayBuffer(97 * 1024 * 1024) })).rejects.toThrow();
    expect(f.showSaveDialog).not.toHaveBeenCalled();
  });

  it("writes only to the user-selected path, atomically, before reporting saved", async () => {
    const f = await fixture();
    await writeFile(f.chosen, "old");
    await expect(f.save({}, { filename: "同频视频.mp4", bytes: bytes(), filePath: path.join(f.directory, "untrusted.mp4") }))
      .resolves.toEqual({ state: "saved", filePath: f.chosen });
    expect(f.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: path.join(f.directory, "同频视频.mp4") }));
    expect(f.assertSender).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(await readFile(f.chosen))).toEqual(new Uint8Array(bytes()));
  });

  it("returns cancelled without writing and rechecks the sender after the dialog", async () => {
    const f = await fixture();
    f.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: undefined });
    await expect(f.save({}, { filename: "movie.mp4", bytes: bytes() })).resolves.toEqual({ state: "cancelled" });
    await expect(readFile(f.chosen)).rejects.toMatchObject({ code: "ENOENT" });
    f.assertSender.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error("sender changed"); });
    await expect(f.save({}, { filename: "movie.mp4", bytes: bytes() })).rejects.toThrow("sender changed");
    await expect(readFile(f.chosen)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not start two native dialogs concurrently and releases the lock on OS error", async () => {
    const f = await fixture();
    let resolveDialog!: (value: { canceled: boolean; filePath?: string }) => void;
    f.showSaveDialog.mockImplementationOnce(() => new Promise(resolve => { resolveDialog = resolve; }));
    const first = f.save({}, { filename: "movie.mp4", bytes: bytes() });
    await expect(f.save({}, { filename: "other.mp4", bytes: bytes() })).resolves.toEqual({ state: "busy" });
    resolveDialog({ canceled: true });
    await expect(first).resolves.toEqual({ state: "cancelled" });
    f.showSaveDialog.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.save({}, { filename: "movie.mp4", bytes: bytes() })).rejects.toThrow("disk unavailable");
    await expect(f.save({}, { filename: "movie.mp4", bytes: bytes() })).resolves.toMatchObject({ state: "saved" });
  });

  it("does not report saved or leave a temporary file when the selected destination cannot be replaced", async () => {
    const f = await fixture();
    const targetDirectory = path.join(f.directory, "target.mp4");
    await mkdir(targetDirectory);
    f.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: targetDirectory });
    await expect(f.save({}, { filename: "movie.mp4", bytes: bytes() })).rejects.toThrow();
    expect(await readdir(f.directory)).toEqual(["target.mp4"]);
  });

  it("refuses a selected executable name even though the file picker supplied the path", async () => {
    const f = await fixture();
    f.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: path.join(f.directory, "movie.exe") });
    await expect(f.save({}, { filename: "movie.mp4", bytes: bytes() })).rejects.toThrow("扩展名");
    expect(await readdir(f.directory)).toEqual([]);
  });

  it("uses a dedicated, frame-checked Electron IPC and preload bridge", () => {
    const main = readFileSync(new URL("../../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../../electron/preload.cjs", import.meta.url), "utf8");
    expect(main).toContain('ipcMain.handle("ai-file:save", createAiFileSaver({');
    expect(main).toContain("assertSender: assertMainRendererEvent");
    expect(preload).toContain('ipcRenderer.invoke("ai-file:save", input)');
  });
});
