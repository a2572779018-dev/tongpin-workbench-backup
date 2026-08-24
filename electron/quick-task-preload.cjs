const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback, transform = (value) => value) {
  const listener = (_event, value) => callback(transform(value));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("tongpinQuick", {
  request: (command) => ipcRenderer.invoke("quick-task:request", command),
  openPanel: () => ipcRenderer.invoke("quick-task:open-panel"),
  closePanel: () => ipcRenderer.invoke("quick-task:close-panel"),
  openMain: () => ipcRenderer.invoke("quick-task:open-main"),
  onCornerVisibility: (callback) =>
    subscribe("quick-task:corner-visibility", callback, Boolean),
  onPanelVisibility: (callback) =>
    subscribe("quick-task:panel-visibility", callback, Boolean),
  onTasksChanged: (callback) =>
    subscribe("quick-task:changed", callback),
});
