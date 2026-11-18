const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("controlPanel", {
  read: () => ipcRenderer.invoke("panel:read"),
  act: (action, input) => ipcRenderer.invoke("panel:act", action, input),
  subscribe: listener => { ipcRenderer.on("panel:state", (_event, value) => listener(value)); },
});
