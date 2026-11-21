import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";

const worker = fileURLToPath(new URL("./index.mjs", import.meta.url));
const preload = new URL("./fixtures/limits-api.mjs", import.meta.url).href;
const events = async file => (await readFile(file, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

it.skipIf(process.platform === "win32")("reports the allowance before asking for work, runs a task with its hint and reads again after it", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "aborder-test-limits-"));
  const file = join(runtime, "events.jsonl");
  const proc = spawn(process.execPath, ["--import", preload, worker, "--watch"], { windowsHide: true, stdio: "ignore",
    env: { ...process.env, ABORDER_CODEX_BIN: "fixture-codex", ABORDER_WORKER_RUNTIME: runtime, ABORDER_CODEX_HOME: join(runtime, "codex"),
      ABORDER_URL: "http://127.0.0.1:3300", LOCAL_CONTENT_WORKER_TOKEN: "w".repeat(40), FIXTURE_EVENTS: file } });
  try {
    let seen = [];
    for (let i = 0; i < 100 && seen.filter(entry => entry.action === "limits").length < 2; i++) { await sleep(100); seen = await events(file); }
    const actions = seen.map(entry => entry.action ?? (entry.exec ? "exec" : "?"));
    // Reading, then the first claim; the task; a new reading before the next claim.
    expect(actions.slice(0, 3)).toEqual(["heartbeat", "limits", "claim"]);
    expect(actions).toContain("complete");
    expect(actions.indexOf("limits", 2)).toBeGreaterThan(actions.indexOf("complete"));
    const reading = seen.find(entry => entry.action === "limits");
    expect(reading.limits.primary).toEqual({ usedPercent: 12, windowMinutes: 300, resetsAt: 1900000000 });
    expect(reading.models.map(model => model.id)).toEqual(["gpt-6-luna"]);
    expect(reading.capabilities).toEqual(["routing-v1"]);
    expect(seen.find(entry => entry.exec)).toMatchObject({ model: "gpt-6-luna", effort: 'model_reasoning_effort="medium"' });
  } finally {
    proc.kill("SIGTERM");
    await new Promise(resolve => { if (proc.exitCode !== null) resolve(); else proc.once("exit", resolve); });
    await rm(runtime, { recursive: true, force: true });
  }
}, 20000);
