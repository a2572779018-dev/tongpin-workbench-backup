const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tongpinDesktopNotice", {
  onMessage: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop-notice:message", listener);
    return () =>
      ipcRenderer.removeListener("desktop-notice:message", listener);
  },
  setExpanded: (expanded) =>
    ipcRenderer.send("desktop-notice:set-expanded", Boolean(expanded)),
  openApp: () => ipcRenderer.send("desktop-notice:open-app"),
  acknowledge: (notificationId) =>
    ipcRenderer.send(
      "desktop-notice:acknowledge",
      String(notificationId ?? ""),
    ),
  dismiss: () => ipcRenderer.send("desktop-notice:dismiss"),
});
