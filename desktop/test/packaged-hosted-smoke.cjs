// Boots the untouched packaged ASAR with the matching Electron runtime in an isolated profile.
// Every network request is blocked before importing the application; no existing identity is read.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { registerHooks } = require("node:module");
const { app, BrowserWindow, dialog, net, session } = require("electron");
const resources = path.resolve(process.argv[2]);
const profile = path.resolve(process.argv[3]);
const packagedVersion = JSON.parse(fs.readFileSync(path.join(resources, "app.asar", "package.json"), "utf8")).version;
const resultFile = path.join(profile, "packaged-smoke-result.json");
fs.mkdirSync(profile, { recursive: true });
app.setPath("appData", profile);
app.setPath("userData", path.join(profile, "electron-harness"));
Object.defineProperty(app, "isPackaged", { value: true });
Object.defineProperty(process, "resourcesPath", { value: resources });
app.getVersion = () => packagedVersion;
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
let blockedRequests = 0;
const deny = async () => { blockedRequests++; throw new Error("isolated_network_blocked"); };
globalThis.fetch = deny;
net.fetch = deny;
assert.equal(net.fetch, deny);
let timeout;
function finish(error, data = {}) {
  clearTimeout(timeout);
  fs.writeFileSync(resultFile, JSON.stringify({ pass: !error, electronVersion: process.versions.electron,
    resources, profile, blockedRequests, ...(error ? { error: error.message } : data) }, null, 2));
  if (error) console.error(error.message); else console.log("Packaged ASAR startup smoke passed with all network requests blocked.");
  app.exit(error ? 1 : 0);
}
// Preserve the failure reason hidden by the product's generic startup dialog, without changing the archive.
if (process.env.ABORDER_SMOKE_STARTUP_DIAGNOSTICS === "1") registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url.endsWith("/app.asar/main.mjs")) return { ...result, source: String(result.source).replace(".then(initialize).catch(() => {", ".then(initialize).catch((failure) => { globalThis.__packagedStartupFailure = failure;") };
  return result;
} });
dialog.showErrorBox = () => finish(globalThis.__packagedStartupFailure ?? new Error("packaged_startup_error_dialog"));
app.on("session-created", value => value.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => { blockedRequests++; callback({ cancel: true }); }));
app.on("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async()=>{
        const state=await window.controlPanel.read();
        await window.controlPanel.act('ShowSettings');
        await new Promise(resolve=>setTimeout(resolve,100));
        return {hosted:state.hosted,workspaceOrigin:state.workspaceOrigin,currentVersion:state.currentVersion,
          signedIn:state.managed?.signedIn,automaticUpdatesAvailable:state.automaticUpdatesAvailable,
          issue:state.status?.issue,services:state.status?.services,
          localDataHidden:document.getElementById('local-data').hidden,
          setupHidden:document.getElementById('setup').hidden,
          serviceStartHidden:document.getElementById('start').hidden,
          workerControlsVisible:!document.getElementById('codex-actions').hidden,
          registrationVisible:!document.getElementById('user-access').hidden,
          errors:document.getElementById('message').textContent};
      })()`);
      assert.equal(result.hosted, true);
      assert.equal(result.workspaceOrigin, "https://aborder.tuitehao.shop");
      assert.equal(result.currentVersion, packagedVersion);
      assert.equal(result.signedIn, false);
      assert.equal(result.automaticUpdatesAvailable, process.argv[4] === "signed");
      assert.equal(result.issue, "hosted_workspace_unavailable");
      assert.equal(result.services.db, undefined);
      assert.equal(result.localDataHidden, true);
      assert.equal(result.setupHidden, true);
      assert.equal(result.serviceStartHidden, true);
      assert.equal(result.workerControlsVisible, true);
      assert.equal(result.registrationVisible, true);
      finish(null, { observed: result });
    } catch (error) { finish(error); }
  });
});
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => { blockedRequests++; callback({ cancel: true }); });
  timeout = setTimeout(() => finish(new Error("packaged_startup_timeout")), 15000);
  try { await import(pathToFileURL(path.join(resources, "app.asar", "main.mjs")).href); }
  catch (error) { finish(error); }
});
