const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("installer", {
  start: (input) => ipcRenderer.invoke("install:start", input),
  testConnection: (input) => ipcRenderer.invoke("ssh:test", input),
  testGithub: (input) => ipcRenderer.invoke("github:test", input),
  testGithub: (input) => ipcRenderer.invoke("github:test", input),
  cancel: () => ipcRenderer.invoke("task:cancel"),
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  saveProfile: (profile) => ipcRenderer.invoke("profiles:save", profile),
  getCredentials: (id) => ipcRenderer.invoke("profiles:credentials", id),
  saveCredentials: (input) => ipcRenderer.invoke("profiles:saveCredentials", input),
  removeProfile: (id) => ipcRenderer.invoke("profiles:remove", id),
  serverStatus: (config) => ipcRenderer.invoke("server:status", config),
  serverCommand: (input) => ipcRenderer.invoke("server:command", input),
  startLogs: (input) => ipcRenderer.invoke("logs:start", input),
  previewUninstall: (config) => ipcRenderer.invoke("uninstall:preview", config),
  uninstall: (input) => ipcRenderer.invoke("uninstall:start", input),
  saveLog: (text) => ipcRenderer.invoke("dialog:saveLog", text),
  onLog: (callback) => {
    ipcRenderer.on("install:log", (_event, chunk) => callback(chunk));
  },
  onServerLog: (callback) => {
    ipcRenderer.on("server:log", (_event, chunk) => callback(chunk));
  },
  onLogsLog: (callback) => {
    ipcRenderer.on("logs:log", (_event, chunk) => callback(chunk));
  },
  onUninstallLog: (callback) => {
    ipcRenderer.on("uninstall:log", (_event, chunk) => callback(chunk));
  },
  onDone: (callback) => {
    ipcRenderer.on("install:done", (_event, result) => callback(result));
  },
  onServerDone: (callback) => {
    ipcRenderer.on("server:done", (_event, result) => callback(result));
  },
  onLogsDone: (callback) => {
    ipcRenderer.on("logs:done", (_event, result) => callback(result));
  },
  onUninstallDone: (callback) => {
    ipcRenderer.on("uninstall:done", (_event, result) => callback(result));
  }
});
