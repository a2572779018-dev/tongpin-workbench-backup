"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_AI_FILE_BYTES = 96 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".mp4", ".pptx", ".json", ".md", ".csv"]);

function validateAiSaveFilename(value) {
  if (typeof value !== "string" || !value || value.length > 180 || value !== value.trim() ||
    /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(value) || value.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) return null;
  const suffix = path.extname(value).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(suffix) || value.length <= suffix.length) return null;
  return value;
}

function createAiFileSaver({ assertSender, showSaveDialog, downloadsPath }) {
  let pending = false;
  return async (event, input) => {
    assertSender(event);
    const filename = validateAiSaveFilename(input?.filename);
    const buffer = input?.bytes;
    if (!filename || !(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_AI_FILE_BYTES) {
      throw new Error("无效的 AI 文件或文件过大");
    }
    if (pending) return { state: "busy" };
    pending = true;
    try {
      const selected = await showSaveDialog({
        title: "保存同频 AI 文件",
        defaultPath: path.join(downloadsPath(), filename),
        filters: [{ name: "同频 AI 文件", extensions: [path.extname(filename).slice(1).toLowerCase()] }],
        showsOverwriteConfirmation: true,
      });
      if (selected?.canceled || !selected?.filePath) return { state: "cancelled" };
      // The dialog is asynchronous: a navigation or logout may have replaced
      // the trusted main frame while the user was choosing a destination.
      assertSender(event);
      if (typeof selected.filePath !== "string" || !path.isAbsolute(selected.filePath)) throw new Error("无效的保存位置");
      const destination = selected.filePath;
      if (path.extname(destination).toLowerCase() !== path.extname(filename).toLowerCase()) throw new Error("保存文件的扩展名与内容不匹配");
      const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await fs.open(temporary, "wx", 0o600);
        await handle.writeFile(Buffer.from(new Uint8Array(buffer)));
        await handle.sync();
        await handle.close(); handle = undefined;
        await fs.rename(temporary, destination);
      } finally {
        if (handle) await handle.close().catch(() => undefined);
        await fs.unlink(temporary).catch(error => { if (error?.code !== "ENOENT") throw error; });
      }
      return { state: "saved", filePath: destination };
    } finally {
      pending = false;
    }
  };
}

module.exports = { createAiFileSaver, validateAiSaveFilename, MAX_AI_FILE_BYTES };
