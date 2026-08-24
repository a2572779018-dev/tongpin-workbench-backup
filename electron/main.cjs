const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  powerMonitor,
  safeStorage,
  screen,
  shell,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const {
  createUpdateInstallCoordinator,
} = require("./update-install-coordinator.cjs");
const {
  shouldInstallSilently,
} = require("./silent-update-policy.cjs");
const {
  classifyUpdateError,
  getUpdateRetryDelayMs,
  shouldShowUpdateError,
} = require("./update-error-policy.cjs");
const {
  DEFAULT_NOTIFICATION_SOUND_DEDUP_MS,
  shouldPlayNotificationSound,
} = require("./notification-sound-policy.cjs");
const { normalizeReleaseNotes } = require("./release-notes.cjs");
const {
  buildLoraExplorerUrl,
  validateLoraExplorerUrl,
} = require("./lora-explorer-policy.cjs");
const {
  normalizeDesktopNoticeAction,
} = require("./desktop-notice-action-policy.cjs");
const {
  normalizeDesktopNoticePayload,
} = require("./desktop-notice-policy.cjs");
const {
  expandBounds,
  getCornerWindowBounds,
  getHotCornerTriggerBounds,
  getQuickPanelBounds,
  normalizeQuickTaskCommand,
  pointInBounds,
  shouldSuppressMainActivation,
} = require("./quick-task-policy.cjs");

autoUpdater.logger = null;

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const isMac = process.platform === "darwin";
const isQuickTaskPreview =
  isDevelopment && process.env.TONGPIN_QUICK_PANEL_PREVIEW === "1";
const quickTaskPreviewTarget =
  process.env.TONGPIN_QUICK_PREVIEW_TARGET === "corner" ? "corner" : "panel";
const SESSION_FILE_NAME = "secure-session.bin";
const CREDENTIAL_VAULT_FILE_NAME = "secure-accounts.bin";
const MAX_CREDENTIAL_ACCOUNTS = 20;
const APP_ICON_PATH = path.join(__dirname, "..", "build", "icon.ico");
const NOTICE_COLLAPSED_SIZE = { width: 82, height: 82 };
const NOTICE_EXPANDED_SIZE = { width: 430, height: 178 };
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const SILENT_INSTALL_CHECK_INTERVAL_MS = 60 * 1000;
const UPDATE_TEMP_DIR_NAME = ".tongpin-updater-temp";
const UPDATE_INSTALL_FAILURE_MARKER_NAME = "updater-install-failed";
const UPDATER_ERROR_DEDUP_WINDOW_MS = 2_000;
const QUICK_CORNER_SIZE = 54;
const QUICK_TRIGGER_SIZE = 12;
const QUICK_PANEL_SIZE = { width: 380, height: 500 };
const QUICK_CORNER_DWELL_MS = 150;
const QUICK_CORNER_LEAVE_MS = 250;
const QUICK_CORNER_POLL_MS = 80;
const QUICK_TASK_REQUEST_TIMEOUT_MS = 12_000;
let mainWindow = null;
let noticeWindow = null;
let quickCornerWindow = null;
let quickPanelWindow = null;
let noticeHideTimer = null;
let activeNoticeId = "";
let activeNoticeRequiresAcknowledgement = false;
let activeNoticeAction = null;
let updateReady = false;
let updateInstallInProgress = false;
let quickTasksAvailable = false;
let quickTasksSuspended = false;
let quickCornerPollTimer = null;
let quickCornerShowTimer = null;
let quickCornerHideTimer = null;
let quickPanelActivationSuppressedUntil = 0;
const pendingQuickTaskRequests = new Map();
const recentNoticeSounds = new Map();

function prepareSameVolumeUpdaterTemp() {
  if (process.platform !== "win32") return null;

  const executableRoot = path.parse(process.execPath).root.toLowerCase();
  const installParent = path.dirname(path.dirname(process.execPath));
  const candidates = [
    path.join(installParent, UPDATE_TEMP_DIR_NAME),
    path.join(path.parse(process.execPath).root, "TongpinUpdaterTemp"),
  ];

  let lastError = null;
  for (const candidate of candidates) {
    if (path.parse(candidate).root.toLowerCase() !== executableRoot) continue;
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      process.env.TEMP = candidate;
      process.env.TMP = candidate;
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("No writable updater temp directory found.");
}

const updateInstallCoordinator = createUpdateInstallCoordinator({
  app,
  updater: autoUpdater,
  platform: process.platform,
  prepareInstallerEnvironment: prepareSameVolumeUpdaterTemp,
  closeAuxiliaryWindows: () => {
    clearNoticeHideTimer();
    if (noticeWindow && !noticeWindow.isDestroyed()) {
      noticeWindow.destroy();
    }
    destroyQuickTaskWindows();
  },
  onInstallError: handleUpdaterInstallError,
  onDeferredInstallError: persistUpdateInstallFailureMarker,
});

function requestSilentInstallIfEligible(now = new Date()) {
  let idleSeconds = 0;
  try {
    idleSeconds = powerMonitor.getSystemIdleTime();
  } catch {
    return false;
  }
  if (
    !shouldInstallSilently({
      updateReady,
      installRequested: updateInstallCoordinator.isInstallRequested(),
      now,
      idleSeconds,
    })
  ) {
    return false;
  }
  updateInstallInProgress = true;
  let started = false;
  try {
    started = updateInstallCoordinator.requestInstall();
  } catch {
    started = false;
  }
  if (!started) {
    updateInstallInProgress = false;
    sendUpdaterInstallError();
  }
  return started;
}

app.on("before-quit", () => {
  if (process.platform !== "win32") return;
  if (!updateReady || updateInstallCoordinator.isInstallRequested()) return;
  try {
    prepareSameVolumeUpdaterTemp();
    updateInstallInProgress = true;
  } catch {
    updateInstallInProgress = false;
    autoUpdater.autoInstallOnAppQuit = false;
    console.error("[updater] Automatic install on quit was disabled.");
    sendUpdaterInstallError();
    persistUpdateInstallFailureMarker();
  }
});

function readPackagedConfig() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, "app-config.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

function getApiUrl() {
  if (process.env.TONGPIN_API_URL) return process.env.TONGPIN_API_URL;
  if (isDevelopment) return "http://127.0.0.1:4318";
  return (
    readPackagedConfig().apiUrl ||
    "https://notify.samhubs.com"
  );
}

function sendUpdaterStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send("updater:status", status);
      return true;
    } catch {
      console.error("[updater] renderer-status-send-failed");
    }
  }
  return false;
}

