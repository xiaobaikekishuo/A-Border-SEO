#!/usr/bin/env node
// A-Border SEO local Codex worker (macOS, Linux, Windows; Node.js 22+, no dependencies).
//
// Claims "Codex local" drafting jobs from the app, runs Codex in a read-only,
// tool-free sandbox with the job's prompt and output schema, and sends the
// JSON answer back. ChatGPT-connection jobs are handed to the app's own
// /api/local-content-worker/chatgpt route. See local-worker/README.md.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  API_TIMEOUT_MS, HEARTBEAT_MS, LIMITS, POLL_MS, START_CODES, childEnv, execArgs, failureFromExit, generateToken, loginArgs,
  parseConfig, promptText, safeCode, schemaText, signInArgs, summarizeEvents, tokenFrom, validateClaim,
} from "./lib.mjs";

const HELP = `A-Border SEO 本地 Codex worker

用法：node local-worker/index.mjs [--watch | --once | --check | --login | --generate-token]

  --watch           持续领取任务（默认）
  --once            最多处理一个任务后退出
  --check           检查配置、令牌、Codex 登录和与后台的连接后退出
  --login           用 ChatGPT 账号登录 worker 专用的 Codex 目录（只需一次）
  --generate-token  生成一个新的 worker 令牌后退出

环境变量：
  LOCAL_CONTENT_WORKER_TOKEN   与后台 .env 中相同的令牌（或用 ABORDER_WORKER_TOKEN_FILE 指向保存令牌的文件）
  ABORDER_URL                  后台地址，默认 http://localhost:3300
  ABORDER_CODEX_BIN            Codex 命令或完整路径，默认 codex
  ABORDER_CODEX_HOME           Codex 专用登录目录，默认 ~/.aborder-seo/codex
  ABORDER_CODEX_MODEL          指定模型（可选）
  ABORDER_CODEX_REASONING      推理强度 minimal/low/medium/high/xhigh，默认 low
  ABORDER_CODEX_TIMEOUT_SECONDS 单个任务的时限，30–540 秒，默认 540
  ABORDER_CODEX_DISABLE_FEATURES 关闭的 Codex 功能（逗号分隔），默认关闭全部工具类功能
  ABORDER_CODEX_EXTRA_ARGS     追加给 codex exec 的参数（JSON 数组，高级用法）
  ABORDER_WORKER_RUNTIME       锁文件、日志和临时目录，默认 ~/.aborder-seo/worker
`;

const workerId = "local-" + randomBytes(16).toString("hex");
const stop = new AbortController();
let child = null;

function stamp() { return new Date().toISOString(); }
async function log(config, event, fields = {}) {
  // Only event codes, ids and counts: never prompts, answers, tokens or Codex output.
  const line = JSON.stringify({ at: stamp(), event, ...fields });
  console.log(`[${stamp()}] ${event}${fields.jobId ? " " + fields.jobId : ""}${fields.code ? " " + fields.code : ""}`);
  if (!config) return;
  const file = join(config.runtime, "worker.log");
  try {
    const info = await stat(file).catch(() => null);
    if (info && info.size > 262_144) await rename(file, file + ".1").catch(() => {});
    await appendFile(file, line + "\n", { mode: 0o600 });
  } catch { /* logging never stops the worker */ }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}
async function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) throw new Error("worker_already_running");
      await rm(path, { force: true });
    }
  }
  throw new Error("worker_already_running");
}

/** The Codex executable: ABORDER_CODEX_BIN, the newest Codex desktop CLI on Windows, else "codex" on PATH. */
async function resolveCodex(config) {
  if (config.codexBin) {
    // .cmd/.bat would need a shell, which would also interpret the arguments.
    if (config.platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(config.codexBin)) throw new Error("codex_executable_unsupported");
    return config.codexBin;
  }
  if (config.platform === "win32" && process.env.LOCALAPPDATA) {
    const root = join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    const found = [];
    for (const name of await readdir(root).catch(() => [])) {
      const candidate = join(root, name, "codex.exe");
      const info = await stat(candidate).catch(() => null);
      if (info?.isFile()) found.push({ candidate, time: info.mtimeMs });
    }
    found.sort((a, b) => b.time - a.time);
    if (found.length) return found[0].candidate;
  }
  return "codex";
}

function killTree(proc, platform) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (platform === "win32") spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-proc.pid, "SIGKILL");
  } catch { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }
}

