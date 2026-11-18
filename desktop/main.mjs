import { app, autoUpdater as electronAutoUpdater, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, powerMonitor, safeStorage, session, shell, Tray, utilityProcess } from "electron";
import updater from "electron-updater";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fetchManifest, readJson, repository, runWindowsAction, saveJson, validWorkbenchOrigin, validateBundledManifest, workbenchExternal,
} from "./runtime.mjs";
import { ManagedClient } from "./managed-client.mjs";
import { authenticateHosted, hostedStatus, HostedWorker, revokeHostedSession, validateHostedConfig } from "./hosted-runtime.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const resources = app.isPackaged ? process.resourcesPath : path.resolve(root, "..");
const controller = path.join(resources, "windows", "scripts", "desktop.ps1");
const bundledPowerShell = path.join(app.isPackaged ? resources : path.join(root, "build"), "powershell", "pwsh.exe");
const manifestPath = path.join(app.isPackaged ? resources : root, "release-manifest.json");
const hostedResource = readJson(path.join(app.isPackaged ? resources : path.join(root, "build"), "hosted-workspace.json"), null);
let hostedConfig, hostedWorker;
const panelFile = path.join(root, "ui", "index.html");
const panelUrl = pathToFileURL(panelFile).href;
const iconFile = app.isPackaged ? path.join(resources, "icon.png")
  : path.join(resources, "source", "public", "brand", "a-border-symbol-192.png");
let internalPackage = false;
try {
  internalPackage = Boolean(validateBundledManifest(readJson(manifestPath, null), app.getVersion())?.localImageId);
} catch { /* initialize reports invalid release resources */ }
const devDataRoot = (!app.isPackaged || internalPackage) ? app.commandLine.getSwitchValue("user-data-dir") : "";
const userData = devDataRoot ? path.resolve(devDataRoot) : path.join(app.getPath("appData"), "A-Border SEO");
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
app.setAppUserModelId("com.aborder.seo");

const settingsPath = path.join(userData, "desktop-settings.json");
const journalPath = path.join(userData, hostedResource ? "hosted-desktop-update.json" : "desktop-update.json");
const currentVersion = app.getVersion();
const partition = hostedResource ? "persist:aborder-hosted-workbench" : "persist:aborder-workbench";
let settings, bundledManifest, journal, tray, panel, workbench, workbenchOrigin, selection;
let status, statusError, result, error, busy;
let closingWorkbench = false;
let quitting = false;
let pendingRefresh;
let panelView = "home";

const { autoUpdater, CancellationToken } = updater;
let candidate, cancellation, prepared = false;
let installerLaunchTimer, previousJournal;
let update = { phase: "idle" };
let automaticUpdatesAvailable = false;
let managedClient, managementError;
let managedBackendVersion = null;

function t(english, chinese) {
  return settings?.language === "zh" ? chinese : english;
}

function releaseSettings() {
  return validateBundledManifest(readJson(manifestPath, null), currentVersion);
}

function setSettings(next) {
  if (settings?.dataRoot && settings.dataRoot !== next.dataRoot) clearLoginNonce(settings.dataRoot);
  saveJson(settingsPath, next);
  settings = next;
  managedClient?.setDataRoot(next.dataRoot);
}

function setJournal(next) {
  if (next) next = { ...next, updatedAt: new Date().toISOString() };
  saveJson(journalPath, next);
  journal = next;
}

function snapshot() {
  return {
    currentVersion, language: settings.language, autoCheck: settings.autoCheck, startOnLaunch: settings.startOnLaunch,
    dataRoot: settings.dataRoot, status, statusError, selection, busy, result, error, update, journal,
    automaticUpdatesAvailable, bundledRelease: Boolean(bundledManifest),
    internalPackage, managed: managedClient?.snapshot() ?? null, managementError,
    view: panelView, hosted: Boolean(hostedConfig), workspaceOrigin: hostedConfig?.workspaceOrigin,
    localWorker: hostedWorker?.snapshot() ?? null,
    backendUpdateAvailable: Boolean(!hostedConfig && status?.configured && bundledManifest && !internalPackage && status.image !== bundledManifest.image),
  };
}

function publish() {
  if (hostedConfig && status?.hosted && hostedWorker) {
    const worker = hostedWorker.snapshot();
    status = { ...status, localWorker: worker, services: { ...status.services, contentWorker: worker.phase },
      codex: { available: worker.available === true, configured: worker.signedIn === true } };
  }
  if (panel && !panel.isDestroyed()) panel.webContents.send("panel:state", snapshot());
}

async function exclusive(action, fn) {
  if (busy) return;
  busy = action;
  result = error = null;
  publish();
  try {
    await pendingRefresh;
    await fn();
  } catch (failure) {
    error = { code: failure.message, details: failure.details };
  } finally {
    busy = null;
    publish();
  }
}

