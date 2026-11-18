import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const worker = fileURLToPath(new URL("./index.mjs", import.meta.url));
const preload = new URL("./fixtures/lease-api.mjs", import.meta.url).href;

it.each([
  ["CODEX_LOCAL", 409, "worker_lease_lost"],
  ["CODEX_LOCAL", 403, "worker_lease_lost"],
  ["CODEX_LOCAL", 503, "worker_api_failed"],
  ["CODEX_LOCAL", 200, "worker_api_failed"],
  ["CHATGPT_APP", 0, "worker_api_failed"],
])("stops a running %s job when its heartbeat returns %d", async (provider, status, code) => {
  const runtime = await mkdtemp(join(tmpdir(), "aborder-test-worker-"));
  const events = join(runtime, "events.jsonl");
  try {
    await run(process.execPath, ["--import", preload, worker, "--once"], { timeout: 10000, windowsHide: true,
      env: { ...process.env, ABORDER_CODEX_BIN: "fixture-codex", ABORDER_WORKER_RUNTIME: runtime,
        ABORDER_CODEX_HOME: join(runtime, "codex"), ABORDER_URL: "http://127.0.0.1:3300",
        ABORDER_HOSTED_WORKER: provider === "CODEX_LOCAL" ? "1" : "0", ABORDER_PRODUCT_ID: "a-border-seo",
        ABORDER_INSTALLATION_ID: "fixture-device", ABORDER_ACCOUNT_ID: "fixture-account", ABORDER_DESKTOP_VERSION: "1.0.0",
        LOCAL_CONTENT_WORKER_TOKEN: "w".repeat(40), FIXTURE_EVENTS: events, FIXTURE_PROVIDER: provider, FIXTURE_STATUS: String(status) },
    });
    const actions = (await readFile(events, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(actions.filter(entry => entry.action === "fail")).toEqual([{ action: "fail", error: code }]);
    expect(actions.some(entry => entry.action === "complete")).toBe(false);
    if (provider === "CHATGPT_APP") expect(actions.some(entry => entry.streamCanceled)).toBe(true);
    else {
      const pid = actions.find(entry => entry.childPid)?.childPid;
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally { await rm(runtime, { recursive: true, force: true }); }
});
