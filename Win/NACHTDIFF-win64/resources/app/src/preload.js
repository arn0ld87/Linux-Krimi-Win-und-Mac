const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nachtdiff", {
  getInitialState: () => ipcRenderer.invoke("app:get-state"),
  setPage: (page) => ipcRenderer.invoke("app:set-page", page),
  selectEpisode: (id) => ipcRenderer.invoke("app:select-episode", id),
  setAppearance: (appearance) => ipcRenderer.invoke("app:set-appearance", appearance),
  startLinux: () => ipcRenderer.invoke("linux:start"),
  openInteractiveTerminal: (maintenance) => ipcRenderer.invoke("linux:open-terminal", maintenance),
  sendTerminalInput: (base64) => ipcRenderer.send("linux:terminal-input", base64),
  resizeTerminal: (size) => ipcRenderer.send("linux:terminal-resize", size),
  refreshGuest: () => ipcRenderer.invoke("linux:refresh"),
  submitAnswer: (value, step) => ipcRenderer.invoke("linux:submit-answer", value, step),
  useDesktop: (action) => ipcRenderer.invoke("linux:desktop", action),
  setSelectedSuspect: (id) => ipcRenderer.invoke("app:set-suspect", id),
  toggleEvidence: (id) => ipcRenderer.invoke("app:toggle-evidence", id),
  submitAccusation: () => ipcRenderer.invoke("app:submit-accusation"),
  submitFinale: () => ipcRenderer.invoke("app:submit-finale"),
  resetProgress: () => ipcRenderer.invoke("app:reset-progress"),
  copyText: (text) => ipcRenderer.invoke("app:copy-text", text),
  getAssetUrls: () => ipcRenderer.invoke("app:get-assets"),
  onStateChanged: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on("state:changed", listener);
    return () => ipcRenderer.removeListener("state:changed", listener);
  },
  onTerminalOutput: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on("terminal:output", listener);
    return () => ipcRenderer.removeListener("terminal:output", listener);
  },
  onTerminalReset: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("terminal:reset", listener);
    return () => ipcRenderer.removeListener("terminal:reset", listener);
  },
  onOpenSettings: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("ui:open-settings", listener);
    return () => ipcRenderer.removeListener("ui:open-settings", listener);
  },
  onRequestMaintenance: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("ui:request-maintenance", listener);
    return () => ipcRenderer.removeListener("ui:request-maintenance", listener);
  },
});