/** Runs a command without a shell, with bounded output and a deadline. */
function runProcess(command, args, { env, cwd, input = "", timeoutMs, stdoutLimit = LIMITS.stdoutBytes, stderrLimit = LIMITS.stderrBytes, platform }) {
  return new Promise((resolvePromise, reject) => {
    let proc;
    try {
      proc = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(error?.code === "ENOENT" ? "codex_executable_missing" : "codex_generation_failed"));
      return;
    }
    child = proc;
    const out = [], err = [];
    let outBytes = 0, errBytes = 0, overflow = false, timedOut = false, settled = false;
    const finish = (fn) => { if (!settled) { settled = true; clearTimeout(timer); stop.signal.removeEventListener("abort", onStop); if (child === proc) child = null; fn(); } };
    const timer = setTimeout(() => { timedOut = true; killTree(proc, platform); }, timeoutMs);
    const onStop = () => killTree(proc, platform);
    stop.signal.addEventListener("abort", onStop, { once: true });
    proc.stdout.on("data", chunk => {
      outBytes += chunk.length;
      if (outBytes > stdoutLimit) { overflow = true; killTree(proc, platform); return; }
      out.push(chunk);
    });
    proc.stderr.on("data", chunk => {
      errBytes += chunk.length;
      if (errBytes > stderrLimit) { overflow = true; killTree(proc, platform); return; }
      err.push(chunk);
    });
    proc.on("error", error => finish(() => reject(new Error(error?.code === "ENOENT" ? "codex_executable_missing" : "codex_generation_failed"))));
    proc.on("close", code => finish(() => resolvePromise({
      exitCode: code ?? -1, timedOut, overflow,
      stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"),
    })));
    proc.stdin.on("error", () => { /* the process may exit before reading all input */ });
    proc.stdin.end(input, "utf8");
  });
}

