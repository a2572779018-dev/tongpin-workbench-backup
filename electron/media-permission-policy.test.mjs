import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  configureMediaPermissions, createMicrophoneAccessRequester, mediaPermissionCheckDecision, mediaPermissionRequestDecision,
  microphoneAccessStatus, microphoneSettingsUrl, registerMicrophoneIpc,
} = require("./media-permission-policy.cjs");

const APP_URL = "file:///Applications/同频.app/Contents/Resources/app.asar/dist/renderer/index.html";
const isAllowedRendererUrl = (url) => url === APP_URL || url === `${APP_URL}#/ai`;
const base = { requestingUrl: APP_URL, isMainFrame: true, fromMainRenderer: true, isAllowedRendererUrl };

describe("media permission decisions", () => {
  it("allows only audio-only media requests from the main renderer's own page", () => {
    expect(mediaPermissionRequestDecision({ ...base, permission: "media", mediaTypes: ["audio"] })).toBe("allow");
    expect(mediaPermissionRequestDecision({ ...base, permission: "media", mediaTypes: ["video"] })).toBe("deny");
    expect(mediaPermissionRequestDecision({ ...base, permission: "media", mediaTypes: ["audio", "video"] })).toBe("deny");
    expect(mediaPermissionRequestDecision({ ...base, permission: "media", mediaTypes: [] })).toBe("deny");
    expect(mediaPermissionRequestDecision({ ...base, permission: "media", mediaTypes: ["audio"], fromMainRenderer: false })).toBe("deny");
    expect(mediaPermissionRequestDecision({ ...base, permission: "media", mediaTypes: ["audio"], requestingUrl: "https://evil.example.com/" })).toBe("deny");
    expect(mediaPermissionRequestDecision({ ...base, permission: "media", mediaTypes: ["audio"], isMainFrame: false })).toBe("deny");
    expect(mediaPermissionRequestDecision({ ...base, permission: "notifications" })).toBe("default");
    expect(mediaPermissionRequestDecision({ ...base, permission: "display-capture" })).toBe("default");
  });

  it("answers synchronous media checks the same way", () => {
    expect(mediaPermissionCheckDecision({ ...base, permission: "media", mediaType: "audio" })).toBe("allow");
    expect(mediaPermissionCheckDecision({ ...base, permission: "media", mediaType: "video" })).toBe("deny");
    expect(mediaPermissionCheckDecision({ ...base, permission: "media", mediaType: "unknown" })).toBe("deny");
    expect(mediaPermissionCheckDecision({ ...base, permission: "media", mediaType: "audio", fromMainRenderer: false })).toBe("deny");
    expect(mediaPermissionCheckDecision({ ...base, permission: "clipboard-sanitized-write" })).toBe("default");
  });

  it("installs session handlers that keep Electron's defaults for every other permission", () => {
    const handlers = {};
    const session = { setPermissionRequestHandler: (handler) => { handlers.request = handler; }, setPermissionCheckHandler: (handler) => { handlers.check = handler; } };
    const main = { getURL: () => APP_URL };
    const other = { getURL: () => "file:///tmp/notice.html" };
    configureMediaPermissions(session, { isMainRendererContents: (contents) => contents === main, isAllowedRendererUrl });
    const request = (contents, permission, details) => { const callback = vi.fn(); handlers.request(contents, permission, callback, details); return callback.mock.calls[0][0]; };
    expect(request(main, "media", { mediaTypes: ["audio"], requestingUrl: `${APP_URL}#/ai`, isMainFrame: true })).toBe(true);
    expect(request(main, "media", { mediaTypes: ["video"], requestingUrl: APP_URL, isMainFrame: true })).toBe(false);
    expect(request(other, "media", { mediaTypes: ["audio"], requestingUrl: "", isMainFrame: true })).toBe(false);
    expect(request(main, "clipboard-sanitized-write", { requestingUrl: APP_URL, isMainFrame: true })).toBe(true);
    expect(request(main, "notifications", { requestingUrl: APP_URL, isMainFrame: true })).toBe(true);
    expect(request(main, "deprecated-sync-clipboard-read", { requestingUrl: APP_URL, isMainFrame: true })).toBe(false);
    expect(handlers.check(main, "media", "file:///", { mediaType: "audio", isMainFrame: true })).toBe(true);
    expect(handlers.check(null, "media", "file:///", { mediaType: "audio", isMainFrame: true })).toBe(false);
    expect(handlers.check(main, "media", "file:///", { mediaType: "video", isMainFrame: true })).toBe(false);
    expect(handlers.check(main, "fullscreen", "file:///", { isMainFrame: true })).toBe(true);
  });
});