function sendUpdaterInstallError() {
  return sendUpdaterStatus({
    state: "error",
    errorKind: "install",
    message: "更新安装未完成，请稍后重试。",
  });
}

function handleUpdaterInstallError() {
  updateInstallInProgress = false;
  return sendUpdaterInstallError();
}

function getUpdateInstallFailureMarkerPath() {
  return path.join(app.getPath("userData"), UPDATE_INSTALL_FAILURE_MARKER_NAME);
}

function persistUpdateInstallFailureMarker() {
  try {
    const markerPath = getUpdateInstallFailureMarkerPath();
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "install-failed\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  } catch {
    console.error("[updater] install-failure-marker-write-failed");
    return false;
  }
}

function hasUpdateInstallFailureMarker() {
  try {
    return fs.existsSync(getUpdateInstallFailureMarkerPath());
  } catch {
    console.error("[updater] install-failure-marker-read-failed");
    return false;
  }
}

function clearUpdateInstallFailureMarker() {
  try {
    fs.unlinkSync(getUpdateInstallFailureMarkerPath());
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("[updater] install-failure-marker-clear-failed");
    }
  }
}

function schedulePersistedInstallFailureNotice() {
  if (!hasUpdateInstallFailureMarker()) return;
  const timer = setTimeout(() => {
    if (!hasUpdateInstallFailureMarker()) return;
    if (sendUpdaterInstallError()) clearUpdateInstallFailureMarker();
  }, 2_000);
  timer.unref();
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function canShowQuickTasks() {
  return (
    !quickTasksSuspended &&
    (isQuickTaskPreview ||
      (quickTasksAvailable && mainWindow && !mainWindow.isDestroyed()))
  );
}

function clearQuickCornerTimers() {
  if (quickCornerShowTimer) {
    clearTimeout(quickCornerShowTimer);
    quickCornerShowTimer = null;
  }
  if (quickCornerHideTimer) {
    clearTimeout(quickCornerHideTimer);
    quickCornerHideTimer = null;
  }
}

function rejectPendingQuickTaskRequests(message = "快捷待办已关闭") {
  for (const pending of pendingQuickTaskRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  pendingQuickTaskRequests.clear();
}

function hideQuickCorner({ animate = true } = {}) {
  if (!quickCornerWindow || quickCornerWindow.isDestroyed()) return;
  if (quickCornerHideTimer) {
    clearTimeout(quickCornerHideTimer);
    quickCornerHideTimer = null;
  }
  try {
    quickCornerWindow.webContents.send("quick-task:corner-visibility", false);
  } catch {
    // The window can be closing while the poller is winding down.
  }
  if (!animate) {
    quickCornerWindow.hide();
    return;
  }
  quickCornerHideTimer = setTimeout(() => {
    quickCornerHideTimer = null;
    if (quickCornerWindow && !quickCornerWindow.isDestroyed()) {
      quickCornerWindow.hide();
    }
  }, 190);
}

function hideQuickPanel() {
  quickPanelActivationSuppressedUntil = 0;
  if (!quickPanelWindow || quickPanelWindow.isDestroyed()) return false;
  try {
    quickPanelWindow.webContents.send("quick-task:panel-visibility", false);
  } catch {
    // The window can be closing while the event is sent.
  }
  quickPanelWindow.hide();
  return true;
}

function stopQuickCornerPolling() {
  if (quickCornerPollTimer) {
    clearInterval(quickCornerPollTimer);
    quickCornerPollTimer = null;
  }
  clearQuickCornerTimers();
}

function destroyQuickTaskWindows() {
  stopQuickCornerPolling();
  rejectPendingQuickTaskRequests();
  if (quickCornerWindow && !quickCornerWindow.isDestroyed()) {
    quickCornerWindow.destroy();
  }
  if (quickPanelWindow && !quickPanelWindow.isDestroyed()) {
    quickPanelWindow.destroy();
  }
  quickCornerWindow = null;
  quickPanelWindow = null;
}

async function loadQuickTaskSurface(targetWindow, surface) {
  const query = { surface };
  if (isQuickTaskPreview) query.preview = "1";
  if (isDevelopment) {
    const target = new URL(process.env.VITE_DEV_SERVER_URL);
    for (const [key, value] of Object.entries(query)) {
      target.searchParams.set(key, value);
    }
    await targetWindow.loadURL(target.toString());
    return;
  }
  await targetWindow.loadFile(
    path.join(__dirname, "..", "dist", "renderer", "index.html"),
    { query },
  );
}

function configureQuickTaskWindowSecurity(targetWindow) {
  targetWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  targetWindow.webContents.on("will-navigate", (event, url) => {
    const developmentUrl = process.env.VITE_DEV_SERVER_URL;
    const allowed =
      (developmentUrl && url.startsWith(developmentUrl)) ||
      url.startsWith("file://");
    if (!allowed) event.preventDefault();
  });
}

async function ensureQuickCornerWindow() {
  if (quickCornerWindow && !quickCornerWindow.isDestroyed()) {
    return quickCornerWindow;
  }
  quickCornerWindow = new BrowserWindow({
    width: QUICK_CORNER_SIZE,
    height: QUICK_CORNER_SIZE,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    ...(process.platform === "win32" ? { type: "toolbar" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "quick-task-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  quickCornerWindow.setAlwaysOnTop(true, "floating");
  quickCornerWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: false,
  });
  configureQuickTaskWindowSecurity(quickCornerWindow);
  quickCornerWindow.on("closed", () => {
    quickCornerWindow = null;
  });
  await loadQuickTaskSurface(quickCornerWindow, "quick-corner");
  return quickCornerWindow;
}

async function ensureQuickPanelWindow() {
  if (quickPanelWindow && !quickPanelWindow.isDestroyed()) {
    return quickPanelWindow;
  }
  quickPanelWindow = new BrowserWindow({
    ...QUICK_PANEL_SIZE,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    roundedCorners: true,
    backgroundColor: "#00000000",
    ...(process.platform === "win32" ? { type: "toolbar" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "quick-task-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  quickPanelWindow.setAlwaysOnTop(true, "floating");
  quickPanelWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: false,
  });
  configureQuickTaskWindowSecurity(quickPanelWindow);
  quickPanelWindow.on("closed", () => {
    quickPanelActivationSuppressedUntil = 0;
    quickPanelWindow = null;
    rejectPendingQuickTaskRequests();
  });
  await loadQuickTaskSurface(quickPanelWindow, "quick-panel");
  return quickPanelWindow;
}

async function showQuickCorner(display, { force = false } = {}) {
  if (!canShowQuickTasks()) return false;
  if (quickPanelWindow && !quickPanelWindow.isDestroyed() && quickPanelWindow.isVisible()) {
    return false;
  }
  if (quickCornerHideTimer) {
    clearTimeout(quickCornerHideTimer);
    quickCornerHideTimer = null;
  }
  const target = await ensureQuickCornerWindow();
  if (!canShowQuickTasks()) return false;
  const currentPoint = screen.getCursorScreenPoint();
  const currentDisplay = screen.getDisplayNearestPoint(currentPoint);
  if (
    !force &&
    (currentDisplay.id !== display.id ||
      !pointInBounds(
        currentPoint,
        expandBounds(
          getCornerWindowBounds(currentDisplay.bounds, QUICK_CORNER_SIZE),
          5,
        ),
      ))
  ) {
    target.hide();
    return false;
  }
  target.setBounds(
    getCornerWindowBounds(display.bounds, QUICK_CORNER_SIZE),
    false,
  );
  if (!target.isVisible()) target.showInactive();
  setTimeout(() => {
    if (quickCornerWindow && !quickCornerWindow.isDestroyed()) {
      quickCornerWindow.webContents.send(
        "quick-task:corner-visibility",
        true,
      );
    }
  }, 16);
  return true;
}

async function showQuickPanel() {
  if (!canShowQuickTasks()) return false;
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const target = await ensureQuickPanelWindow();
  if (!canShowQuickTasks()) return false;
  hideQuickCorner({ animate: false });
  target.setBounds(
    getQuickPanelBounds(display.workArea, QUICK_PANEL_SIZE, 16),
    false,
  );
  quickPanelActivationSuppressedUntil = Date.now() + 750;
  target.show();
  target.focus();
  target.webContents.send("quick-task:panel-visibility", true);
  return true;
}

function pollQuickCorner() {
  if (!canShowQuickTasks()) {
    hideQuickCorner({ animate: false });
    return;
  }
  if (
    quickPanelWindow &&
    !quickPanelWindow.isDestroyed() &&
    quickPanelWindow.isVisible()
  ) {
    hideQuickCorner({ animate: false });
    return;
  }
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const triggerBounds = getHotCornerTriggerBounds(
    display.bounds,
    QUICK_TRIGGER_SIZE,
  );
  const cornerBounds = getCornerWindowBounds(
    display.bounds,
    QUICK_CORNER_SIZE,
  );
  const inTrigger = pointInBounds(point, triggerBounds);
  const inVisibleCorner =
    quickCornerWindow &&
    !quickCornerWindow.isDestroyed() &&
    quickCornerWindow.isVisible() &&
    pointInBounds(point, expandBounds(cornerBounds, 5));

  if (inTrigger || inVisibleCorner) {
    const wasHiding = Boolean(quickCornerHideTimer);
    if (quickCornerHideTimer) {
      clearTimeout(quickCornerHideTimer);
      quickCornerHideTimer = null;
    }
    if (
      wasHiding &&
      quickCornerWindow &&
      !quickCornerWindow.isDestroyed() &&
      quickCornerWindow.isVisible()
    ) {
      quickCornerWindow.webContents.send(
        "quick-task:corner-visibility",
        true,
      );
    }
    if (
      !inVisibleCorner &&
      (!quickCornerWindow ||
        quickCornerWindow.isDestroyed() ||
        !quickCornerWindow.isVisible()) &&
      !quickCornerShowTimer
    ) {
      const displayId = display.id;
      quickCornerShowTimer = setTimeout(() => {
        quickCornerShowTimer = null;
        const currentPoint = screen.getCursorScreenPoint();
        const currentDisplay = screen.getDisplayNearestPoint(currentPoint);
        if (
          currentDisplay.id === displayId &&
          pointInBounds(
            currentPoint,
            getHotCornerTriggerBounds(
              currentDisplay.bounds,
              QUICK_TRIGGER_SIZE,
            ),
          )
        ) {
          void showQuickCorner(currentDisplay);
        }
      }, QUICK_CORNER_DWELL_MS);
    }
    return;
  }

  if (quickCornerShowTimer) {
    clearTimeout(quickCornerShowTimer);
    quickCornerShowTimer = null;
  }
  if (
    quickCornerWindow &&
    !quickCornerWindow.isDestroyed() &&
    quickCornerWindow.isVisible() &&
    !quickCornerHideTimer
  ) {
    quickCornerHideTimer = setTimeout(() => {
      quickCornerHideTimer = null;
      hideQuickCorner();
    }, QUICK_CORNER_LEAVE_MS);
  }
}

function startQuickCornerPolling() {
  if (quickCornerPollTimer || !canShowQuickTasks()) return;
  pollQuickCorner();
  quickCornerPollTimer = setInterval(
    pollQuickCorner,
    QUICK_CORNER_POLL_MS,
  );
}

function repositionQuickTaskWindows() {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  if (quickCornerWindow && !quickCornerWindow.isDestroyed()) {
    quickCornerWindow.setBounds(
      getCornerWindowBounds(display.bounds, QUICK_CORNER_SIZE),
      false,
    );
  }
  if (
    quickPanelWindow &&
    !quickPanelWindow.isDestroyed() &&
    quickPanelWindow.isVisible()
  ) {
    quickPanelWindow.setBounds(
      getQuickPanelBounds(display.workArea, QUICK_PANEL_SIZE, 16),
      false,
    );
  }
}

function configureQuickTaskLifecycle() {
  const suspend = () => {
    quickTasksSuspended = true;
    stopQuickCornerPolling();
    hideQuickCorner({ animate: false });
    hideQuickPanel();
  };
  const resume = () => {
    quickTasksSuspended = false;
    repositionQuickTaskWindows();
    startQuickCornerPolling();
  };
  powerMonitor.on("suspend", suspend);
  powerMonitor.on("lock-screen", suspend);
  powerMonitor.on("resume", resume);
  powerMonitor.on("unlock-screen", resume);
  screen.on("display-added", repositionQuickTaskWindows);
  screen.on("display-removed", repositionQuickTaskWindows);
  screen.on("display-metrics-changed", repositionQuickTaskWindows);
}

function clearNoticeHideTimer() {
  if (noticeHideTimer) {
    clearTimeout(noticeHideTimer);
    noticeHideTimer = null;
  }
}

function playDesktopNoticeSound(payload) {
  const soundKey =
    typeof payload?.soundKey === "string"
      ? payload.soundKey.trim().slice(0, 160)
      : "";
  const now = Date.now();
  for (const [key, playedAt] of recentNoticeSounds) {
    if (now - playedAt >= DEFAULT_NOTIFICATION_SOUND_DEDUP_MS) {
      recentNoticeSounds.delete(key);
    }
  }
  if (
    !shouldPlayNotificationSound({
      enabled:
        payload?.playSound === true && payload?.customSound !== true,
      soundKey,
      lastPlayedAt: recentNoticeSounds.get(soundKey),
      now,
    })
  ) {
    return;
  }
  recentNoticeSounds.set(soundKey, now);
  try {
    shell.beep();
  } catch {
    console.error("[desktop-notice] bell-failed");
  }
}

function normalizeCredentialEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function readCredentialVault() {
  if (!safeStorage.isEncryptionAvailable()) return [];
  try {
    const encrypted = await fsp.readFile(
      path.join(app.getPath("userData"), CREDENTIAL_VAULT_FILE_NAME),
    );
    const parsed = JSON.parse(safeStorage.decryptString(encrypted));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => ({
        email: normalizeCredentialEmail(entry?.email),
        password:
          typeof entry?.password === "string" ? entry.password : null,
        rememberPassword: entry?.rememberPassword !== false,
        lastUsedAt:
          typeof entry?.lastUsedAt === "string" ? entry.lastUsedAt : "",
      }))
      .filter((entry) => entry.email.includes("@"))
      .sort((left, right) =>
        right.lastUsedAt.localeCompare(left.lastUsedAt),
      )
      .slice(0, MAX_CREDENTIAL_ACCOUNTS);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    return [];
  }
}

async function writeCredentialVault(accounts) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统安全存储不可用，拒绝明文保存密码");
  }
  const payload = JSON.stringify(accounts.slice(0, MAX_CREDENTIAL_ACCOUNTS));
  if (payload.length > 100_000) {
    throw new Error("记住的账号数量过多");
  }
  const encrypted = safeStorage.encryptString(payload);
  await fsp.mkdir(app.getPath("userData"), { recursive: true });
  await fsp.writeFile(
    path.join(app.getPath("userData"), CREDENTIAL_VAULT_FILE_NAME),
    encrypted,
  );
}

async function touchCredentialAccount(emailValue) {
  const email = normalizeCredentialEmail(emailValue);
  if (!email.includes("@")) return false;
  const accounts = await readCredentialVault();
  const existing = accounts.find((account) => account.email === email);
  const next = [
    {
      email,
      password: existing?.password ?? null,
      rememberPassword: existing?.rememberPassword ?? false,
      lastUsedAt: new Date().toISOString(),
    },
    ...accounts.filter((account) => account.email !== email),
  ];
  await writeCredentialVault(next);
  return true;
}

function sessionEmailFromPayload(payload) {
  try {
    return normalizeCredentialEmail(JSON.parse(payload)?.user?.email);
  } catch {
    return "";
  }
}

function hideDesktopNotice({ notifyRenderer = false } = {}) {
  const notificationId = activeNoticeId;
  const requiresAcknowledgement = activeNoticeRequiresAcknowledgement;
  if (noticeWindow && !noticeWindow.isDestroyed()) {
    noticeWindow.hide();
  }
  clearNoticeHideTimer();
  activeNoticeId = "";
  activeNoticeRequiresAcknowledgement = false;
  activeNoticeAction = null;
  if (
    notifyRenderer &&
    requiresAcknowledgement &&
    notificationId &&
    mainWindow &&
    !mainWindow.isDestroyed()
  ) {
    mainWindow.webContents.send(
      "desktop-notice:dismiss-requested",
      notificationId,
    );
  }
}

function getNoticeWorkArea() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  }
  return screen.getPrimaryDisplay().workArea;
}

function positionNoticeWindow(expanded) {
  if (!noticeWindow || noticeWindow.isDestroyed()) return;
  const size = expanded ? NOTICE_EXPANDED_SIZE : NOTICE_COLLAPSED_SIZE;
  const workArea = getNoticeWorkArea();
  noticeWindow.setBounds(
    {
      x: workArea.x + 14,
      y: workArea.y + workArea.height - size.height - 14,
      width: size.width,
      height: size.height,
    },
    true,
  );
}

async function ensureNoticeWindow() {
  if (noticeWindow && !noticeWindow.isDestroyed()) return noticeWindow;
  noticeWindow = new BrowserWindow({
    ...NOTICE_COLLAPSED_SIZE,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "notice-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  noticeWindow.setAlwaysOnTop(true, "floating");
  noticeWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: false,
  });
  noticeWindow.on("closed", () => {
    clearNoticeHideTimer();
    noticeWindow = null;
    activeNoticeId = "";
    activeNoticeRequiresAcknowledgement = false;
    activeNoticeAction = null;
  });
  await noticeWindow.loadFile(path.join(__dirname, "notice.html"));
  positionNoticeWindow(false);
  return noticeWindow;
}

async function showDesktopNotice(payload) {
  const window = await ensureNoticeWindow();
  activeNoticeId =
    typeof payload.notificationId === "string"
      ? payload.notificationId.slice(0, 80)
      : "";
  activeNoticeRequiresAcknowledgement =
    payload.requireAcknowledgement === true;
  activeNoticeAction = normalizeDesktopNoticeAction(payload.action);
  window.webContents.send("desktop-notice:message", payload);
  positionNoticeWindow(false);
  window.showInactive();
  if (window.isVisible()) playDesktopNoticeSound(payload);
  clearNoticeHideTimer();
  if (activeNoticeRequiresAcknowledgement) return true;
  noticeHideTimer = setTimeout(
    () => hideDesktopNotice(),
    60_000,
  );
  noticeHideTimer.unref();
  return true;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1050,
    minHeight: 680,
    show: false,
    backgroundColor: "#f4efe4",
    title: "同频",
    frame: isMac,
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: 15 },
        }
      : {
          icon: APP_ICON_PATH,
          autoHideMenuBar: true,
        }),
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  if (!isMac) mainWindow.setMenuBarVisibility(false);
  const sendMaximizedState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        "window:maximized-changed",
        mainWindow.isMaximized(),
      );
    }
  };
  mainWindow.on("maximize", sendMaximizedState);
  mainWindow.on("unmaximize", sendMaximizedState);
  mainWindow.on("closed", () => {
    mainWindow = null;
    quickTasksAvailable = false;
    destroyQuickTaskWindows();
    if (noticeWindow && !noticeWindow.isDestroyed()) {
      noticeWindow.destroy();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const explorerUrl = validateLoraExplorerUrl(url);
    if (explorerUrl) void shell.openExternal(explorerUrl);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const developmentUrl = process.env.VITE_DEV_SERVER_URL;
    const allowed =
      (developmentUrl && url.startsWith(developmentUrl)) ||
      url.startsWith("file://");
    if (!allowed) event.preventDefault();
  });

  if (isDevelopment) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.once("did-finish-load", () => {
      sendUpdaterStatus({
        state: "not-available",
        message: "开发预览模式不执行在线更新",
      });
    });
  } else {
    await mainWindow.loadFile(
      path.join(__dirname, "..", "dist", "renderer", "index.html"),
    );
  }
}

