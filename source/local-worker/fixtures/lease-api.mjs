// Loaded only by lease.test.mjs in its isolated --once worker process.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";

const record = entry => appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify(entry) + "\n");
const spawn = childProcess.spawn;
let generationStarted = false;
childProcess.spawn = (command, args, options) => {
  if (command !== "fixture-codex") return spawn(command, args, options);
  const generation = args.includes("exec");
  const script = generation ? "setTimeout(() => {}, 30000)" : "console.log('Logged in using ChatGPT')";
  const child = spawn(process.execPath, ["-e", script], options);
  if (generation) { record({ childPid: child.pid }); generationStarted = true; }
  return child;
};
syncBuiltinESMExports();
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => schedule(fn, fn.name === "renew" ? 50 : ms, ...args);

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (new URL(url).pathname.endsWith("/chatgpt")) {
    generationStarted = true;
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => {
      record({ streamCanceled: true });
      reject(init.signal.reason);
    }, { once: true }));
  }
  record({ action: body.action, error: body.error });
  if (body.action === "claim") return Response.json({ job: {
    jobId: "aw_fixture", leaseToken: "fixture-running-lease", provider: process.env.FIXTURE_PROVIDER,
    outputSchema: { type: "object" }, prompt: "fixture",
  } });
  if (body.action === "heartbeat" && body.jobId) {
    if (!generationStarted) return Response.json({ ok: true, leaseExpiresAt: new Date(Date.now() + 120000).toISOString() });
    const status = Number(process.env.FIXTURE_STATUS);
    if (!status) throw new Error("fixture network outage");
    return Response.json({}, { status });
  }
  return Response.json({ ok: true });
};