async function api(config, token, body, { path = "/api/local-content-worker", timeoutMs = API_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetch(config.baseUrl + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      // Not tied to the stop signal: a stopping worker still reports the job it gives up.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw new Error("worker_api_failed"); }
  const text = await response.text().catch(() => "");
  if (text.length > LIMITS.apiResponseBytes) throw new Error("worker_api_failed");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: response.status, ok: response.ok, data };
}

async function ensureLogin(config, codex) {
  const result = await runProcess(codex, loginArgs(), {
    env: childEnv(process.env, config), cwd: config.runtime, timeoutMs: 30_000, platform: config.platform,
  });
  if (result.timedOut || result.exitCode !== 0 || !/Logged in using ChatGPT/i.test(result.stdout + "\n" + result.stderr)) throw new Error("chatgpt_login_required");
}

function failure(code, usage = null) {
  const error = new Error(code);
  error.usage = usage;
  return error;
}

async function runCodex(config, codex, job) {
  const schema = schemaText(job.outputSchema);
  const prompt = promptText(job.prompt);
  await ensureLogin(config, codex);
  const jobs = join(config.runtime, "jobs");
  await mkdir(jobs, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(jobs, "job-"));
  try {
    await writeFile(join(directory, "schema.json"), schema, { mode: 0o600 });
    const run = await runProcess(codex, execArgs(config, directory), {
      env: childEnv(process.env, config), cwd: directory, input: prompt, timeoutMs: config.timeoutSeconds * 1000, platform: config.platform,
    });
    if (stop.signal.aborted) throw failure("worker_stopped");
    if (run.timedOut) throw failure("generation_timeout");
    if (run.overflow) throw failure("cli_output_limit");
    const summary = summarizeEvents(run.stdout);
    const exitFailure = failureFromExit(run.exitCode, run.stdout + "\n" + run.stderr);
    if (exitFailure) throw failure(exitFailure, summary.usage);
    if (summary.invalidEventCount) throw failure("invalid_cli_event", summary.usage);
    if (summary.unexpectedItemTypes.length) throw failure("unexpected_tool_event", summary.usage);
    const answerFile = join(directory, "answer.json");
    const info = await stat(answerFile).catch(() => null);
    if (!info?.isFile() || info.size === 0 || info.size > LIMITS.answerBytes) throw failure("invalid_model_output", summary.usage);
    let answer;
    try { answer = JSON.parse(await readFile(answerFile, "utf8")); } catch { throw failure("invalid_model_output", summary.usage); }
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw failure("invalid_model_output", summary.usage);
    return { answer, usage: summary.usage };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function processJob(config, token, codex, job) {
  const ids = { jobId: job.jobId };
  const lease = { jobId: job.jobId, leaseToken: job.leaseToken };
  // The lease lasts 120 s; a heartbeat every 30 s keeps it while Codex works.
  const heartbeat = setInterval(() => {
    void api(config, token, { action: "heartbeat", workerId, ...lease }).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    if (job.provider === "CHATGPT_APP") {
      // The app runs this one with the connected ChatGPT plan and records the result itself.
      const result = await api(config, token, lease, { path: "/api/local-content-worker/chatgpt", timeoutMs: 560_000 });
      await log(config, result.ok && result.data?.ok === true ? "chatgpt_job_completed" : "chatgpt_job_failed", ids);
      return;
    }
    if (job.provider !== "CODEX_LOCAL") throw failure("unsupported_provider");
    const { answer, usage } = await runCodex(config, codex, job);
    const done = await api(config, token, { action: "complete", ...lease, result: answer, ...(usage ? { usage } : {}) });
    // 400: the server's schema check refused the answer.
    if (done.status === 400 || done.status === 422) throw failure("invalid_model_output", usage);
    if (!done.ok) throw failure("worker_api_failed", usage);
    await log(config, "job_completed", ids);
  } catch (error) {
    const code = stop.signal.aborted ? "worker_stopped" : safeCode(error);
    const usage = error?.usage ?? null;
    await api(config, token, { action: "fail", ...lease, error: code, ...(usage ? { usage } : {}) }).catch(() => {});
    await log(config, "job_failed", { ...ids, code });
  } finally {
    clearInterval(heartbeat);
  }
}

async function check(config, token) {
  const codex = await resolveCodex(config);
  console.log(`后台地址：${config.baseUrl}`);
  console.log(`Codex：${codex}`);
  console.log(`Codex 登录目录：${config.codexHome}`);
  const version = await runProcess(codex, ["--version"], { env: childEnv(process.env, config), cwd: config.runtime, timeoutMs: 30_000, platform: config.platform });
  console.log(version.exitCode === 0 ? `Codex 版本：${version.stdout.trim().slice(0, 80)}` : "Codex 无法运行");
  await ensureLogin(config, codex);
  console.log("Codex 已使用 ChatGPT 登录");
  const beat = await api(config, token, { action: "heartbeat", workerId });
  if (beat.status === 401) throw new Error("worker_token_invalid");
  if (!beat.ok) throw new Error("worker_api_failed");
  console.log("后台连接正常，令牌有效");
}

async function main() {
  let config;
  try { config = parseConfig(process.env, process.argv.slice(2)); }
  catch { console.error("配置无效：请检查命令参数和 ABORDER_* 环境变量。运行 --help 查看说明。"); process.exitCode = 2; return; }
  if (config.mode === "help") { console.log(HELP); return; }
  if (config.mode === "generate-token") {
    console.log(generateToken());
    console.error("把这一行同时写入后台 .env 的 LOCAL_CONTENT_WORKER_TOKEN 和本 worker 的环境（或令牌文件），然后重启后台。");
    return;
  }
  await mkdir(config.runtime, { recursive: true, mode: 0o700 });
  await mkdir(config.codexHome, { recursive: true, mode: 0o700 });
  if (config.mode === "login") {
    const codex = await resolveCodex(config);
    const code = await new Promise(done => {
      const proc = spawn(codex, signInArgs(), { env: childEnv(process.env, config), stdio: "inherit", shell: false, windowsHide: false });
      proc.on("error", () => done(127));
      proc.on("close", done);
    });
    if (code !== 0) throw new Error(code === 127 ? "codex_executable_missing" : "chatgpt_login_required");
    return;
  }
  const token = tokenFrom(process.env, path => readFileSync(path, "utf8"));
  if (config.mode === "check") { await check(config, token); return; }

  const lockFile = join(config.runtime, "worker.lock");
  await acquireLock(lockFile);
  const release = () => rm(lockFile, { force: true }).catch(() => {});
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stop.abort(); if (child) killTree(child, config.platform); });
  try {
    const codex = await resolveCodex(config);
    const beat = await api(config, token, { action: "heartbeat", workerId });
    if (beat.status === 401) throw new Error("worker_token_invalid");
    if (!beat.ok) throw new Error("worker_api_failed");
    await log(config, "worker_started", { workerId, mode: config.mode });
    while (!stop.signal.aborted) {
      const claimed = await api(config, token, { action: "claim", workerId });
      if (!claimed.ok) {
        if (claimed.status === 401) throw new Error("worker_token_invalid");
        await log(config, "claim_failed", { code: "worker_api_failed", status: claimed.status });
      } else {
        const job = validateClaim(claimed.data);
        if (job) {
          await log(config, "job_claimed", { jobId: job.jobId, provider: job.provider });
          await processJob(config, token, codex, job);
          if (config.mode === "once") break;
          continue;
        }
        if (config.mode === "once") break;
      }
      await sleep(POLL_MS, undefined, { signal: stop.signal }).catch(() => {});
      if (!stop.signal.aborted) await api(config, token, { action: "heartbeat", workerId }).catch(() => {});
    }
    await log(config, "worker_stopped");
  } finally {
    await release();
  }
}

main().catch(async error => {
  const code = safeCode(error, START_CODES, "worker_failed");
  console.error(`[${stamp()}] ${code}`);
  process.exitCode = 1;
});
