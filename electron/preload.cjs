const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tongpin", {
  apiUrl: ipcRenderer.sendSync("desktop:get-api-url"),
  platform: process.platform,
  versions: {
    app: ipcRenderer.sendSync("desktop:get-app-version"),
    electron: process.versions.electron,
  },
  session: {
    load: () => ipcRenderer.invoke("session:load"),
    save: (payload) => ipcRenderer.invoke("session:save", payload),
    clear: () => ipcRenderer.invoke("session:clear"),
  },
  credentials: {
    list: () => ipcRenderer.invoke("credentials:list"),
    load: (email) => ipcRenderer.invoke("credentials:load", String(email)),
    save: (payload) => ipcRenderer.invoke("credentials:save", payload),
    remove: (email) =>
      ipcRenderer.invoke("credentials:remove", String(email)),
    openSystemStorage: () =>
      ipcRenderer.invoke("credentials:open-system-storage"),
  },
  relationshipGraph: {
    open: () => ipcRenderer.invoke("relationship-graph:open"),
    save: ({ scopeToken, content, revision }) =>
      ipcRenderer.invoke("relationship-graph:save", {
        scopeToken: String(scopeToken),
        content: String(content),
        revision: Number(revision),
      }),
    flushCurrent: () => ipcRenderer.invoke("relationship-graph:flush-current"),
    release: (scopeToken) =>
      ipcRenderer.invoke("relationship-graph:release", String(scopeToken)),
    onFlushRequest: (callback) => {
      const listener = async (_event, requestId) => {
        let ok = false;
        try {
          ok = (await callback()) === true;
        } catch {
          ok = false;
        }
        ipcRenderer.send(
          "relationship-graph:flush-response",
          String(requestId),
          ok,
        );
      };
      ipcRenderer.on("relationship-graph:flush-request", listener);
      return () =>
        ipcRenderer.removeListener("relationship-graph:flush-request", listener);
    },
  },
  notify: (payload) => ipcRenderer.invoke("notification:show", payload),
  dismissNotification: (notificationId) =>
    ipcRenderer.invoke("notification:dismiss", notificationId),
  openLoraExplorer: (target) =>
    ipcRenderer.invoke("lora-explorer:open", target),
  openAiSource: (url) => ipcRenderer.invoke("ai-source:open", url),
  onDesktopNoticeAcknowledge: (callback) => {
    const listener = (_event, notificationId) =>
      callback(String(notificationId));
    ipcRenderer.on("desktop-notice:acknowledge-requested", listener);
    return () =>
      ipcRenderer.removeListener(
        "desktop-notice:acknowledge-requested",
        listener,
      );
  },
  onDesktopNoticeDismiss: (callback) => {
    const listener = (_event, notificationId) =>
      callback(String(notificationId));
    ipcRenderer.on("desktop-notice:dismiss-requested", listener);
    return () =>
      ipcRenderer.removeListener(
        "desktop-notice:dismiss-requested",
        listener,
      );
  },
  onDesktopNoticeAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("desktop-notice:action-requested", listener);
    return () =>
      ipcRenderer.removeListener(
        "desktop-notice:action-requested",
        listener,
      );
  },
  onSystemResume: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("desktop:system-resume", listener);
    return () => ipcRenderer.removeListener("desktop:system-resume", listener);
  },
  quickTasks: {
    setAvailability: (enabled) =>
      ipcRenderer.send("quick-task:set-availability", Boolean(enabled)),
    onRequest: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("quick-task:request", listener);
      return () => ipcRenderer.removeListener("quick-task:request", listener);
    },
    respond: (requestId, response) =>
      ipcRenderer.send("quick-task:response", String(requestId), response),
    notifyChanged: () => ipcRenderer.send("quick-task:changed"),
  },
  installUpdate: () => ipcRenderer.invoke("updater:install"),
  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    onMaximizedChange: (callback) => {
      const listener = (_event, maximized) => callback(Boolean(maximized));
      ipcRenderer.on("window:maximized-changed", listener);
      return () =>
        ipcRenderer.removeListener("window:maximized-changed", listener);
    },
  },
  onUpdaterStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("updater:status", listener);
    return () => ipcRenderer.removeListener("updater:status", listener);
  },
});
