import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCodexStatus } from "./app-server.mjs";

const fake = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));
function read(mode, extra = {}) {
  let child = null;
  const spawned = [];
  const status = readCodexStatus({
    spawnProcess: (_codex, args, options) => { const proc = spawn(process.execPath, [fake, ...args], { ...options, env: { ...process.env, FAKE_MODE: mode } }); spawned.push(proc); return proc; },
    kill: proc => proc.kill("SIGKILL"), codex: "codex", env: process.env, cwd: process.cwd(), platform: "win32",
    onChild: proc => { child = proc; }, ...extra,
  });
  return { status, spawned, child: () => child };
}
const exited = proc => new Promise(resolve => { if (proc.exitCode !== null || proc.signalCode !== null) resolve(true); else proc.once("exit", () => resolve(true)); });

describe("reading the Codex allowance through app-server", () => {
  it("returns both windows and the offered models, then stops app-server", async () => {
    const run = read("ok");
    const result = await run.status;
    expect(result.limits).toEqual({ planType: "plus", primary: { usedPercent: 12, windowMinutes: 300, resetsAt: 1900000000 },
      secondary: { usedPercent: 30, windowMinutes: 10080, resetsAt: 1900500000 }, reached: false, hasCredits: null });
    expect(result.models.map(model => model.id)).toEqual(["gpt-6-luna"]);
    expect(await exited(run.spawned[0])).toBe(true);
    expect(run.child()).toBeNull();
  });
  it("names a missing sign-in, an old Codex and a reading that hangs", async () => {
    expect((await read("login").status).error).toBe("login_required");
    expect((await read("noinit").status).error).toBe("unsupported");
    const hang = read("hang", { timeoutMs: 300 });
    expect((await hang.status).error).toBe("read_timeout");
    expect(await exited(hang.spawned[0])).toBe(true);
  });
  it("keeps a reading when app-server exits before listing models", async () => {
    const result = await read("exit").status;
    expect(result.limits?.primary?.usedPercent).toBe(12);
    expect(result.models).toBeNull();
  });
  it("does not start when the worker is stopping, and reports a missing Codex", async () => {
    const stopped = new AbortController(); stopped.abort();
    expect(await read("ok", { signal: stopped.signal }).status).toEqual({ error: "read_failed" });
    const missing = await readCodexStatus({ spawnProcess: () => { throw new Error("spawn ENOENT"); }, kill: () => {}, codex: "codex", env: {}, cwd: process.cwd(), platform: "linux" });
    expect(missing).toEqual({ error: "codex_unavailable" });
  });
});