describe("microphone access helpers", () => {
  it("reads the system decision on macOS and Windows only", () => {
    const prefs = { getMediaAccessStatus: vi.fn(() => "denied") };
    expect(microphoneAccessStatus(prefs, "darwin")).toBe("denied");
    expect(microphoneAccessStatus(prefs, "win32")).toBe("denied");
    expect(microphoneAccessStatus(prefs, "linux")).toBe("unknown");
    expect(microphoneAccessStatus({ getMediaAccessStatus: () => "weird" }, "darwin")).toBe("unknown");
    expect(microphoneAccessStatus({ getMediaAccessStatus: () => { throw new Error("x"); } }, "win32")).toBe("unknown");
    expect(prefs.getMediaAccessStatus).toHaveBeenCalledWith("microphone");
  });

  it("prompts on macOS once, only while undecided", async () => {
    let status = "not-determined";
    const prefs = { getMediaAccessStatus: vi.fn(() => status), askForMediaAccess: vi.fn(async () => { status = "granted"; return true; }) };
    const request = createMicrophoneAccessRequester(prefs, "darwin");
    expect(await Promise.all([request(), request()])).toEqual(["granted", "granted"]);
    expect(prefs.askForMediaAccess).toHaveBeenCalledTimes(1);
    expect(prefs.askForMediaAccess).toHaveBeenCalledWith("microphone");
    expect(await request()).toBe("granted");
    expect(prefs.askForMediaAccess).toHaveBeenCalledTimes(1);

    status = "not-determined";
    const refused = createMicrophoneAccessRequester({ getMediaAccessStatus: () => status, askForMediaAccess: async () => { status = "denied"; return false; } }, "darwin");
    expect(await refused()).toBe("denied");
    const windows = { getMediaAccessStatus: () => "denied", askForMediaAccess: vi.fn() };
    expect(await createMicrophoneAccessRequester(windows, "win32")()).toBe("denied");
    expect(windows.askForMediaAccess).not.toHaveBeenCalled();
  });

  it("registers sender-checked IPC that opens only the fixed privacy pane", async () => {
    const handlers = new Map();
    const shell = { openExternal: vi.fn(async () => undefined) };
    const assertSender = vi.fn((event) => { if (!event.trusted) throw new Error("untrusted"); });
    registerMicrophoneIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, systemPreferences: { getMediaAccessStatus: () => "granted", askForMediaAccess: vi.fn() }, shell, platform: "darwin", assertSender });
    expect([...handlers.keys()]).toEqual(["microphone:status", "microphone:request", "microphone:open-settings"]);
    expect(await handlers.get("microphone:status")({ trusted: true })).toBe("granted");
    await expect(async () => handlers.get("microphone:request")({ trusted: false })).rejects.toThrow("untrusted");
    expect(await handlers.get("microphone:open-settings")({ trusted: true }, "https://evil.example.com")).toBe(true);
    expect(shell.openExternal).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    expect(microphoneSettingsUrl("win32")).toBe("ms-settings:privacy-microphone");
    expect(microphoneSettingsUrl("linux")).toBeNull();
  });
});

describe("desktop packaging for the microphone", () => {
  it("declares the macOS usage description, audio-input entitlement and the preload bridge", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(packageJson.build.mac.extendInfo.NSMicrophoneUsageDescription).toMatch(/麦克风/);
    for (const file of ["entitlements.mac.plist", "entitlements.mac.inherit.plist"]) {
      const plist = readFileSync(new URL(`../build/${file}`, import.meta.url), "utf8");
      expect(plist).toMatch(/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
    }
    const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
    for (const channel of ["microphone:status", "microphone:request", "microphone:open-settings"]) expect(preload).toContain(channel);
    const main = readFileSync(new URL("./main.cjs", import.meta.url), "utf8");
    expect(main).toContain("registerMicrophoneIpc({ ipcMain, systemPreferences, shell, platform: process.platform, assertSender: assertMainRendererEvent });");
    expect(main).toContain("configureMediaPermissions(electronSession.defaultSession, {");
  });
});