function run(action, options) {
  if (hostedConfig) throw new Error("hosted_action_unavailable");
  const selected = {
    ...settings, bundledPowerShell, managed: Boolean(managedClient),
    context: options?.context || settings.context, project: options?.project || settings.project,
  };
  return runWindowsAction(controller, selected, action, options);
}

async function refresh() {
  if (!pendingRefresh) {
    pendingRefresh = (async () => {
      try {
        status = hostedConfig ? await hostedStatus(hostedConfig, hostedWorker.snapshot(), (url, options) => net.fetch(url, options))
          : await Promise.resolve().then(() => run("Status"));
        managedBackendVersion = status?.backendVersion ?? null;
        statusError = null;
      } catch (failure) {
        status = null;
        managedBackendVersion = null;
        statusError = { code: failure.message, details: failure.details };
      } finally {
        pendingRefresh = null;
        publish();
      }
    })();
  }
  await pendingRefresh;
}

function newWindow(options, preload, extra = {}) {
  return new BrowserWindow({
    show: false, icon: iconFile, backgroundColor: "#090f25", ...options,
    webPreferences: {
      preload: path.join(root, preload), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged, ...extra,
    },
  });
}

function showPanel(view = "settings") {
  panelView = view;
  if (!panel || panel.isDestroyed()) {
    panel = newWindow({ width: 1200, height: 880, minWidth: 600, minHeight: 620 }, "panel-preload.cjs");
    panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    panel.webContents.on("will-frame-navigate", event => event.preventDefault());
    panel.webContents.on("will-redirect", event => event.preventDefault());
    panel.on("close", event => {
      if (!quitting) { event.preventDefault(); panel.hide(); }
    });
    panel.once("ready-to-show", () => panel.show());
    void panel.loadFile(panelFile);
  } else {
    panel.show();
    panel.focus();
  }
  publish();
}

function showHome() { showPanel("home"); }

function noncePath(dataRoot = settings.dataRoot) {
  return path.join(dataRoot, "private", "desktop-maintenance", "login-nonce");
}

function clearLoginNonce(dataRoot = settings.dataRoot) {
  try { unlinkSync(noncePath(dataRoot)); } catch (failure) { if (failure.code !== "ENOENT") throw failure; }
}

function rotateLoginNonce() {
  const file = noncePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const nonce = randomBytes(32).toString("base64url");
  writeFileSync(file, nonce, { mode: 0o600 });
  return nonce;
}

async function authenticateWorkbench(origin) {
  if (!managedClient) return;
  if (hostedConfig) {
    await authenticateHosted(hostedConfig, { ...managedClient.metadata(), accountId: managedClient.snapshot().accountId },
      await managedClient.getCredential(), (url, options) => session.fromPartition(partition).fetch(url, options));
    return;
  }
  const nonce = rotateLoginNonce();
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = managedClient.snapshot();
    if (!current.signedIn) throw new Error("user_login_required");
    const response = await session.fromPartition(partition).fetch(`${origin}/api/desktop/managed-login`, {
      method: "POST", redirect: "error", credentials: "include", signal: AbortSignal.timeout(8000),
      headers: { Origin: origin, "X-Requested-With": "XmlHttpRequest", "Content-Type": "application/json" },
      body: JSON.stringify({ nonce, installationId: current.installationId, accountId: current.accountId, sequence: current.decision.sequence }),
    });
    if (response.ok) return;
    if (response.status !== 403 || managedClient.snapshot().decision.sequence === current.decision.sequence) break;
  }
  throw new Error("workspace_login_failed");
}

function frameMatches(event, window, accepts) {
  return window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && accepts(event.senderFrame.url);
}

function isWorkbenchUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === workbenchOrigin && !parsed.username && !parsed.password;
  } catch { return false; }
}

function guardWorkbench(event) {
  if (!event.isMainFrame || !isWorkbenchUrl(event.url)) event.preventDefault();
}

