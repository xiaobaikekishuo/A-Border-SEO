const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("aborderDesktop", {
    openExternal: url => ipcRenderer.invoke("workbench:external", url),
    showSettings: () => ipcRenderer.invoke("workbench:account"),
    logout: () => ipcRenderer.invoke("workbench:logout"),
    localCodexStatus: () => ipcRenderer.invoke("workbench:local-codex", "status"),
    localCodexLogin: () => ipcRenderer.invoke("workbench:local-codex", "login"),
    localCodexStart: () => ipcRenderer.invoke("workbench:local-codex", "start"),
  });

  window.addEventListener("click", event => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || link.hasAttribute("download")) return;
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin) return;
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    event.preventDefault();
    void ipcRenderer.invoke("workbench:link", url.href).catch(() => {});
  });
}