function configureApplicationMenu() {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function registerDesktopIpc() {
  ipcMain.on("desktop:get-api-url", (event) => {
    event.returnValue = getApiUrl();
  });
  ipcMain.on("desktop:get-app-version", (event) => {
    event.returnValue = app.getVersion();
  });

  ipcMain.on("quick-task:set-availability", (event, enabled) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    quickTasksAvailable = Boolean(enabled);
    if (quickTasksAvailable) {
      startQuickCornerPolling();
      return;
    }
    stopQuickCornerPolling();
    hideQuickCorner({ animate: false });
    hideQuickPanel();
    rejectPendingQuickTaskRequests("登录状态已失效");
  });

  ipcMain.handle("quick-task:open-panel", async (event) => {
    if (
      !quickCornerWindow ||
      event.sender !== quickCornerWindow.webContents
    ) {
      return false;
    }
    return showQuickPanel();
  });

  ipcMain.handle("quick-task:close-panel", (event) => {
    if (!quickPanelWindow || event.sender !== quickPanelWindow.webContents) {
      return false;
    }
    const hidden = hideQuickPanel();
    startQuickCornerPolling();
    return hidden;
  });

  ipcMain.handle("quick-task:open-main", (event) => {
    if (!quickPanelWindow || event.sender !== quickPanelWindow.webContents) {
      return false;
    }
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    hideQuickPanel();
    focusMainWindow();
    return true;
  });

  ipcMain.handle("quick-task:request", (event, value) => {
    if (
      !quickPanelWindow ||
      event.sender !== quickPanelWindow.webContents ||
      !quickTasksAvailable ||
      !mainWindow ||
      mainWindow.isDestroyed()
    ) {
      throw new Error("快捷待办暂不可用");
    }
    const command = normalizeQuickTaskCommand(value);
    if (!command) throw new Error("快捷待办请求无效");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingQuickTaskRequests.delete(requestId);
        reject(new Error("快捷待办响应超时，请打开同频重试。"));
      }, QUICK_TASK_REQUEST_TIMEOUT_MS);
      pendingQuickTaskRequests.set(requestId, { resolve, reject, timer });
      try {
        mainWindow.webContents.send("quick-task:request", {
          requestId,
          command,
        });
      } catch {
        clearTimeout(timer);
        pendingQuickTaskRequests.delete(requestId);
        reject(new Error("快捷待办暂不可用"));
      }
    });
  });

  ipcMain.on("quick-task:response", (event, requestId, response) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const normalizedRequestId = String(requestId);
    const pending = pendingQuickTaskRequests.get(normalizedRequestId);
    if (!pending) return;
    pendingQuickTaskRequests.delete(normalizedRequestId);
    clearTimeout(pending.timer);
    if (response?.ok === true) {
      pending.resolve(response.data);
      return;
    }
    pending.reject(
      new Error(
        typeof response?.error === "string"
          ? response.error.slice(0, 240)
          : "快捷待办操作失败",
      ),
    );
  });

  ipcMain.on("quick-task:changed", (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    if (quickPanelWindow && !quickPanelWindow.isDestroyed()) {
      quickPanelWindow.webContents.send("quick-task:changed");
    }
  });

  ipcMain.handle("window:minimize", (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    mainWindow.minimize();
  });
  ipcMain.handle("window:toggle-maximize", (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return mainWindow.isMaximized();
  });
  ipcMain.handle("window:close", (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    mainWindow.close();
  });
  ipcMain.handle("window:is-maximized", (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false;
    return mainWindow.isMaximized();
  });

  ipcMain.handle("lora-explorer:open", async (event, target) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false;
    const explorerUrl = buildLoraExplorerUrl(target);
    if (!explorerUrl) return false;
    await shell.openExternal(explorerUrl);
    return true;
  });

  ipcMain.handle("session:load", async () => {
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      const encrypted = await fsp.readFile(
        path.join(app.getPath("userData"), SESSION_FILE_NAME),
      );
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      return null;
    }
  });

  ipcMain.handle("session:save", async (_event, payload) => {
    if (typeof payload !== "string" || payload.length > 20_000) {
      throw new Error("无效的会话内容");
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，拒绝明文保存登录状态");
    }
    const encrypted = safeStorage.encryptString(payload);
    await fsp.mkdir(app.getPath("userData"), { recursive: true });
    await fsp.writeFile(
      path.join(app.getPath("userData"), SESSION_FILE_NAME),
      encrypted,
    );
    const sessionEmail = sessionEmailFromPayload(payload);
    if (sessionEmail) {
      try {
        await touchCredentialAccount(sessionEmail);
      } catch {
        // The encrypted login session remains valid even if account history fails.
      }
    }
  });

  ipcMain.handle("session:clear", async () => {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const encrypted = await fsp.readFile(
          path.join(app.getPath("userData"), SESSION_FILE_NAME),
        );
        const sessionEmail = sessionEmailFromPayload(
          safeStorage.decryptString(encrypted),
        );
        if (sessionEmail) await touchCredentialAccount(sessionEmail);
      } catch {
        // Missing or unreadable legacy sessions must not block logout.
      }
    }
    try {
      await fsp.unlink(path.join(app.getPath("userData"), SESSION_FILE_NAME));
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  });

  ipcMain.handle("credentials:list", async () => {
    const accounts = await readCredentialVault();
    return accounts.map((account) => ({
      email: account.email,
      hasPassword:
        account.rememberPassword && typeof account.password === "string",
      lastUsedAt: account.lastUsedAt,
    }));
  });

  ipcMain.handle("credentials:load", async (_event, emailValue) => {
    const email = normalizeCredentialEmail(emailValue);
    const accounts = await readCredentialVault();
    const account = accounts.find((candidate) => candidate.email === email);
    if (!account) return null;
    return {
      email: account.email,
      password:
        account.rememberPassword && typeof account.password === "string"
          ? account.password
          : null,
      rememberPassword: account.rememberPassword,
    };
  });

  ipcMain.handle("credentials:save", async (_event, value) => {
    const email = normalizeCredentialEmail(value?.email);
    const password = typeof value?.password === "string" ? value.password : "";
    const rememberPassword = value?.rememberPassword !== false;
    if (
      !email.includes("@") ||
      password.length < 1 ||
      password.length > 512
    ) {
      throw new Error("无效的登录账号");
    }
    const accounts = await readCredentialVault();
    const next = [
      {
        email,
        password: rememberPassword ? password : null,
        rememberPassword,
        lastUsedAt: new Date().toISOString(),
      },
      ...accounts.filter((account) => account.email !== email),
    ];
    await writeCredentialVault(next);
    return true;
  });

  ipcMain.handle("credentials:remove", async (_event, emailValue) => {
    const email = normalizeCredentialEmail(emailValue);
    const accounts = await readCredentialVault();
    await writeCredentialVault(
      accounts.filter((account) => account.email !== email),
    );
    return true;
  });

  ipcMain.handle("notification:show", async (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false;
    const normalized = normalizeDesktopNoticePayload(payload);
    if (!normalized) return false;
    return showDesktopNotice(normalized);
  });

  ipcMain.handle("notification:dismiss", (event, notificationId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false;
    if (
      notificationId &&
      activeNoticeId &&
      String(notificationId) !== activeNoticeId
    ) {
      return false;
    }
    hideDesktopNotice();
    return true;
  });

  ipcMain.handle("updater:install", (event) => {
    if (
      !mainWindow ||
      event.sender !== mainWindow.webContents ||
      !updateReady
    ) {
      return false;
    }
    if (updateInstallCoordinator.isInstallRequested()) return false;
    updateInstallInProgress = true;
    let started = false;
    try {
      started = updateInstallCoordinator.requestInstall();
    } catch {
      started = false;
    }
    if (!started) updateInstallInProgress = false;
    return started;
  });

  ipcMain.on("desktop-notice:set-expanded", (event, expanded) => {
    if (!noticeWindow || event.sender !== noticeWindow.webContents) return;
    positionNoticeWindow(Boolean(expanded));
    if (activeNoticeRequiresAcknowledgement) return;
    clearNoticeHideTimer();
    noticeHideTimer = setTimeout(() => {
      hideDesktopNotice();
    }, expanded ? 90_000 : 60_000);
    noticeHideTimer.unref();
  });

  ipcMain.on("desktop-notice:open-app", (event) => {
    if (!noticeWindow || event.sender !== noticeWindow.webContents) return;
    const action = activeNoticeAction;
    if (!activeNoticeRequiresAcknowledgement) {
      hideDesktopNotice();
    }
    focusMainWindow();
    if (
      action &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      mainWindow.webContents.send(
        "desktop-notice:action-requested",
        action,
      );
    }
  });

  ipcMain.on("desktop-notice:acknowledge", (event, notificationId) => {
    if (
      !noticeWindow ||
      event.sender !== noticeWindow.webContents ||
      !activeNoticeRequiresAcknowledgement ||
      !activeNoticeId ||
      String(notificationId) !== activeNoticeId ||
      !mainWindow ||
      mainWindow.isDestroyed()
    ) {
      return;
    }
    focusMainWindow();
    mainWindow.webContents.send(
      "desktop-notice:acknowledge-requested",
      activeNoticeId,
    );
  });

  ipcMain.on("desktop-notice:dismiss", (event) => {
    if (!noticeWindow || event.sender !== noticeWindow.webContents) return;
    hideDesktopNotice({ notifyRenderer: true });
  });
}