async function openWorkbench(useBrowser = false) {
  if (managedClient && !managedClient.snapshot().signedIn) throw new Error("user_login_required");
  const decision = managedClient?.snapshot().decision;
  if (decision && !decision.allowed && decision.reason !== "maintenance") throw new Error(decision.reason);
  await refresh();
  const origin = hostedConfig?.workspaceOrigin ?? validWorkbenchOrigin(status?.baseUrl);
  if (!origin || status?.issue || status?.services?.app !== "healthy") throw new Error("app_not_ready");
  const response = await net.fetch(`${origin}/api/health`, {
    redirect: "error", credentials: "omit", signal: AbortSignal.timeout(5000),
  });
  const health = response.ok && await response.json();
  if (health?.status !== "ok") throw new Error("app_not_ready");
  if (managedClient && !hostedConfig) {
    const latest = managedClient.snapshot().decision;
    if (!latest.allowed && latest.reason !== "maintenance") throw new Error(latest.reason);
    if (health.managed?.enabled !== true || health.managed.revision !== latest.revision
      || health.managed.sequence !== latest.sequence) throw new Error("backend_guard_pending");
  }
  if (useBrowser) {
    if (managedClient) throw new Error("use_desktop_workspace");
    await shell.openExternal(origin);
    return;
  }
  if (hostedConfig ? health.hostedMode !== true : health.desktopMode !== true) throw new Error("desktop_backend_required");
  if (workbench && workbenchOrigin !== origin && !await closeWorkbench()) return;
  if (workbench) {
    if (hostedConfig) await authenticateWorkbench(origin);
    workbench.show();
    workbench.focus();
    panel?.hide();
    return;
  }
  await authenticateWorkbench(origin);
  workbenchOrigin = origin;
  workbench = newWindow({ width: 1450, height: 960, minWidth: 900, minHeight: 650 }, "workbench-preload.cjs", { partition });
  workbench.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  workbench.webContents.on("will-frame-navigate", guardWorkbench);
  workbench.webContents.on("will-redirect", guardWorkbench);
  workbench.on("close", event => {
    if (!quitting && !closingWorkbench) { event.preventDefault(); workbench.hide(); }
  });
  workbench.once("closed", () => { workbench = workbenchOrigin = null; });
  workbench.once("ready-to-show", () => { workbench?.show(); panel?.hide(); });
  await workbench.loadURL(origin);
}

async function enterWorkspace() {
  showHome();
  if (managedClient && !managedClient.snapshot().signedIn) return;
  const decision = managedClient?.snapshot().decision;
  if (decision && !decision.allowed && decision.reason !== "maintenance") throw new Error(decision.reason);
  await refresh();
  if (hostedConfig) {
    if (status?.issue) throw new Error(status.issue);
    if (settings.startOnLaunch && decision?.allowed && decision.features.codex) await startHostedWorker();
    await openWorkbench();
    return;
  }
  if (!status?.configured) {
    if (!managedClient) return;
    await actions.Setup({ createVolume: true });
    return;
  }
  if (status.issue) throw new Error(status.issue);
  if (status.services?.app !== "healthy" || status.services?.worker !== "healthy"
    || (managedClient && (status.managedReconfigure || !status.managed?.enabled))) {
    await startServices(true);
  } else await openWorkbench();
}

async function logoutUser() {
  if (workbench && !await confirmSaved()) return;
  await hostedWorker?.stop();
  let remoteLogoutFailed = false;
  if (hostedConfig && managedClient?.snapshot().signedIn) {
    try {
      await revokeHostedSession(hostedConfig, { ...managedClient.metadata(), accountId: managedClient.snapshot().accountId },
        await managedClient.getCredential(), (url, options) => session.fromPartition(partition).fetch(url, options));
    } catch { remoteLogoutFailed = true; }
  }
  await managedClient?.logout();
  if (!hostedConfig) clearLoginNonce();
  await session.fromPartition(partition).clearStorageData();
  await session.fromPartition(partition).clearAuthCache();
  if (remoteLogoutFailed) error = { code: "workspace_logout_unconfirmed" };
  showHome();
}

async function closeWorkbench() {
  if (!workbench) return true;
  const window = workbench;
  closingWorkbench = true;
  try {
    return await new Promise(resolve => {
      function done(closed) {
        clearTimeout(timer);
        window.removeListener("closed", onClosed);
        if (!window.isDestroyed()) window.webContents.removeListener("will-prevent-unload", onPrevented);
        resolve(closed);
      }
      const onClosed = () => done(true);
      const onPrevented = () => { window.show(); done(false); };
      const timer = setTimeout(() => done(false), 5000);
      window.once("closed", onClosed);
      window.webContents.once("will-prevent-unload", onPrevented);
      window.close();
    });
  } finally {
    closingWorkbench = false;
  }
}

async function confirmSaved() {
  const response = await dialog.showMessageBox(workbench?.isVisible() ? workbench : panel, {
    type: "question", title: "A-Border SEO",
    message: t("Save your work before continuing", "继续前请保存工作"),
    detail: t("Save any open edits in the desktop app or browser. Running background work is checked separately.",
      "请先保存桌面窗口或浏览器里的编辑内容。后台操作会另行检查运行中的任务。"),
    buttons: [t("Cancel", "取消"), t("Saved, continue", "已保存，继续")], defaultId: 0, cancelId: 0,
  });
  return response.response === 1 && closeWorkbench();
}

function setUpdate(next) {
  update = next;
  publish();
}

function checkAssignment(version) {
  const assignment = managedClient?.snapshot();
  if (assignment && (assignment.decision.release?.version !== version
    || !assignment.expiresAt || assignment.expiresAt <= Math.floor(Date.now() / 1000)
    || ["clock_invalid", "invalid_lease"].includes(assignment.decision.reason))) {
    throw new Error("managed_release_not_assigned");
  }
}

