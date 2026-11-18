import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const repository = "xiaobaikekishuo/A-Border-SEO";
const registryImage = /^ghcr\.io\/xiaobaikekishuo\/a-border-seo@sha256:[a-f0-9]{64}$/;
const dockerImageId = /^sha256:[a-f0-9]{64}$/;
const stableVersion = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const assetHosts = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const timeouts = {
  Status: 40_000,
  InspectLegacy: 60_000,
  Adopt: 120_000,
  Setup: 180_000,
  Start: 720_000,
  Stop: 180_000,
  StartContentWorker: 90_000,
  StopContentWorker: 90_000,
  LoginCodex: 240_000,
  Backup: 720_000,
  Logs: 60_000,
  Pull: 720_000,
  Upgrade: 1_800_000,
};

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error("invalid_state");
  }
}

export function saveJson(file, value) {
  const next = file + ".next";
  writeFileSync(next, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(next, file);
}

function validateManifestFields(value, version, workspaceOrigin) {
  if (!stableVersion.test(version) || value?.schemaVersion !== 1 || value.version !== version
    || value.backendVersion !== version
    || !/^[a-f0-9]{40}$/.test(value.commit)
    || value.platform !== "win32-x64" || value.backendPlatform !== "linux/amd64"
    || (workspaceOrigin ? value.desktopMode !== "hosted" || value.workspaceOrigin !== workspaceOrigin
      : value.desktopMode === "hosted" || value.minimumPowerShell !== "7.3.0")
    || !Array.isArray(value.migrations)
    || value.migrations.some(name => !/^\d{14}_[a-zA-Z0-9_-]+$/.test(name))) {
    throw new Error("invalid_release_manifest");
  }
  return value;
}

export function validateManifest(value, version, workspaceOrigin) {
  validateManifestFields(value, version, workspaceOrigin);
  if (value.localImageId !== undefined || !registryImage.test(value.image)
    || value.imageTag !== `ghcr.io/xiaobaikekishuo/a-border-seo:${version}`) {
    throw new Error("invalid_release_manifest");
  }
  return value;
}

export function validateBundledManifest(value, version) {
  if (!value || (value.image === "" && value.imageTag === "" && value.localImageId === undefined)) return null;
  if (value.localImageId === undefined) return validateManifest(value, version);
  validateManifestFields(value, version);
  if (!dockerImageId.test(value.localImageId) || value.image !== `aborder-seo-internal:${version}`
    || value.imageTag !== value.image) throw new Error("invalid_release_manifest");
  return value;
}

export async function fetchManifest(version, fetcher, workspaceOrigin) {
  if (!stableVersion.test(version)) throw new Error("invalid_release_manifest");
  let url = new URL(`https://github.com/${repository}/releases/download/v${version}/desktop-release.json`);
  const signal = AbortSignal.timeout(30_000);
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== "https:" || url.username || url.password || url.port || !assetHosts.has(url.hostname)) {
      throw new Error("invalid_release_redirect");
    }
    const response = await fetcher(url.href, { redirect: "manual", signal, credentials: "omit" });
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      url = new URL(response.headers.get("location"), url);
      await response.body?.cancel();
      continue;
    }
    if (!response.ok || !response.body) throw new Error("release_manifest_unavailable");
    const reader = response.body.getReader();
    let length = 0;
    const buffers = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65_536) {
        await reader.cancel();
        throw new Error("invalid_release_manifest");
      }
      buffers.push(Buffer.from(value));
    }
    return validateManifest(JSON.parse(Buffer.concat(buffers).toString("utf8")), version, workspaceOrigin);
  }
  throw new Error("invalid_release_redirect");
}

export function validWorkbenchOrigin(value) {
  return value === "http://localhost:3300" ? value : null;
}