function configureUpdater() {
  if (isDevelopment || !app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  let checking = false;
  let retryTimer = null;
  let checkFailureCount = 0;
  let updatePhase = "idle";
  let currentCheckReportedErrorKind = "";
  const reportedErrorObjects = new WeakMap();
  let lastReportedErrorKind = "";
  let lastReportedErrorAt = 0;

  const clearRetryTimer = () => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };
  const resetCheckFailures = () => {
    checkFailureCount = 0;
    clearRetryTimer();
  };
  const isDuplicateCriticalError = (error, errorClass) => {
    const now = Date.now();
    if (error !== null && typeof error === "object") {
      const lastReportedAt = reportedErrorObjects.get(error) ?? 0;
      if (now - lastReportedAt < UPDATER_ERROR_DEDUP_WINDOW_MS) return true;
      reportedErrorObjects.set(error, now);
    }
    if (
      lastReportedErrorKind === errorClass.kind &&
      now - lastReportedErrorAt < UPDATER_ERROR_DEDUP_WINDOW_MS
    ) {
      return true;
    }
    lastReportedErrorKind = errorClass.kind;
    lastReportedErrorAt = now;
    return false;
  };
  const reportUpdaterError = (error) => {
    const errorClass = classifyUpdateError(error, updatePhase);
    if (
      checking &&
      currentCheckReportedErrorKind === errorClass.kind
    ) {
      return errorClass;
    }
    if (checking) currentCheckReportedErrorKind = errorClass.kind;

    if (!shouldShowUpdateError({ errorClass })) return errorClass;
    if (isDuplicateCriticalError(error, errorClass)) return errorClass;

    console.error(`[updater] ${errorClass.kind}`);
    sendUpdaterStatus({
      state: "error",
      errorKind: errorClass.kind,
      message: errorClass.message,
    });
    return errorClass;
  };

  const scheduleRetry = (errorClass) => {
    if (retryTimer || updateReady || errorClass.retry !== "backoff") return;
    checkFailureCount += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      check();
    }, getUpdateRetryDelayMs(checkFailureCount));
    retryTimer.unref();
  };

  const check = () => {
    if (checking || updateReady || retryTimer) return;
    checking = true;
    updatePhase = "checking";
    currentCheckReportedErrorKind = "";
    autoUpdater
      .checkForUpdates()
      .then(() => resetCheckFailures())
      .catch((error) => {
        const classifiedError = classifyUpdateError(error, updatePhase);
        const errorClass =
          currentCheckReportedErrorKind === classifiedError.kind
            ? classifiedError
            : reportUpdaterError(error);
        if (errorClass.kind === "channel-missing") {
          resetCheckFailures();
          return;
        }
        scheduleRetry(errorClass);
      })
      .finally(() => {
        checking = false;
      });
  };

  autoUpdater.on("checking-for-update", () => {
    updatePhase = "checking";
    sendUpdaterStatus({ state: "checking", message: "正在检查新版本" });
  });
  autoUpdater.on("update-available", (info) => {
    resetCheckFailures();
    updatePhase = "downloading";
    updateReady = false;
    sendUpdaterStatus({
      state: "available",
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      message: `发现版本 ${info.version}，正在后台下载`,
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    resetCheckFailures();
    updatePhase = "idle";
    updateReady = false;
    sendUpdaterStatus({
      state: "not-available",
      version: info.version,
      message: "当前已是最新版本",
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    updatePhase = "downloading";
    sendUpdaterStatus({
      state: "downloading",
      percent: progress.percent,
      message: `正在下载更新 ${Math.round(progress.percent)}%`,
    });
  });
  autoUpdater.on("error", (error) => {
    updateReady = false;
    const failedDuringInstall = updateInstallInProgress;
    if (failedDuringInstall) updatePhase = "installing";
    reportUpdaterError(error);
    if (
      failedDuringInstall &&
      (!mainWindow || mainWindow.isDestroyed())
    ) {
      persistUpdateInstallFailureMarker();
    }
    if (failedDuringInstall) updateInstallInProgress = false;
  });
  autoUpdater.on("update-downloaded", (info) => {
    resetCheckFailures();
    updatePhase = "downloaded";
    updateReady = true;
    updateInstallInProgress = false;
    sendUpdaterStatus({
      state: "downloaded",
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      message: `版本 ${info.version} 已下载`,
    });
    const silentInstallTimer = setTimeout(
      () => requestSilentInstallIfEligible(),
      5_000,
    );
    silentInstallTimer.unref();
  });

  setTimeout(check, 8_000);
  const interval = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  interval.unref();
  const silentInstallInterval = setInterval(
    () => requestSilentInstallIfEligible(),
    SILENT_INSTALL_CHECK_INTERVAL_MS,
  );
  silentInstallInterval.unref();
  powerMonitor.on("resume", () => {
    const resumeTimer = setTimeout(check, 5_000);
    resumeTimer.unref();
    const silentInstallTimer = setTimeout(
      () => requestSilentInstallIfEligible(),
      60_000,
    );
    silentInstallTimer.unref();
  });
}

function configureSystemResumeBridge() {
  const sendResume = () => {
    const timer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("desktop:system-resume");
    }, 700);
    timer.unref();
  };
  powerMonitor.on("resume", sendResume);
  powerMonitor.on("unlock-screen", sendResume);
}

app.setName(isQuickTaskPreview ? "同频快捷待办预览" : "同频");
if (process.platform === "win32") {
  app.setAppUserModelId("com.tongpin.workbench");
}

app.whenReady().then(async () => {
  configureApplicationMenu();
  registerDesktopIpc();
  if (isQuickTaskPreview) {
    quickTasksAvailable = true;
    if (quickTaskPreviewTarget === "corner") {
      await showQuickCorner(screen.getPrimaryDisplay(), { force: true });
    } else {
      await showQuickPanel();
    }
  } else {
    await createWindow();
  }
  configureSystemResumeBridge();
  configureQuickTaskLifecycle();
  if (!isQuickTaskPreview || quickTaskPreviewTarget !== "corner") {
    startQuickCornerPolling();
  }
  configureUpdater();
  if (!isDevelopment && app.isPackaged) {
    schedulePersistedInstallFailureNotice();
  }

  app.on("activate", () => {
    if (isQuickTaskPreview) {
      if (quickTaskPreviewTarget === "corner") {
        void showQuickCorner(screen.getPrimaryDisplay(), { force: true });
      } else {
        void showQuickPanel();
      }
      return;
    }
    const activationNow = Date.now();
    const hasOpeningGuard =
      quickPanelActivationSuppressedUntil > 0 &&
      activationNow <= quickPanelActivationSuppressedUntil;
    if (
      quickPanelActivationSuppressedUntil > 0 &&
      !hasOpeningGuard
    ) {
      quickPanelActivationSuppressedUntil = 0;
    }
    const cornerVisible = Boolean(
      quickCornerWindow &&
        !quickCornerWindow.isDestroyed() &&
        quickCornerWindow.isVisible(),
    );
    const panelVisible = Boolean(
      quickPanelWindow &&
        !quickPanelWindow.isDestroyed() &&
        quickPanelWindow.isVisible(),
    );
    const cursorPoint =
      cornerVisible || panelVisible ? screen.getCursorScreenPoint() : null;
    if (
      shouldSuppressMainActivation({
        now: activationNow,
        suppressUntil: quickPanelActivationSuppressedUntil,
        cursorPoint,
        cornerBounds: cornerVisible ? quickCornerWindow.getBounds() : null,
        panelBounds: panelVisible ? quickPanelWindow.getBounds() : null,
      })
    ) {
      if (hasOpeningGuard) quickPanelActivationSuppressedUntil = 0;
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      void createWindow().then(() => startQuickCornerPolling());
    } else {
      focusMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