async function checkUpdate() {
  if (!automaticUpdatesAvailable) throw new Error("updates_unavailable");
  const target = managedClient?.snapshot().decision.release?.version;
  if (managedClient && !target) {
    prepared = false;
    candidate = null;
    setUpdate({ phase: "no_managed_target" });
    return;
  }
  if (prepared && (!managedClient || candidate?.version === target)) return;
  prepared = false;
  candidate = null;
  setUpdate({ phase: "checking" });
  try {
    if (target) {
      autoUpdater.setFeedURL({ provider: "generic", url: `https://github.com/${repository}/releases/download/v${target}/` });
    }
    const check = await autoUpdater.checkForUpdates();
    if (!check?.isUpdateAvailable) {
      setUpdate({ phase: "current" });
      return;
    }
    const { version, releaseNotes } = check.updateInfo;
    checkAssignment(version);
    const manifest = await fetchManifest(version, globalThis.fetch, hostedConfig?.workspaceOrigin);
    candidate = manifest;
    const notes = managedClient?.snapshot().decision.release?.notes
      ?? (typeof releaseNotes === "string" ? releaseNotes : releaseNotes?.map(entry => entry.note).join("\n"));
    setUpdate({ phase: "available", version, notes: notes?.slice(0, 4000) });
  } catch {
    setUpdate({ phase: "check_failed" });
    throw new Error("update_check_failed");
  }
}

async function downloadUpdate() {
  if (!candidate || !automaticUpdatesAvailable || prepared) return;
  checkAssignment(candidate.version);
  if (!status || status.issue) throw new Error("upgrade_status_unavailable");
  if ((!hostedConfig && journal?.version === currentVersion && ["installing", "upgrading", "failed"].includes(journal.phase))
    || (status.upgrade?.phase && status.upgrade.phase !== "complete")) throw new Error("backend_update_incomplete");
  const available = { ...update, phase: "available" };
  const token = new CancellationToken();
  const preparation = new AbortController();
  const prior = journal;
  const pending = { version: candidate.version, image: candidate.image, previousVersion: currentVersion,
    expectedDataRoot: status.configured ? settings.dataRoot : null };
  setJournal({ ...pending, phase: "downloading" });
  token.onCancel(() => preparation.abort());
  cancellation = token;
  try {
    if (status?.configured && !hostedConfig) {
      setUpdate({ ...available, phase: "pulling" });
      await run("Pull", { image: candidate.image, signal: preparation.signal });
    }
    if (token.cancelled) {
      setJournal(prior);
      setUpdate(available);
      return;
    }
    setUpdate({ ...available, phase: "downloading", progress: 0 });
    try {
      await autoUpdater.downloadUpdate(token);
    } catch {
      if (!token.cancelled) throw new Error("update_download_failed");
    }
    prepared = !token.cancelled;
    setJournal(prepared ? { ...pending, phase: "downloaded" } : prior);
    setUpdate({ ...available, phase: prepared ? "downloaded" : "available" });
  } catch (failure) {
    prepared = false;
    setJournal(token.cancelled ? prior : { ...pending, phase: "download_failed" });
    setUpdate(available);
    if (!token.cancelled) {
      await managedClient?.report("failed", "update_download_failed", candidate.version);
      throw failure;
    }
  } finally {
    cancellation = null;
  }
}

async function installUpdate() {
  if (!prepared || !candidate) return;
  await managedClient?.poll({ force: true });
  checkAssignment(candidate.version);
  if (!status || status.issue) throw new Error("upgrade_status_unavailable");
  if (!await confirmSaved()) return;
  await hostedWorker?.stop();
  checkAssignment(candidate.version);
  previousJournal = journal;
  setJournal({ phase: "installing", version: candidate.version, image: candidate.image, previousVersion: currentVersion,
    expectedDataRoot: status?.configured ? settings.dataRoot : null });
  setUpdate({ ...update, phase: "installing" });
  await managedClient?.report("upgrading", "update_installer_started", candidate.version);
  installerLaunchTimer = setTimeout(installerLaunchFailed, 15_000);
  autoUpdater.quitAndInstall(true, true);
}

function installerLaunchFailed() {
  if (!installerLaunchTimer) return;
  clearTimeout(installerLaunchTimer);
  installerLaunchTimer = null;
  try { setJournal(previousJournal); } catch {}
  error = { code: "installer_launch_failed" };
  setUpdate({ ...update, phase: "downloaded" });
  if (managedClient) void managedClient.report("failed", "update_installer_failed", candidate?.version);
}

