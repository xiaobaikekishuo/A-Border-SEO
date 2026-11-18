import path from "node:path";
import { mkdirSync } from "node:fs";

const trustedHosts = new Set(["aborder.tuitehao.shop"]);
const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const tokenPattern = /^[a-zA-Z0-9_-]{32,200}$/;
const versionPattern = /^\d+\.\d+\.\d+$/;

/** This is a bundled build resource, never renderer input or a user setting. */
export function validateHostedConfig(raw, { allowHttpLoopback = false } = {}) {
  if (!raw || raw.schemaVersion !== 1 || raw.productId !== "a-border-seo") throw new Error("invalid_hosted_config");
  let url;
  try { url = new URL(raw.workspaceOrigin); } catch { throw new Error("invalid_hosted_config"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || !(url.protocol === "https:" && !url.port && trustedHosts.has(url.hostname)
      || allowHttpLoopback && loopback && url.protocol === "http:")) throw new Error("invalid_hosted_config");
  return Object.freeze({ schemaVersion: 1, productId: "a-border-seo", workspaceOrigin: url.origin });
}

export function hostedIdentity(metadata, token) {
  if (!id.test(metadata?.installationId ?? "") || !id.test(metadata?.accountId ?? "")
    || metadata.productId !== "a-border-seo" || !versionPattern.test(metadata.desktopVersion ?? "")
    || !tokenPattern.test(token ?? "")) throw new Error("device_credential_unavailable");
  return { productId: metadata.productId, installationId: metadata.installationId,
    accountId: metadata.accountId, desktopVersion: metadata.desktopVersion };
}

export async function authenticateHosted(config, metadata, token, fetcher) {
  const identity = hostedIdentity(metadata, token);
  const response = await fetcher(config.workspaceOrigin + "/api/hosted/session", {
    method: "POST", redirect: "error", credentials: "include", signal: AbortSignal.timeout(12_000),
    headers: { Authorization: `Bearer ${token}`, Origin: config.workspaceOrigin,
      "Content-Type": "application/json", "X-Requested-With": "XmlHttpRequest" },
    body: JSON.stringify(identity),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "user_login_required" : "workspace_login_failed");
  const body = await response.text();
  if (body.length > 8000) throw new Error("workspace_login_failed");
  let result;
  try { result = JSON.parse(body); } catch { throw new Error("workspace_login_failed"); }
  if (result?.ok !== true || result.hostedMode !== true) throw new Error("workspace_login_failed");
}

export async function revokeHostedSession(config, metadata, token, fetcher) {
  const identity = hostedIdentity(metadata, token);
  try {
    const response = await fetcher(config.workspaceOrigin + "/api/hosted/session", {
      method: "DELETE", redirect: "error", credentials: "include", signal: AbortSignal.timeout(12_000),
      headers: { Authorization: `Bearer ${token}`, Origin: config.workspaceOrigin,
        "Content-Type": "application/json", "X-Requested-With": "XmlHttpRequest" }, body: JSON.stringify(identity),
    });
    const body = await response.text();
    if (!response.ok || body.length > 4096 || JSON.parse(body)?.ok !== true) throw new Error();
  } catch { throw new Error("workspace_logout_unconfirmed"); }
}

export async function hostedStatus(config, worker, fetcher) {
  const status = { hosted: true, configured: true, desktopMode: true, baseUrl: config.workspaceOrigin,
    issue: null, backendVersion: null, services: { app: "unavailable", contentWorker: worker.phase },
    codex: { available: worker.available === true, configured: worker.signedIn === true }, localWorker: worker };
  try {
    const response = await fetcher(config.workspaceOrigin + "/api/health", {
      redirect: "error", credentials: "omit", signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    if (!response.ok || text.length > 16000) throw new Error();
    const health = JSON.parse(text);
    if (health.status !== "ok" || health.hostedMode !== true || !versionPattern.test(health.version ?? "")) throw new Error();
    status.backendVersion = health.version;
    status.services.app = "healthy";
  } catch { status.issue = "hosted_workspace_unavailable"; }
  return status;
}

const environmentNames = ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "TEMP", "TMP", "HOME", "LANG", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];
export function hostedWorkerEnvironment(config, metadata, token, directory, env = process.env) {
  const identity = hostedIdentity(metadata, token);
  const out = Object.fromEntries(environmentNames.filter(name => env[name]).map(name => [name, env[name]]));
  return { ...out, ABORDER_HOSTED_WORKER: "1", ABORDER_WORKER_ALLOW_REMOTE: "1", ABORDER_URL: config.workspaceOrigin,
    ABORDER_INSTALLATION_ID: identity.installationId, ABORDER_PRODUCT_ID: identity.productId,
    ABORDER_ACCOUNT_ID: identity.accountId, ABORDER_DESKTOP_VERSION: identity.desktopVersion,
    LOCAL_CONTENT_WORKER_TOKEN: token, ABORDER_CODEX_HOME: path.join(directory, "codex"),
    ABORDER_WORKER_RUNTIME: path.join(directory, "worker") };
}

const workerCodes = new Set(["worker_api_failed", "worker_token_invalid", "codex_executable_missing", "chatgpt_login_required",
  "worker_failed", "worker_stopped", "chatgpt_usage_limit", "codex_generation_failed", "generation_timeout", "invalid_model_output"]);
export class HostedWorker {
  constructor({ fork, entry, directory, onChange = () => {} }) {
    Object.assign(this, { fork, entry, directory, onChange });
    this.process = null;
    this.state = { phase: "stopped", available: null, signedIn: null, error: null };
  }
  snapshot() { return { ...this.state }; }
  update(next) { this.state = { ...this.state, ...next }; this.onChange(); }
  async stop() {
    if (this.stopping) return this.stopping;
    const child = this.process;
    if (!child) return;
    this.update({ phase: "stopping" });
    this.stopping = new Promise(resolve => {
      let timer;
      const done = () => { clearTimeout(timer); resolve(); };
      child.once("exit", done);
      timer = setTimeout(() => { child.kill(); done(); }, 4000);
      try { child.postMessage({ type: "stop" }); } catch { child.kill(); done(); }
    });
    await this.stopping;
    this.stopping = null;
    if (this.process === child) this.process = null;
    this.update({ phase: "stopped" });
  }
  async start(config, metadata, token, mode = "watch") {
    if (this.process && mode === "watch") return;
    await this.stop();
    hostedIdentity(metadata, token);
    const env = hostedWorkerEnvironment(config, metadata, token, path.join(this.directory, metadata.accountId));
    mkdirSync(env.ABORDER_WORKER_RUNTIME, { recursive: true });
    this.update({ phase: mode === "login" ? "signing_in" : "starting", error: null });
    const child = this.fork(this.entry, ["--" + mode], { env, cwd: this.directory, stdio: "pipe", serviceName: "A-Border local Codex worker" });
    this.process = child;
    // Child stdout may include interactive login links. It never reaches the renderer or logs.
    child.stdout?.resume(); child.stderr?.resume();
    child.on("error", () => { if (this.process === child) this.update({ phase: "failed", error: "worker_failed" }); });
    child.on("message", message => {
      if (this.process !== child || message?.type !== "worker-state") return;
      const next = {};
      if (["starting", "running", "waiting_login", "working", "stopped", "failed"].includes(message.phase)) next.phase = message.phase;
      if (typeof message.available === "boolean") next.available = message.available;
      if (typeof message.signedIn === "boolean") next.signedIn = message.signedIn;
      if (message.error === null || workerCodes.has(message.error)) next.error = message.error;
      this.update(next);
    });
    const exited = new Promise(resolve => child.once("exit", code => {
      if (this.process === child) { this.process = null; this.update({ phase: code === 0 ? "stopped" : "failed", ...(code ? { error: this.state.error ?? "worker_failed" } : {}) }); }
      resolve(code);
    }));
    if (mode === "login") {
      const code = await exited;
      if (code !== 0) throw new Error("chatgpt_login_required");
    }
  }
}