export function workbenchExternal(raw, origin) {
  if (typeof raw !== "string" || raw.length > 8192) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password || url.hash) return null;
  if (url.origin === origin && url.pathname === "/desktop/oauth/login") {
    const parameters = [...url.searchParams];
    return parameters.length === 1 && parameters[0][0] === "id" && /^[\w-]{43}$/.test(parameters[0][1])
      ? url.href : null;
  }
  if (url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth"
    && url.searchParams.getAll("redirect_uri").length === 1
    && [`${origin}/desktop/oauth/ga4/callback`, `${origin}/desktop/oauth/google/callback`, `${origin}/api/auth/callback/google`]
      .includes(url.searchParams.get("redirect_uri"))) return url.href;
  if (url.origin === "https://auth.openai.com" && url.pathname === "/api/accounts/authorize"
    && url.searchParams.getAll("redirect_uri").length === 1
    && url.searchParams.get("redirect_uri") === `http://127.0.0.1:${new URL(origin).port}/auth/chatgpt/callback`) return url.href;
  if (url.href === "https://chatgpt.com/settings/usage") return url.href;
  return null;
}

let verifiedPowerShell;

async function findPowerShell(bundledExecutable) {
  if (verifiedPowerShell && existsSync(verifiedPowerShell)) return verifiedPowerShell;
  const folders = [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7"),
    ...(process.env.PATH ?? "").split(path.delimiter)];
  let installed = false;
  const candidates = [bundledExecutable, ...folders.filter(folder => path.isAbsolute(folder)).map(folder => path.join(folder, "pwsh.exe"))];
  for (const executable of new Set(candidates)) {
    if (!executable) continue;
    if (!existsSync(executable)) continue;
    installed = true;
    const version = await new Promise(resolve => {
      execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
        { windowsHide: true, timeout: 8000, maxBuffer: 4096 }, (error, stdout) => resolve(error ? "" : stdout.trim()));
    });
    const parts = /^(\d+)\.(\d+)\.\d+(?:\.\d+)?$/.exec(version);
    if (parts && (Number(parts[1]) > 7 || (parts[1] === "7" && Number(parts[2]) >= 3))) {
      verifiedPowerShell = executable;
      return executable;
    }
  }
  throw new Error(installed ? "powershell_version" : "powershell_missing");
}

export async function runWindowsAction(script, settings, action, { legacyRoot, image, version, localImageId, input, signal } = {}) {
  if (!Object.hasOwn(timeouts, action)) throw new Error("invalid_action");
  if (version !== undefined && !stableVersion.test(version)) throw new Error("invalid_release_manifest");
  if (localImageId !== undefined) {
    if (!["Pull", "Setup", "Start"].includes(action) || !version || !dockerImageId.test(localImageId)
      || image !== `aborder-seo-internal:${version}`) throw new Error("invalid_release_manifest");
  } else if (image !== undefined && !registryImage.test(image)) throw new Error("invalid_release_manifest");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", script, "-Action", action,
    "-DataRoot", settings.dataRoot];
  if (settings.managed) args.push("-Managed");
  for (const [name, value] of Object.entries({
    DockerContext: settings.context, Project: settings.project, LegacyRoot: legacyRoot,
    Image: image, Version: version, LocalImageId: localImageId,
  })) {
    if (value) args.push("-" + name, value);
  }
  const executable = await findPowerShell(settings.bundledPowerShell);
  const dockerFolders = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "DockerDesktop", "resources", "bin"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Docker", "Docker", "resources", "bin"),
  ].filter(folder => folder && existsSync(path.join(folder, "docker.exe")));
  // Docker's installed CLI is also available when Explorer has an older PATH.
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "Path";
  env[pathKey] = [...dockerFolders, env[pathKey]].filter(Boolean).join(path.delimiter);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, cwd: path.dirname(script), env, signal });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.length > 1_048_576) {
        child.kill();
        reject(new Error("controller_output_too_large"));
      }
    });
    // The controller returns sanitized errors and diagnostics on stdout.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(input ? JSON.stringify(input) : undefined);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("controller_timeout"));
    }, timeouts[action]);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("controller_unavailable"));
    });
    child.once("close", code => {
      clearTimeout(timer);
      let result;
      try { result = JSON.parse(output.replace(/^\uFEFF/, "")); } catch {}
      if (code === 0 && result?.ok === true) {
        resolve(result.data);
      } else {
        const error = new Error(/^[a-zA-Z0-9_-]{1,80}$/.test(result?.code) ? result.code : "controller_failed");
        if (typeof result?.error === "string") error.details = result.error.slice(0, 1000);
        reject(error);
      }
    });
  });
}