async function upgradeBackend({ resume = false } = {}) {
  if (hostedConfig) throw new Error("hosted_action_unavailable");
  if (!bundledManifest || internalPackage) throw new Error("invalid_release_manifest");
  if (journal?.version === currentVersion && journal.image !== bundledManifest.image) throw new Error("release_mismatch");
  if (!status || status.issue || (journal?.expectedDataRoot && (
    !status.configured || journal.expectedDataRoot !== settings.dataRoot
  ))) throw new Error("upgrade_status_unavailable");
  if (!resume && !await confirmSaved()) return;
  const { version, image } = bundledManifest;
  const next = { version, image, previousVersion: journal?.previousVersion, phase: "upgrading",
    expectedDataRoot: status.configured ? settings.dataRoot : null };
  setJournal(next);
  await managedClient?.report("upgrading", "update_backend_started", version);
  try {
    if (status?.configured) {
      await run("Pull", { image });
      result = { action: "Upgrade", data: await run("Upgrade", { image, version }) };
    }
    setJournal({ ...next, phase: "complete" });
  } catch (failure) {
    setJournal({ ...next, phase: "failed" });
    await managedClient?.report("failed", "update_backend_failed", version);
    throw failure;
  } finally {
    await refresh();
  }
}

async function startServices(open = false) {
  if (hostedConfig) { await refresh(); await startHostedWorker(); if (open) await openWorkbench(); return; }
  if (journal?.version === currentVersion && ["installing", "failed", "upgrading"].includes(journal.phase)) {
    throw new Error("backend_update_incomplete");
  }
  result = { action: "Start", data: await run("Start") };
  await refresh();
  const decision = managedClient?.snapshot().decision;
  if (open && !result.data?.legacy && status?.services?.app === "healthy"
    && (!decision || decision.allowed || decision.reason === "maintenance")) {
    try { await openWorkbench(); } catch (failure) {
      if (failure.message !== "desktop_backend_required") throw failure;
    }
  }
}

async function stopServices(exit = false) {
  if (!await confirmSaved()) return;
  if (hostedConfig) { await hostedWorker.stop(); await refresh(); if (exit) quit(); return; }
  result = { action: "Stop", data: await run("Stop") };
  await refresh();
  if (exit) quit();
}

function quit() {
  quitting = true;
  if (hostedWorker?.process) void hostedWorker.stop().finally(() => app.quit());
  else app.quit();
}

async function startHostedWorker(mode = "watch") {
  if (!hostedConfig || !managedClient?.snapshot().signedIn) throw new Error("user_login_required");
  const current = managedClient.snapshot();
  if (!current.decision.allowed || !current.decision.features.codex) throw new Error(current.decision.reason ?? "feature_disabled");
  await hostedWorker.start(hostedConfig, { ...managedClient.metadata(), accountId: current.accountId }, await managedClient.getCredential(), mode);
  if (mode === "login") await startHostedWorker();
}

function buildTray() {
  tray ??= new Tray(nativeImage.createFromPath(iconFile).resize({ width: 32, height: 32 }));
  tray.setToolTip("A-Border SEO");
  tray.removeAllListeners("double-click");
  tray.on("double-click", () => void exclusive("EnterWorkspace", enterWorkspace));
  const entries = [
    { label: t("Workspace", "工作台"), click: () => void exclusive("EnterWorkspace", enterWorkspace) },
    { label: t("Settings", "设置"), click: () => showPanel() },
    ...(managedClient ? [{ label: t("Sign out", "退出登录"), click: () => void exclusive("LogoutUser", logoutUser) }] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: t("A-Border SEO", "A-Border SEO"), submenu: [...entries, { type: "separator" },
      { label: t("Quit", "退出应用"), click: () => quit() }] },
    { label: t("Edit", "编辑"), submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
  ]));
  tray.setContextMenu(Menu.buildFromTemplate([
    ...entries,
    { type: "separator" },
    { label: hostedConfig ? t("Exit desktop app", "退出桌面应用") : t("Exit, keep services running", "退出并保留后台"), click: () => void exclusive("Exit", async () => {
      showPanel();
      if (await confirmSaved()) quit();
    }) },
    ...(!hostedConfig ? [{ label: t("Exit and stop services", "退出并停止服务"), click: () => void exclusive("ExitAndStop", async () => {
      showPanel();
      await stopServices(true);
    }) }] : []),
  ]));
}

