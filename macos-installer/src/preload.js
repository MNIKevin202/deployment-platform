const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("installer", {
  start: (input) => ipcRenderer.invoke("install:start", input),
  cancel: () => ipcRenderer.invoke("install:cancel"),
  onLog: (callback) => {
    ipcRenderer.on("install:log", (_event, chunk) => callback(chunk));
  },
  onDone: (callback) => {
    ipcRenderer.on("install:done", (_event, result) => callback(result));
  }
});
