// Reading this Codex account's allowance through Codex's own app-server
// (stdio JSON lines): initialize, then account/rateLimits/read and
// model/list. No thread is started and no message is sent, so a reading
// costs nothing. Process handling is passed in so tests can use a fake Codex.
import { APP_SERVER_TIMEOUT_MS, LIMITS, appServerArgs, appServerInitialize, appServerRequests, parseModels, parseRateLimits } from "./lib.mjs";

/**
 * Resolves { limits, models } or { error, models? }; never rejects.
 * error: codex_unavailable (Codex would not start), unsupported (no
 * app-server), login_required (no ChatGPT sign-in), read_timeout or read_failed.
 */
export function readCodexStatus({ spawnProcess, kill, codex, env, cwd, platform, signal, timeoutMs = APP_SERVER_TIMEOUT_MS, onChild = () => {} }) {
  return new Promise(resolvePromise => {
    let proc = null, settled = false, buffer = "", bytes = 0, errBytes = 0;
    const results = {};
    const onStop = () => finish({ error: "read_failed" });
    const timer = setTimeout(() => finish({ error: "read_timeout" }), timeoutMs);
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onStop);
      onChild(null);
      if (proc && proc.exitCode === null && proc.signalCode === null) kill(proc);
      resolvePromise(value);
    }
    if (signal?.aborted) { finish({ error: "read_failed" }); return; }
    signal?.addEventListener("abort", onStop, { once: true });
    try {
      proc = spawnProcess(codex, appServerArgs(), { cwd, env, shell: false, windowsHide: true, detached: platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    } catch { finish({ error: "codex_unavailable" }); return; }
    onChild(proc);
    const send = message => { try { proc.stdin.write(JSON.stringify(message) + "\n"); } catch { /* the process may have exited */ } };
    proc.stdin.on("error", () => {});
    proc.stderr.on("data", chunk => { errBytes += chunk.length; if (errBytes > LIMITS.stderrBytes) finish({ error: "read_failed" }); });
    proc.on("error", error => finish({ error: error?.code === "ENOENT" ? "codex_unavailable" : "read_failed" }));
    proc.on("close", () => finish(results.limits ? { limits: results.limits, models: results.models ?? null }
      : { error: results.error ?? (bytes ? "read_failed" : "unsupported"), ...(results.models ? { models: results.models } : {}) }));
    proc.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > LIMITS.appServerBytes) { finish({ error: "read_failed" }); return; }
      buffer += chunk.toString("utf8");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (!message || typeof message !== "object" || Array.isArray(message)) continue;
        if (message.id === 0) {
          if (message.error) { finish({ error: "unsupported" }); return; }
          for (const request of appServerRequests()) send(request);
        } else if (message.id === 1) {
          // An error here is usually a missing ChatGPT sign-in.
          results.limits = message.error ? null : parseRateLimits(message.result);
          if (message.error) results.error = "login_required";
          else if (!results.limits) results.error = "read_failed";
        } else if (message.id === 2) {
          results.models = message.error ? null : parseModels(message.result);
        }
        if ("limits" in results && "models" in results) {
          finish(results.limits ? { limits: results.limits, models: results.models } : { error: results.error, ...(results.models ? { models: results.models } : {}) });
          return;
        }
      }
    });
    send(appServerInitialize());
  });
}