const actions = {
  ShowSettings: () => showPanel(),
  ShowHome: showHome,
  EnterWorkspace: enterWorkspace,
  LogoutUser: logoutUser,
  async RegisterUser(input) {
    if (!managedClient) throw new Error("management_unavailable");
    await managedClient.register(input);
    result = { action: "RegisterUser" };
    if (!hostedConfig) clearLoginNonce();
    await session.fromPartition(partition).clearStorageData();
    showHome();
  },
  async LoginUser(input) {
    if (!managedClient) throw new Error("management_unavailable");
    await hostedWorker?.stop();
    await managedClient.login(input);
    await session.fromPartition(partition).clearStorageData();
    await enterWorkspace();
  },
  Refresh: refresh,
  async InspectLegacy(input) {
    const context = input?.context?.trim();
    const project = input?.project?.trim();
    if ((context && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(context))
      || (project && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project))) throw new Error("invalid_docker_selection");
    const choice = await dialog.showOpenDialog(panel, { properties: ["openDirectory"] });
    if (choice.canceled) return;
    selection = null;
    const legacyRoot = choice.filePaths[0];
    const data = await run("InspectLegacy", { legacyRoot, context, project });
    selection = { legacyRoot, data };
  },
  async Adopt() {
    if (!selection) return;
    const data = await run("Adopt", {
      legacyRoot: selection.legacyRoot, context: selection.data.context, project: selection.data.project,
    });
    setSettings({ ...settings, dataRoot: data.dataRoot, context: data.context, project: data.project });
    selection = null;
    await refresh();
    if (managedClient && status?.configured && status?.backendVersion === currentVersion) await startServices();
  },
  async Setup(input) {
    if (status?.configured || !bundledManifest) throw new Error("setup_unavailable");
    const googleClientId = input?.googleClientId?.trim();
    const googleClientSecret = input?.googleClientSecret?.trim();
    if ((!managedClient && (!/^[\w.-]{1,200}\.apps\.googleusercontent\.com$/.test(googleClientId ?? "")
      || !/^[\w-]{1,200}$/.test(googleClientSecret ?? ""))) || input?.createVolume !== true) {
      throw new Error("invalid_google_credentials");
    }
    const { image, version, localImageId } = bundledManifest;
    const context = status?.context;
    await run("Pull", { image, version, localImageId, context });
    const data = await run("Setup", { image, version, localImageId, context, input: { googleClientId, googleClientSecret, createVolume: true } });
    setSettings({ ...settings, context: data.context, project: data.project });
    await startServices(true);
  },
  Start: () => startServices(true),
  Stop: () => stopServices(),
  async StartContentWorker() {
    if (hostedConfig) { await startHostedWorker(); await refresh(); return; }
    const decision = managedClient?.snapshot().decision;
    if (decision && (!decision.allowed || !decision.features.codex)) throw new Error(decision.reason ?? "feature_disabled");
    result = { action: "StartContentWorker", data: await run("StartContentWorker") };
    await refresh();
  },
  async StopContentWorker() {
    if (hostedConfig) { await hostedWorker.stop(); await refresh(); return; }
    result = { action: "StopContentWorker", data: await run("StopContentWorker") };
    await refresh();
  },
  async LoginCodex() {
    if (hostedConfig) { await startHostedWorker("login"); await refresh(); return; }
    result = { action: "LoginCodex", data: await run("LoginCodex") };
    await refresh();
  },
  async ActivateManaged(input) {
    if (!managedClient) throw new Error("management_unavailable");
    await managedClient.activate(input?.code);
    await refresh();
  },
  async CheckManaged() {
    await managedClient?.poll({ force: true });
    await observeManaged();
  },
  Open: () => openWorkbench(),
  Browser: () => openWorkbench(true),
  async Backup() { result = { action: "Backup", data: await run("Backup") }; },
  async Logs() { result = { action: "Logs", data: await run("Logs") }; },
  CheckUpdate: checkUpdate,
  async ManualUpdate() {
    const target = managedClient?.snapshot().decision.release?.version;
    if (!hostedConfig || !target) throw new Error("managed_release_not_assigned");
    checkAssignment(target);
    await shell.openExternal(`https://github.com/${repository}/releases/tag/v${target}`);
  },
  DownloadUpdate: downloadUpdate,
  InstallUpdate: installUpdate,
  UpgradeBackend: () => upgradeBackend(),
  async Settings(input) {
    if (!["zh", "en"].includes(input?.language) || typeof input.autoCheck !== "boolean"
      || typeof input.startOnLaunch !== "boolean") throw new Error("invalid_settings");
    setSettings({ ...settings, language: input.language, autoCheck: input.autoCheck, startOnLaunch: input.startOnLaunch });
    buildTray();
  },
};

