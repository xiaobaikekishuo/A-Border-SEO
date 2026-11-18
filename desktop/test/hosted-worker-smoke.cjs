// Run with Electron, passing a Node executable as the second argument.
// A loopback fake API and a Node executable that cannot sign in replace all real accounts.
const { app, utilityProcess } = require("electron");
const assert = require("node:assert/strict");
const http = require("node:http");
const { mkdirSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const directory = process.argv[4] ? path.resolve(process.argv[4]) : mkdtempSync(path.join(tmpdir(), "aborder-utility-smoke-"));
mkdirSync(directory, { recursive: true });
app.setPath("userData", path.join(directory, "electron"));
let child, server;
async function smoke() {
  const token = "isolated-smoke-device-token-".padEnd(48, "x");
  const calls = [];
  let waiting = false;
  let finish;
  const checked = new Promise(resolve => { finish = resolve; });
  server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(request.headers.authorization, "Bearer " + token);
    assert.equal(request.headers["x-aborder-installation-id"], "test-device");
    assert.equal(request.headers["x-aborder-desktop-version"], "1.5.0");
    assert.equal(body.metadata.codexLogin, false);
    calls.push(body.action);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    if (calls.length >= 2 && waiting) finish();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  child = utilityProcess.fork(process.argv[3] ? path.resolve(process.argv[3]) : path.resolve(__dirname, "../../source/local-worker/index.mjs"), ["--watch"], {
    stdio: "pipe", env: { ...process.env, ABORDER_HOSTED_WORKER: "1", ABORDER_WORKER_ALLOW_REMOTE: "1",
      ABORDER_URL: `http://127.0.0.1:${server.address().port}`, ABORDER_INSTALLATION_ID: "test-device",
      ABORDER_ACCOUNT_ID: "test-account", ABORDER_PRODUCT_ID: "a-border-seo", ABORDER_DESKTOP_VERSION: "1.5.0",
      ABORDER_CODEX_BIN: process.argv[2], ABORDER_CODEX_HOME: path.join(directory, "codex"),
      ABORDER_WORKER_RUNTIME: path.join(directory, "worker"), LOCAL_CONTENT_WORKER_TOKEN: token },
  });
  child.stdout.resume(); child.stderr.resume();
  child.on("message", value => {
    assert.equal(JSON.stringify(value).includes(token), false);
    if (value.phase === "waiting_login") { waiting = true; if (calls.length >= 2) finish(); }
  });
  let timer;
  await Promise.race([checked, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("utility_smoke_timeout")), 15_000); })]);
  assert.equal(calls.every(action => action === "heartbeat"), true);
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.postMessage({ type: "stop" });
  assert.equal(await exited, 0);
  clearTimeout(timer);
  await new Promise(resolve => server.close(resolve));
  server = null;
  console.log("Hosted utility smoke passed: device headers, login gating, state messages and graceful stop.");
}
app.whenReady().then(smoke).then(() => {
  console.log("Smoke temporary directory: " + directory); app.exit(0);
}).catch(error => {
  console.error(error.message); child?.kill(); server?.close();
  console.log("Smoke temporary directory: " + directory); app.exit(1);
});
