// A stand-in for "codex app-server" in tests: answers initialize,
// account/rateLimits/read and model/list the way FAKE_MODE says.
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MODE ?? "ok";
const args = process.argv.slice(2);
if (args.at(-1) !== "app-server") process.exit(64);
const reply = message => process.stdout.write(JSON.stringify(message) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (mode === "hang") return;
  if (message.method === "initialize") {
    if (mode === "noinit") reply({ id: 0, error: { code: -32601, message: "unknown method" } });
    else { reply({ method: "account/updated", params: {} }); reply({ id: 0, result: { userAgent: "fake" } }); }
  } else if (message.method === "account/rateLimits/read") {
    if (mode === "login") reply({ id: 1, error: { code: -32000, message: "not signed in" } });
    else reply({ id: 1, result: { rateLimits: { limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1900000000 },
      secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1900500000 }, rateLimitReachedType: null, planType: "plus" } } });
  } else if (message.method === "model/list") {
    if (mode === "exit") process.exit(0);
    reply({ id: 2, result: { data: [{ id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6 Luna", hidden: false, isDefault: false,
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] }], nextCursor: null } });
  }
});
