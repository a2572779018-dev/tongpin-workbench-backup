"use strict";

/**
 * Microphone access for 同频 AI voice input.
 *
 * - Chromium "media" permission: only an audio-only request from the main
 *   window's own renderer page (main frame) is allowed. Camera, screen and any
 *   other window, frame or origin are denied.
 * - Every other permission keeps Electron's implicit default (granted, except
 *   the deprecated synchronous clipboard read), so installing these handlers
 *   does not change clipboard, notification or fullscreen behaviour.
 * - macOS: the system prompt is shown by askForMediaAccess() only after the
 *   member presses the microphone button, and only while the decision is
 *   still open. Windows exposes the system switch through the same status.
 */

const MICROPHONE_SETTINGS_URLS = Object.freeze({
  darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  win32: "ms-settings:privacy-microphone",
});
const ACCESS_STATUSES = new Set(["granted", "denied", "restricted", "not-determined", "unknown"]);

function normalizeMediaAccessStatus(value) {
  return ACCESS_STATUSES.has(value) ? value : "unknown";
}

function microphoneAccessStatus(systemPreferences, platform) {
  if (platform !== "darwin" && platform !== "win32") return "unknown";
  try {
    return normalizeMediaAccessStatus(systemPreferences.getMediaAccessStatus("microphone"));
  } catch {
    return "unknown";
  }
}

/** One in-flight system prompt at a time; never prompts once a decision exists. */
function createMicrophoneAccessRequester(systemPreferences, platform) {
  let pending = null;
  return async function requestMicrophoneAccess() {
    const current = microphoneAccessStatus(systemPreferences, platform);
    if (platform !== "darwin" || current !== "not-determined") return current;
    pending ??= Promise.resolve()
      .then(() => systemPreferences.askForMediaAccess("microphone"))
      .then(
        (granted) => granted === true ? "granted" : microphoneAccessStatus(systemPreferences, platform) === "restricted" ? "restricted" : "denied",
        () => "unknown",
      )
      .finally(() => { pending = null; });
    return pending;
  };
}

function microphoneSettingsUrl(platform) {
  return MICROPHONE_SETTINGS_URLS[platform] ?? null;
}

function electronDefaultPermission(permission) {
  return permission !== "deprecated-sync-clipboard-read";
}

/** "allow" | "deny" | "default" for a Chromium permission request. */
function mediaPermissionRequestDecision({ permission, mediaTypes, requestingUrl, isMainFrame, fromMainRenderer, isAllowedRendererUrl }) {
  if (permission !== "media") return "default";
  if (!fromMainRenderer || isMainFrame === false || !isAllowedRendererUrl(requestingUrl)) return "deny";
  const types = Array.isArray(mediaTypes) ? mediaTypes : [];
  return types.length > 0 && types.every((type) => type === "audio") ? "allow" : "deny";
}

/** "allow" | "deny" | "default" for a synchronous Chromium permission check. */
function mediaPermissionCheckDecision({ permission, mediaType, requestingUrl, isMainFrame, fromMainRenderer, isAllowedRendererUrl }) {
  if (permission !== "media") return "default";
  if (!fromMainRenderer || isMainFrame === false || !isAllowedRendererUrl(requestingUrl)) return "deny";
  return mediaType === "audio" ? "allow" : "deny";
}

function configureMediaPermissions(targetSession, { isMainRendererContents, isAllowedRendererUrl }) {
  targetSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    let requestingUrl = details?.requestingUrl;
    try { requestingUrl ||= contents?.getURL?.(); } catch { requestingUrl = ""; }
    const decision = mediaPermissionRequestDecision({
      permission, mediaTypes: details?.mediaTypes, requestingUrl, isMainFrame: details?.isMainFrame,
      fromMainRenderer: isMainRendererContents(contents), isAllowedRendererUrl,
    });
    callback(decision === "default" ? electronDefaultPermission(permission) : decision === "allow");
  });
  targetSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    let requestingUrl = details?.requestingUrl;
    try { requestingUrl ||= contents?.getURL?.() || requestingOrigin; } catch { requestingUrl = requestingOrigin; }
    const decision = mediaPermissionCheckDecision({
      permission, mediaType: details?.mediaType, requestingUrl, isMainFrame: details?.isMainFrame,
      fromMainRenderer: isMainRendererContents(contents), isAllowedRendererUrl,
    });
    return decision === "default" ? electronDefaultPermission(permission) : decision === "allow";
  });
}

function registerMicrophoneIpc({ ipcMain, systemPreferences, shell, platform, assertSender }) {
  const requestAccess = createMicrophoneAccessRequester(systemPreferences, platform);
  ipcMain.handle("microphone:status", (event) => {
    assertSender(event);
    return microphoneAccessStatus(systemPreferences, platform);
  });
  ipcMain.handle("microphone:request", async (event) => {
    assertSender(event);
    return requestAccess();
  });
  // Fixed destination only; nothing is granted from here.
  ipcMain.handle("microphone:open-settings", async (event) => {
    assertSender(event);
    const target = microphoneSettingsUrl(platform);
    if (!target) return false;
    await shell.openExternal(target);
    return true;
  });
}

module.exports = {
  MICROPHONE_SETTINGS_URLS,
  configureMediaPermissions,
  createMicrophoneAccessRequester,
  mediaPermissionCheckDecision,
  mediaPermissionRequestDecision,
  microphoneAccessStatus,
  microphoneSettingsUrl,
  registerMicrophoneIpc,
};
