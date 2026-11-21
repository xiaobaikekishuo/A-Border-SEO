// Loaded only by limits.test.mjs in its isolated --watch worker process:
// a fake app (fetch) and a fake Codex whose app-server is fake-app-server.mjs.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const record = entry => appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify(entry) + "\n");
const appServer = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command !== "fixture-codex") return spawn(command, args, options);
  if (args.at(-1) === "app-server") return spawn(process.execPath, [appServer, ...args], { ...options, env: { ...options.env, FAKE_MODE: "ok" } });
  if (args.includes("exec")) {
    const model = args[args.indexOf("--model") + 1] ?? null;
    const effort = args.find(arg => arg.startsWith("model_reasoning_effort="));
    record({ exec: true, model, effort });
    const answer = args[args.indexOf("--output-last-message") + 1];
    writeFileSync(answer, JSON.stringify({ title: "t" }));
    const events = [{ type: "thread.started" }, { type: "turn.started" }, { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }];
    return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(events.map(event => JSON.stringify(event)).join("\n") + "\n")})`], options);
  }
  return spawn(process.execPath, ["-e", "console.log('Logged in using ChatGPT')"], options);
};
syncBuiltinESMExports();

let claims = 0;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  record({ action: body.action, ...(body.action === "limits" ? { limits: body.limits, models: body.models, capabilities: body.capabilities, error: body.error } : {}) });
  if (body.action === "claim") {
    claims++;
    return Response.json({ job: claims === 1 ? { jobId: "aw_fixture", leaseToken: "fixture-running-lease", provider: "CODEX_LOCAL",
      outputSchema: { type: "object" }, prompt: "fixture", model: "gpt-6-luna", reasoning: "medium" } : null });
  }
  if (body.action === "heartbeat" && body.jobId) return Response.json({ ok: true, leaseExpiresAt: new Date(Date.now() + 120000).toISOString() });
  return Response.json({ ok: true });
};