function setupIpc() {
  ipcMain.handle("workbench:local-codex", async (event, action) => {
    if (!frameMatches(event, workbench, isWorkbenchUrl)) throw new Error("untrusted_frame");
    if (!hostedConfig) return { hosted: false };
    if (action === "login" || action === "start") await exclusive("LocalCodex", () => startHostedWorker(action === "login" ? "login" : "watch"));
    return { hosted: true, ...hostedWorker.snapshot() };
  });
  ipcMain.handle("workbench:account", event => {
    if (frameMatches(event, workbench, isWorkbenchUrl)) showHome();
  });
  ipcMain.handle("workbench:logout", async event => {
    if (frameMatches(event, workbench, isWorkbenchUrl)) await exclusive("LogoutUser", logoutUser);
  });
  ipcMain.handle("panel:read", event => {
    if (frameMatches(event, panel, url => url === panelUrl)) return snapshot();
    return null;
  });
  ipcMain.handle("panel:act", async (event, action, input) => {
    if (!frameMatches(event, panel, url => url === panelUrl)) return;
    if (action === "CancelDownload") cancellation?.cancel();
    else if (typeof action === "string" && Object.hasOwn(actions, action)) await exclusive(action, () => actions[action](input));
  });
  ipcMain.handle("workbench:external", async (event, url) => {
    if (!frameMatches(event, workbench, isWorkbenchUrl)) throw new Error("untrusted_frame");
    const target = workbenchExternal(url, workbenchOrigin);
    if (!target) throw new Error("external_link_blocked");
    await shell.openExternal(target);
  });
  ipcMain.handle("workbench:link", async (event, raw) => {
    if (!frameMatches(event, workbench, isWorkbenchUrl) || typeof raw !== "string" || raw.length > 8192) return;
    const url = new URL(raw);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) await shell.openExternal(url.href);
  });
}

function setupUpdater() {
  autoUpdater.logger = null;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.on("error", installerLaunchFailed);
  electronAutoUpdater.on("before-quit-for-update", () => {
    clearTimeout(installerLaunchTimer);
    installerLaunchTimer = null;
    quitting = true;
  });
  autoUpdater.on("download-progress", ({ percent }) => {
    setUpdate({ ...update, progress: Math.round(percent) });
  });
  // Signed production builds embed publisherName. Without it, electron-updater
  // cannot enforce the installed publisher identity, so use manual installers.
  if (app.isPackaged && (hostedConfig || bundledManifest && !internalPackage)) {
    try {
      automaticUpdatesAvailable = /^publisherName:[ \t]*(?:\r?\n[ \t]*-[ \t]+)?\S/m.test(
        readFileSync(path.join(resources, "app-update.yml"), "utf8"),
      );
    } catch { automaticUpdatesAvailable = false; }
  }
}

async function initializeManagement() {
  const filename = path.join(app.isPackaged ? resources : path.join(root, "build"), "management-config.json");
  const raw = readJson(filename, null);
  if (!raw) return;
  const protocolPath = app.isPackaged ? path.join(resources, "managed-protocol.mjs")
    : path.join(resources, "source", "lib", "managed", "protocol.mjs");
  const protocol = await import(pathToFileURL(protocolPath).href);
  const config = protocol.validateConfig(raw, { allowHttpLoopback: !app.isPackaged });
  if (config.productId !== "a-border-seo") throw new Error("invalid_management_config");
  managedClient = new ManagedClient({
    protocol, config, file: path.join(userData, "management-identity.json"), dataRoot: settings.dataRoot, desktopVersion: currentVersion,
    async seal(secret) {
      if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error("device_credential_unavailable");
      return (await safeStorage.encryptStringAsync(secret)).toString("base64");
    },
    async open(encrypted) {
      if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error("device_credential_unavailable");
      return (await safeStorage.decryptStringAsync(Buffer.from(encrypted, "base64"))).result;
    },
    requireUser: true,
    versions: () => ({ backendVersion: managedBackendVersion }),
    onChange() {
      const decision = managedClient?.snapshot().decision;
      if (hostedWorker && (!managedClient?.snapshot().signedIn || !decision?.allowed || !decision.features.codex)) void hostedWorker.stop();
      if (workbench?.isVisible() && decision && !decision.allowed && decision.reason !== "maintenance") {
        workbench.hide();
        showHome();
      }
      publish();
    },
  });
}

