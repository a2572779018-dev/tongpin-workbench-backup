const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
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

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const SESSION_FILE_NAME = "secure-session.bin";
const CREDENTIAL_VAULT_FILE_NAME = "secure-accounts.bin";
const MAX_CREDENTIAL_ACCOUNTS = 20;
const APP_ICON_PATH = path.join(__dirname, "..", "build", "icon.ico");
const NOTICE_COLLAPSED_SIZE = { width: 82, height: 82 };
const NOTICE_EXPANDED_SIZE = { width: 430, height: 178 };
const STRONG_NOTICE_AUTO_HIDE_MS = 30_000;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_RETRY_DELAY_MS = 2 * 60 * 1000;
const SILENT_INSTALL_CHECK_INTERVAL_MS = 60 * 1000;
const UPDATE_TEMP_DIR_NAME = ".tongpin-updater-temp";
let mainWindow = null;
let noticeWindow = null;
let noticeHideTimer = null;
let activeNoticeId = "";
let activeNoticeRequiresAcknowledgement = false;
let activeNoticeAction = null;
let updateReady = false;

function prepareSameVolumeUpdaterTemp() {
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
  prepareInstallerEnvironment: prepareSameVolumeUpdaterTemp,
  closeAuxiliaryWindows: () => {
    clearNoticeHideTimer();
    if (noticeWindow && !noticeWindow.isDestroyed()) {
      noticeWindow.destroy();
    }
  },
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
  return updateInstallCoordinator.requestInstall();
}

app.on("before-quit", () => {
  if (!updateReady || updateInstallCoordinator.isInstallRequested()) return;
  try {
    prepareSameVolumeUpdaterTemp();
  } catch (error) {
    autoUpdater.autoInstallOnAppQuit = false;
    console.error(
      "[updater] Automatic install on quit was disabled:",
      error instanceof Error ? error.message : error,
    );
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

function getUpdateUrl() {
  if (process.env.TONGPIN_UPDATE_URL) return process.env.TONGPIN_UPDATE_URL;
  return readPackagedConfig().updateUrl || "";
}

function sendUpdaterStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("updater:status", status);
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function clearNoticeHideTimer() {
  if (noticeHideTimer) {
    clearTimeout(noticeHideTimer);
    noticeHideTimer = null;
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
  activeNoticeAction =
    payload.action?.type === "open-task" &&
    typeof payload.action.taskId === "string" &&
    typeof payload.action.date === "string"
      ? {
          type: "open-task",
          taskId: payload.action.taskId.slice(0, 80),
          date: payload.action.date.slice(0, 10),
        }
      : null;
  window.webContents.send("desktop-notice:message", payload);
  positionNoticeWindow(false);
  window.showInactive();
  clearNoticeHideTimer();
  const autoHideMs = activeNoticeRequiresAcknowledgement
    ? STRONG_NOTICE_AUTO_HIDE_MS
    : 60_000;
  noticeHideTimer = setTimeout(
    () =>
      hideDesktopNotice({
        notifyRenderer: activeNoticeRequiresAcknowledgement,
      }),
    autoHideMs,
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
    icon: APP_ICON_PATH,
    frame: false,
    autoHideMenuBar: true,
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
  mainWindow.setMenuBarVisibility(false);
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
    if (noticeWindow && !noticeWindow.isDestroyed()) {
      noticeWindow.destroy();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
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

function registerDesktopIpc() {
  ipcMain.on("desktop:get-api-url", (event) => {
    event.returnValue = getApiUrl();
  });
  ipcMain.on("desktop:get-app-version", (event) => {
    event.returnValue = app.getVersion();
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
    if (
      !payload ||
      typeof payload.title !== "string" ||
      typeof payload.body !== "string"
    ) {
      return false;
    }
    return showDesktopNotice({
      notificationId:
        typeof payload.notificationId === "string"
          ? payload.notificationId.slice(0, 80)
          : "",
      title: payload.title.slice(0, 80),
      body: payload.body.slice(0, 400),
      actionLabel:
        typeof payload.actionLabel === "string"
          ? payload.actionLabel.slice(0, 20)
          : undefined,
      action: payload.action,
      tone: payload.requireAcknowledgement ? "warning" : "info",
      requireAcknowledgement:
        payload.requireAcknowledgement === true,
    });
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
    return updateInstallCoordinator.requestInstall();
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

  const updateUrl = getUpdateUrl();
  if (!updateUrl || updateUrl.includes("example.com")) {
    sendUpdaterStatus({
      state: "not-available",
      message: "升级服务器尚未配置",
    });
    return;
  }

  autoUpdater.setFeedURL({
    provider: "generic",
    url: updateUrl,
  });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    sendUpdaterStatus({ state: "checking", message: "正在检查新版本" });
  });
  autoUpdater.on("update-available", (info) => {
    updateReady = false;
    sendUpdaterStatus({
      state: "available",
      version: info.version,
      message: `发现版本 ${info.version}，正在后台下载`,
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    updateReady = false;
    sendUpdaterStatus({
      state: "not-available",
      version: info.version,
      message: "当前已是最新版本",
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    sendUpdaterStatus({
      state: "downloading",
      percent: progress.percent,
      message: `正在下载更新 ${Math.round(progress.percent)}%`,
    });
  });
  autoUpdater.on("error", (error) => {
    sendUpdaterStatus({
      state: "error",
      message: error.message || "更新检查失败",
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    updateReady = true;
    sendUpdaterStatus({
      state: "downloaded",
      version: info.version,
      message: `版本 ${info.version} 已下载`,
    });
    const silentInstallTimer = setTimeout(
      () => requestSilentInstallIfEligible(),
      5_000,
    );
    silentInstallTimer.unref();
  });

  let checking = false;
  let retryTimer = null;
  const scheduleRetry = () => {
    if (retryTimer || updateReady) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      check();
    }, UPDATE_RETRY_DELAY_MS);
    retryTimer.unref();
  };
  const check = () => {
    if (checking || updateReady) return;
    checking = true;
    autoUpdater
      .checkForUpdates()
      .catch((error) => {
        sendUpdaterStatus({
          state: "error",
          message: error.message || "更新检查失败",
        });
        scheduleRetry();
      })
      .finally(() => {
        checking = false;
      });
  };

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

app.setName("同频");
app.setAppUserModelId("com.tongpin.workbench");

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerDesktopIpc();
  await createWindow();
  configureUpdater();

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      void createWindow();
    } else {
      focusMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