let observingManaged = false;
async function observeManaged() {
  if (!managedClient || !status?.configured || observingManaged) return;
  observingManaged = true;
  try {
    if (hostedConfig) {
      await refresh();
      const verified = await managedClient.observeHostedUpdate(status);
      if (verified && journal?.phase === "installing" && journal.version === currentVersion) {
        setJournal({ ...journal, phase: "complete" });
      }
      return;
    }
    if (busy && ["UpgradeBackend", "InstallUpdate"].includes(busy)) return;
    const origin = validWorkbenchOrigin(status.baseUrl);
    if (!origin) return;
    const response = await globalThis.fetch(`${origin}/api/health`, {
      redirect: "error", credentials: "omit", signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) { managedBackendVersion = null; return; }
    const health = await response.json();
    managedBackendVersion = health.version ?? null;
    const decision = managedClient.snapshot().decision;
    if (!decision.sequence) return;
    const gate = health.managed;
    if (gate?.enabled !== true) {
      await managedClient.report("failed", "backend_guard_missing");
    } else if (gate.revision === decision.revision && gate.sequence === decision.sequence) {
      if (gate.phase === "effective") {
        const upgraded = journal?.phase === "complete" && health.version === currentVersion && journal.version === currentVersion
          && decision.release?.version === currentVersion;
        await managedClient.report("effective", upgraded ? "update_verified" : (gate.reason ?? "policy_applied"),
          upgraded ? currentVersion : undefined);
      } else if (gate.phase === "draining" || gate.phase === "failed") {
        await managedClient.report(gate.phase, gate.reason ?? "worker_enforcement_pending");
      }
    }
  } catch { managedBackendVersion = null; }
  finally { observingManaged = false; }
}

async function tickManagement() {
  if (!managedClient) return;
  try {
    const previous = managedClient.snapshot().decision.release?.version;
    await managedClient.tick();
    managementError = null;
    await observeManaged();
    const target = managedClient.snapshot().decision.release?.version;
    if (target && previous !== target && !busy && automaticUpdatesAvailable && settings.autoCheck) {
      void exclusive("CheckUpdate", checkUpdate);
    }
  } catch {
    managementError = "management_state_unavailable";
    publish();
  }
}

async function initialize() {
  settings = readJson(settingsPath, {
    dataRoot: path.join(userData, "data"), language: app.getLocale().startsWith("zh") ? "zh" : "en",
    autoCheck: true, startOnLaunch: true,
  });
  if (typeof settings.dataRoot !== "string" || !path.isAbsolute(settings.dataRoot)) throw new Error("invalid_state");
  hostedConfig = hostedResource ? validateHostedConfig(hostedResource, { allowHttpLoopback: !app.isPackaged }) : null;
  bundledManifest = hostedConfig ? null : releaseSettings();
  journal = readJson(journalPath, null);
  await initializeManagement();
  if (hostedConfig && !managedClient) throw new Error("management_unavailable");
  if (hostedConfig) hostedWorker = new HostedWorker({ fork: utilityProcess.fork.bind(utilityProcess),
    entry: path.join(app.isPackaged ? resources : path.join(resources, "source"), "local-worker", "index.mjs"),
    directory: path.join(userData, "hosted-local"), onChange: publish });
  if (!hostedConfig) clearLoginNonce();
  const workbenchSession = session.fromPartition(partition);
  workbenchSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  workbenchSession.setPermissionCheckHandler(() => false);
  setupUpdater();
  setupIpc();
  showHome();
  buildTray();
  await refresh();
  if (managedClient) {
    await tickManagement();
    setInterval(() => void tickManagement(), 7000);
  }
  if (hostedConfig) {
    if (managedClient.snapshot().signedIn) await exclusive("EnterWorkspace", enterWorkspace);
  } else if (journal?.version === currentVersion && ["installing", "upgrading"].includes(journal.phase) && status) {
    await exclusive("UpgradeBackend", () => upgradeBackend({ resume: true }));
  } else if ((!managedClient || managedClient.snapshot().signedIn) && status?.configured && !status.issue && status.docker?.available
    && (settings.startOnLaunch || (managedClient && status.managedReconfigure
      && ["healthy", "running", "starting", "unhealthy"].includes(status.services?.app)))
    && journal?.phase !== "failed") {
    if (status.services?.app !== "healthy" || status.services?.worker !== "healthy"
      || (managedClient && (status.managedReconfigure || !status.managed?.enabled))) {
      await exclusive("Start", () => startServices(true));
    } else if (status.desktopMode && (!managedClient || managedClient.snapshot().decision.allowed)) {
      await exclusive("Open", () => openWorkbench());
    }
  }
  if (managedClient?.snapshot().signedIn && !status?.configured && !busy && !error) {
    await exclusive("EnterWorkspace", enterWorkspace);
  }
  const autoCheck = () => {
    if (automaticUpdatesAvailable && settings.autoCheck && !busy) void exclusive("CheckUpdate", checkUpdate);
  };
  setTimeout(autoCheck, 5000);
  setInterval(autoCheck, 24 * 60 * 60 * 1000);
  setInterval(() => { if (!busy && panel?.isVisible()) void refresh(); }, 12_000);
  powerMonitor.on("resume", () => {
    if (!busy) void refresh();
    if (managedClient) void managedClient.poll({ force: true });
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (settings) void exclusive("EnterWorkspace", enterWorkspace); });
  app.on("before-quit", event => {
    if (busy && !quitting) event.preventDefault();
    else if (hostedWorker?.process) { event.preventDefault(); quitting = true; void hostedWorker.stop().finally(() => app.quit()); }
    else quitting = true;
  });
  app.whenReady().then(initialize).catch(() => {
    dialog.showErrorBox("A-Border SEO", "The desktop application could not read its local settings or release resources.");
    quit();
  });
}
