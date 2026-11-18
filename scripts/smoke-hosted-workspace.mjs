import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedClient } from "../desktop/managed-client.mjs";
import * as protocol from "../source/lib/managed/protocol.mjs";

// No deployment credentials are read. All accounts, keys, databases and networks belong to this run.
if (process.argv[2] !== "--run") {
  console.log("Usage: set ABORDER_SMOKE_BUNDLE=<delivery.tar.gz> or ABORDER_SMOKE_IMAGE=<built image>, then node scripts/smoke-hosted-workspace.mjs --run [report-directory]");
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(path.join(root, "source/package.json"), "utf8")).version;
const runId = Date.now().toString(36) + randomBytes(3).toString("hex");
const bundle = process.env.ABORDER_SMOKE_BUNDLE ? path.resolve(process.env.ABORDER_SMOKE_BUNDLE) : null;
const image = bundle ? `aborder-hosted-fixture:${runId}` : process.env.ABORDER_SMOKE_IMAGE ?? `aborder-seo-internal:${version}`;
const controlImage = process.env.ABORDER_SMOKE_CONTROL_IMAGE;
const controlRoot = controlImage ? "/app/control-plane" : "/fixture/control-plane";
const project = "aborder-hosted-smoke-" + runId;
const reportDirectory = path.resolve(process.argv[3] ?? path.join(root, "reports/hosted-smoke"), project);
mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
const reportFile = path.join(reportDirectory, "report.json");
const directory = mkdtempSync(path.join(tmpdir(), project + "-"));
const composeFile = path.join(directory, "compose.json");
const productId = "a-border-seo";
const features = { jobs: true, codex: true, manus: true, geo: true };
const report = { project, image, version, startedAt: new Date().toISOString(), checks: [], pass: false, cleanup: [] };
const check = name => { report.checks.push(name); console.log("PASS " + name); };
const docker = process.env.ABORDER_SMOKE_DOCKER ?? [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs/DockerDesktop/resources/bin/docker.exe"),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Docker/Docker/resources/bin/docker.exe"),
].find(file => file && existsSync(file)) ?? "docker";
const context = process.env.ABORDER_SMOKE_DOCKER_CONTEXT ?? "desktop-linux";
function execute(args, input, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(docker, ["--context", context, ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.resume();
    const timer = setTimeout(() => { child.kill(); reject(new Error("isolated_docker_timeout")); }, timeout);
    child.once("error", () => { clearTimeout(timer); reject(new Error("isolated_docker_unavailable")); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error("isolated_docker_failed_" + code)); });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
const compose = (args, input, timeout) => execute(["compose", "-p", project, "-f", composeFile, ...args], input, timeout);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch {}
    await pause(1000);
  }
  throw new Error("timeout_" + label);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const appPort = await freePort(), cpPort = await freePort();
const origin = `http://127.0.0.1:${appPort}`, cpOrigin = `http://127.0.0.1:${cpPort}`;
// Docker Desktop does not publish ports on internal networks. Send fixture HTTP through
// the control container's loopback, retaining the original Host/Origin headers.
async function dockerFetch(url, options = {}) {
  const target = new URL(url);
  if (![origin, cpOrigin].includes(target.origin)) throw new Error("non_fixture_http_blocked");
  const headers = { ...Object.fromEntries(new Headers(options.headers)), host: target.host };
  target.port = target.origin === cpOrigin ? "8080" : "3000";
  const input = { url: target.href, method: options.method ?? "GET", headers, body: options.body };
  const output = await compose(["exec", "-T", "control", "node", "--input-type=module", "-e", `
import {request} from 'node:http';
let text='';process.stdin.setEncoding('utf8');for await(const part of process.stdin)text+=part;
const input=JSON.parse(text);const start=performance.now();
if (input.body !== undefined) input.headers['content-length']=String(Buffer.byteLength(input.body));
// fetch replaces Host with the internal port. Use the original browser host so the
// production Origin check sees the same request as it does behind the reverse proxy.
const r=await new Promise((resolve,reject)=>{
  const req=request(input.url,{method:input.method,headers:input.headers,signal:AbortSignal.timeout(12000)},resolve);
  req.on('error',reject);req.end(input.body);
});
let body='';r.setEncoding('utf8');for await(const part of r)body+=part;
const headers=Object.entries(r.headers).flatMap(([key,value])=>(Array.isArray(value)?value:[value]).map(v=>[key,v]));
console.log(JSON.stringify({status:r.statusCode,headers,body,elapsedMs:Math.round(performance.now()-start)}));`], JSON.stringify(input), 20000);
  const result = JSON.parse(output.trim());
  if (options.measurePage) {
    (report.isolatedPageReads ??= []).push({ page: options.measurePage, status: result.status, elapsedMs: result.elapsedMs });
  }
  return new Response(result.status === 204 ? null : result.body, { status: result.status, headers: result.headers });
}
const keys = generateKeyPairSync("ed25519");
const internalSecret = randomBytes(32).toString("base64url");
const adminCredentials = { username: "fixture_admin", password: randomBytes(32).toString("base64url") };
writeFileSync(path.join(directory, "control-fixture.json"), JSON.stringify({ origin: cpOrigin, admin: adminCredentials, internalSecret,
  privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }) }), { mode: 0o600 });
writeFileSync(path.join(directory, "control-fixture.mjs"), `
import {readFileSync} from 'node:fs';
import {createPrivateKey} from 'node:crypto';
import {openDatabase} from '${controlRoot}/db.mjs';
import {configureAdmin} from '${controlRoot}/admin-auth.mjs';
import {createControlPlane,createInternalControlPlane} from '${controlRoot}/server.mjs';
const raw=JSON.parse(readFileSync('/fixture/run/control-fixture.json','utf8'));
const db=openDatabase(':memory:'); configureAdmin(db,raw.admin.username,raw.admin.password);
const config={origin:raw.origin,issuer:raw.origin,secure:false,leaseSeconds:900,kid:'fixture',privateKey:createPrivateKey(raw.privateKey),internal:{secret:raw.internalSecret,bind:'127.0.0.1',port:18086}};
const servers=[createControlPlane({db,config}),createInternalControlPlane({db,config})];
servers[0].listen(8080,'0.0.0.0'); servers[1].listen(18086,'127.0.0.1');
let toggling=false;
process.on('SIGUSR2',()=>{if(toggling)return;toggling=true;if(servers[1].listening)servers[1].close(()=>{toggling=false;});else servers[1].listen(18086,'127.0.0.1',()=>{toggling=false;});});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve)))).then(()=>{db.close();process.exit(0);}));
`, { mode: 0o600 });
const config = protocol.validateConfig({ serverUrl: cpOrigin, issuer: cpOrigin, productId,
  keys: { fixture: keys.publicKey.export({ type: "spki", format: "pem" }) } }, { allowHttpLoopback: true });
const fixtureKey = randomBytes(32);
const seal = async value => {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", fixtureKey, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
};
const open = async value => {
  const raw = Buffer.from(value, "base64"), cipher = createDecipheriv("aes-256-gcm", fixtureKey, raw.subarray(0, 12));
  cipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString();
};
const createClient = name => new ManagedClient({ protocol, config, file: path.join(directory, name + ".json"), dataRoot: path.join(directory, name),
  desktopVersion: version, versions: () => ({ backendVersion: version }), requireUser: true, seal, open, fetcher: dockerFetch, onChange() {} });
const users = ["a", "b"].map(name => ({ name, credentials: { username: "fixture_" + name + "_" + runId, password: randomBytes(24).toString("base64url") }, client: createClient(name) }));
let started = false, imageBuilt = false, adminCookie, csrf;
const request = (base, route, body, headers = {}) => dockerFetch(base + route, { method: body === undefined ? "GET" : "POST",
  redirect: "manual", signal: AbortSignal.timeout(12000), headers: { Origin: base, "Content-Type": "application/json", "X-Requested-With": "XmlHttpRequest", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const local = (route, body, user) => request(origin, route, body, user?.cookie ? { Cookie: user.cookie } : {});
const state = () => request(cpOrigin, "/admin/api/state", undefined, { Cookie: adminCookie }).then(response => response.json());
async function admin(action, body) {
  const response = await request(cpOrigin, "/admin/api/" + action, { productId, reason: "Isolated hosted workspace fixture", ...body }, { Cookie: adminCookie, "X-CSRF-Token": csrf });
  assert.equal(response.status, 200, "admin mutation failed: " + action); return response.json();
}
const account = (user, enabled) => admin("accounts", { ...user.account, enabled, expiresAt: null, deviceLimit: user.deviceLimit ?? 1, features });
const policy = body => admin("policy", { scope: "product", scopeId: "", disabled: false, maintenance: false, startAt: null, endAt: null, message: "", features, ...body });
const worker = (user, body, token = user.token) => request(origin, "/api/local-content-worker", body, {
  Authorization: "Bearer " + token, "X-Aborder-Installation-Id": user.client.snapshot().installationId,
  "X-Aborder-Product-Id": productId, "X-Aborder-Desktop-Version": version,
});
const heartbeat = user => worker(user, { action: "heartbeat", workerId: "fixture-" + user.name, metadata: { codexLogin: true, desktopVersion: version } });
const claim = user => worker(user, { action: "claim", workerId: "fixture-" + user.name, protocolVersion: 2 });
const dbScript = async source => JSON.parse((await compose(["exec", "-T", "app", "node", "--input-type=module", "-"],
  `import {PrismaClient} from '@prisma/client'; const db=new PrismaClient(); try { ${source} } finally { await db.$disconnect(); }`)).trim());
async function handoff(user) {
  user.token = await user.client.getCredential();
  const response = await request(origin, "/api/hosted/session", { productId, installationId: user.client.snapshot().installationId,
    accountId: user.client.snapshot().accountId, desktopVersion: version }, { Authorization: "Bearer " + user.token });
  assert.equal(response.status, 200, "hosted session exchange");
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie?.startsWith("__Secure-authjs.session-token="));
  assert.ok(/httponly/i.test(cookie) && /secure/i.test(cookie) && /samesite=lax/i.test(cookie));
  user.cookie = cookie.split(";")[0];
}
const contentJob = user => dbScript(`const p=await db.contentPillar.create({data:{siteId:${JSON.stringify(user.siteId)},title:'Fixture',keyword:'fixture'}});
  const c=await db.contentPlanJob.create({data:{siteId:p.siteId,pillarId:p.id,hostedDeviceId:${JSON.stringify(user.deviceId)}}}); console.log(JSON.stringify({id:c.id}));`);
const ordinaryJob = (user, device = false) => dbScript(`const j=await db.job.create({data:{siteId:${JSON.stringify(user.siteId)},type:'alerts-evaluate',source:${JSON.stringify(device ? "manual" : "schedule")},hostedDeviceId:${JSON.stringify(device ? user.deviceId : null)},maxAttempts:1}});console.log(JSON.stringify({id:j.id}));`);
const jobStatus = job => dbScript(`console.log(JSON.stringify(await db.job.findUniqueOrThrow({where:{id:${JSON.stringify(job.id)}},select:{status:true,attempts:true}})));`);
const queued = async jobs => { await pause(4000); for (const job of jobs) { const current = await jobStatus(job); assert.equal(current.status, "QUEUED"); assert.equal(current.attempts, 0); } };
const completed = jobs => Promise.all(jobs.map(job => until(async () => (await jobStatus(job)).status === "SUCCEEDED", "ordinary_job_recovery", 30000)));
async function finishContent(user, job) {
  const begun = await worker(user, { action: "begin", jobId: job.jobId, leaseToken: job.leaseToken });
  assert.equal(begun.status, 200); assert.equal((await begun.json()).allowed, true);
  const response = await worker(user, { action: "fail", jobId: job.jobId, leaseToken: job.leaseToken, error: "worker_stopped" });
  assert.equal(response.status, 200);
}

async function checkWorkbenchActions(owner, other, secondDevice) {
  const base = "/api/sites/" + owner.siteId + "/assistant";
  const evidencePath = base + "/action-evidence?scope=weekly";
  const preview = async () => {
    const response = await local(evidencePath, undefined, owner);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    return response.json();
  };
  const generate = { action: "start", provider: "CODEX_LOCAL", kind: "SEO_FIX_PLAN", title: "Fixture weekly actions", actionScope: "weekly" };
  const before = await preview();
  assert.equal(before.hasData, false);
  const empty = await local(base, { ...generate, evidenceRevision: before.revision }, owner);
  assert.equal((await empty.json()).error, "report_evidence_empty");
  assert.equal(empty.status, 409);
  assert.equal((await local(evidencePath, undefined, other)).status, 404);
  const pillar = await dbScript(`const siteId=${JSON.stringify(owner.siteId)};
    await db.crawl.create({data:{siteId,status:'COMPLETED',finishedAt:new Date(),pagesFound:10}});
    console.log(JSON.stringify(await db.contentPillar.create({data:{siteId,title:'Fixture topic',keyword:'Fixture'},select:{id:true}})));`);
  const saved = await preview();
  assert.equal(saved.hasData, true);
  assert.equal(saved.sections.find(s => s.source === "audit").rows[0].sampledPages, 10);
  const stale = await local(base, { ...generate, evidenceRevision: before.revision }, owner);
  assert.equal((await stale.json()).error, "report_evidence_changed");
  assert.equal(stale.status, 409);
  assert.equal((await local(base, undefined, owner).then(r => r.json())).jobs.length, 0);
  check("Report preview is read-only, site-specific and blocks empty or superseded evidence");

  const startJob = async input => {
    const response = await local(base, input, owner);
    assert.equal(response.status, 200, "start workbench job");
    const { jobId } = await response.json();
    const onWrongDevice = await claim(secondDevice).then(r => r.json());
    assert.equal(onWrongDevice.job, null);
    const { job } = await claim(owner).then(r => r.json());
    assert.equal(job?.jobId, jobId);
    const lease = { jobId, leaseToken: job.leaseToken };
    const begin = await worker(owner, { action: "begin", ...lease });
    assert.equal((await begin.json()).allowed, true);
    return { lease, job };
  };
  const baseResult = { title: "Fixture analysis", summary: "Verified the report sample", contentMarkdown: "Review the saved report sample.", metaTitle: "", metaDescription: "", changeNotes: [], factChecks: ["Check the next sample."], internalLinks: [], paragraphEdits: [] };
  const reportJob = await startJob({ ...generate, evidenceRevision: saved.revision });
  assert.ok(reportJob.job.outputSchema.properties.reportActions);
  const action = { title: "Review the crawl", reason: "10 pages sampled.", nextStep: "Review the crawl coverage.", verify: "Run another crawl.", evidenceRefs: ["audit:1"] };
  const reply = await worker(owner, { action: "complete", ...reportJob.lease, result: { ...baseResult, reportActions: [action] } });
  assert.equal(reply.status, 200);
  const history = await local(base, undefined, owner).then(r => r.json());
  const finished = history.jobs.find(j => j.id === reportJob.lease.jobId);
  assert.deepEqual(finished.result.reportActions, [action]);
  assert.deepEqual(finished.reportSources.map(s => s.ref), ["audit:1"]);
  check("Weekly actions complete through a device-bound lease with a verifiable report reference");

  const research = await startJob({ action: "start", provider: "CODEX_LOCAL", kind: "KEYWORD_RESEARCH", title: "Fixture research", keyword: "Fixture", keywordResearch: { count: 12, targetMarket: "US" } });
  const ideas = ["Reviewed fixture idea", "Omitted fixture idea"].map(keyword => ({ keyword, intent: "INFORMATIONAL", funnel: "TOFU", cluster: "Fixture", angle: "Explain the choice", rationale: "Based on the fixture seed" }));
  assert.equal((await worker(owner, { action: "complete", ...research.lease, result: { ...baseResult, keywordIdeas: ideas } })).status, 200);
  const page = await local("/sites/" + owner.siteId + "/content?researchJob=" + research.lease.jobId + "&ideas=0", undefined, owner);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes(ideas[0].keyword));
  const contentEndpoint = "/api/sites/" + owner.siteId + "/content";
  const plan = await local(contentEndpoint, { action: "startPlan", pillarId: pillar.id, topicCount: 3, keywordSelection: { jobId: research.lease.jobId, indexes: [0] } }, owner);
  assert.equal(plan.status, 200);
  const { job: draft } = await claim(owner).then(r => r.json());
  assert.ok(draft.prompt.includes(ideas[0].keyword));
  assert.ok(!draft.prompt.includes(ideas[1].keyword));
  await finishContent(owner, draft);
  check("Completed native keyword research carries only user-selected ideas into a plan for an existing topic");
}

try {
  if (bundle) {
    assert.ok(existsSync(bundle), "delivery bundle does not exist");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(bundle)) digest.update(chunk);
    report.bundle = { filename: path.basename(bundle), sha256: digest.digest("hex") };
    const buildDirectory = path.join(directory, "runtime-build");
    mkdirSync(buildDirectory, { recursive: true });
    copyFileSync(bundle, path.join(buildDirectory, "server-bundle.tar.gz"));
    writeFileSync(path.join(buildDirectory, "Dockerfile"), `FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY server-bundle.tar.gz /tmp/server-bundle.tar.gz
RUN echo '${report.bundle.sha256}  /tmp/server-bundle.tar.gz' | sha256sum -c - && mkdir -p /opt/aborder && tar -xzf /tmp/server-bundle.tar.gz -C /opt/aborder && rm /tmp/server-bundle.tar.gz && chown -R node:node /opt/aborder
WORKDIR /opt/aborder/app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
USER node
CMD ["node", "server.js"]
`);
    writeFileSync(path.join(buildDirectory, ".dockerignore"), "*\n!Dockerfile\n!server-bundle.tar.gz\n");
    await execute(["build", "--tag", image, buildDirectory], undefined, 600000);
    imageBuilt = true;
    check("Runtime image contains the exact SHA256-verified delivery tar without recompiling source");
  }
  await execute(["image", "inspect", image, "--format", "{{.Id}}"]);
  // Require a locally available PostgreSQL image so this verification has no image pull side effects.
  const postgres = process.env.ABORDER_SMOKE_POSTGRES_IMAGE ?? "postgres:16-alpine";
  await execute(["image", "inspect", postgres, "--format", "{{.Id}}"]);
  if (controlImage) {
    report.images = {};
    for (const [role, target] of Object.entries({ app: image, control: controlImage, database: postgres })) {
      report.images[role] = (await execute(["image", "inspect", target, "--format", "{{.Id}}"])).trim();
    }
  }
  const dbPassword = randomBytes(24).toString("hex"), sharedToken = randomBytes(32).toString("base64url");
  const env = { NODE_ENV: "production", HOSTNAME: "0.0.0.0", PORT: "3000", DATABASE_URL: `postgresql://fixture:${dbPassword}@db:5432/fixture?connection_limit=4&pool_timeout=20`,
    NEXTAUTH_URL: origin, AUTH_URL: origin, NEXTAUTH_SECRET: randomBytes(32).toString("base64url"), AUTH_TRUST_HOST: "true",
    ABORDER_HOSTED: "1", ABORDER_WORKSPACE_ORIGIN: origin, ABORDER_CONTROL_INTERNAL_URL: "http://127.0.0.1:18086",
    ABORDER_CONTROL_INTERNAL_SECRET: internalSecret, LOCAL_CONTENT_WORKER_TOKEN: sharedToken,
    WORKER_POLL_SECONDS: "1", WORKER_SHUTDOWN_GRACE_SECONDS: "5", SCHEDULER_ENABLED: "false", ALERT_WEBHOOKS_ENABLED: "false" };
  const bind = (source, target) => ({ type: "bind", source, target, read_only: true });
  const controlMounts = controlImage ? [] : [bind(path.join(root, "control-plane"), "/fixture/control-plane"),
    bind(path.join(root, "source/lib/managed/protocol.mjs"), "/fixture/source/lib/managed/protocol.mjs")];
  writeFileSync(composeFile, JSON.stringify({ services: {
    db: { image: postgres, pull_policy: "never", command: ["postgres", "-c", "max_connections=30"], environment: { POSTGRES_DB: "fixture", POSTGRES_USER: "fixture", POSTGRES_PASSWORD: dbPassword }, volumes: ["database:/var/lib/postgresql/data"],
      healthcheck: { test: ["CMD-SHELL", "pg_isready -U fixture -d fixture"], interval: "2s", timeout: "3s", retries: 30 } },
    control: { image: controlImage ?? image, pull_policy: "never", command: ["node", "/fixture/run/control-fixture.mjs"],
      volumes: [...controlMounts, bind(directory, "/fixture/run")],
      healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: "2s", timeout: "3s", retries: 30 } },
    app: { image, pull_policy: "never", network_mode: "service:control", environment: { ...env, WORKER_MODE: "off" },
      command: ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node server.js"],
      depends_on: { db: { condition: "service_healthy" }, control: { condition: "service_healthy" } },
      healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: "2s", timeout: "3s", retries: 50 } },
    worker: { image, pull_policy: "never", network_mode: "service:control", environment: { ...env, WORKER_MODE: "worker" }, command: ["node", "worker.cjs"],
      depends_on: { app: { condition: "service_healthy" } }, stop_grace_period: "10s" },
  }, volumes: { database: {} }, networks: { default: { internal: true } } }, null, 2), { mode: 0o600 });
  started = true;
  await compose(["up", "-d"], undefined, 240000);
  const health = await until(async () => { const response = await local("/api/health"); const body = await response.json(); return body.status === "ok" && body; }, "workspace_health");
  assert.equal(health.hostedMode, true); assert.equal(health.version, version);
  await until(async () => (await dbScript("console.log(JSON.stringify({count:await db.workerHeartbeat.count()}));")).count > 0, "ordinary_worker_heartbeat");
  check("Fresh production bundle, PostgreSQL migrations and ordinary worker run in an isolated network");
  const login = await request(cpOrigin, "/admin/login", adminCredentials);
  assert.equal(login.status, 200); csrf = (await login.json()).csrf; adminCookie = login.headers.get("set-cookie").split(";")[0];
  for (const user of users) {
    await user.client.register(user.credentials);
    await assert.rejects(user.client.login(user.credentials), /account_pending/);
    user.account = (await state()).accounts.find(item => item.username === user.credentials.username);
    assert.ok(user.account); await account(user, true); await user.client.login(user.credentials); await handoff(user);
    assert.equal((await local("/api/sites", undefined, user)).status, 200);
    const seeded = await dbScript(`const d=await db.hostedDevice.findFirstOrThrow({where:{installationId:${JSON.stringify(user.client.snapshot().installationId)}}});
      const s=await db.site.create({data:{userId:d.userId,domain:${JSON.stringify(user.name + ".example.test")}}});console.log(JSON.stringify({siteId:s.id,deviceId:d.id}));`);
    Object.assign(user, seeded);
  }
  const [a, b] = users;
  check("Two accounts require administrator approval and receive separate secure device sessions");
  const a2 = { name: "a2", credentials: a.credentials, client: createClient("a2"), siteId: a.siteId };
  await assert.rejects(a2.client.login(a2.credentials), /device_limit_reached/);
  a.deviceLimit = 2; await account(a, true); await a2.client.login(a2.credentials); await handoff(a2);
  a2.deviceId = (await dbScript(`console.log(JSON.stringify(await db.hostedDevice.findFirstOrThrow({where:{installationId:${JSON.stringify(a2.client.snapshot().installationId)}},select:{id:true}})));`)).id;
  assert.equal((await heartbeat(a2)).status, 200);
  check("Device limit rejects another installation until an administrator explicitly increases the allowance");
  for (const [owner, other] of [[a, b], [b, a]]) {
    const sites = await local("/api/sites", undefined, owner).then(response => response.json());
    assert.ok(sites.some(site => site.id === owner.siteId)); assert.ok(!sites.some(site => site.id === other.siteId));
    assert.ok([403, 404].includes((await local(`/api/sites/${other.siteId}/assistant`, undefined, owner)).status));
  }
  assert.equal((await local("/api/sites")).status, 401);
  check("Sites and business APIs enforce account isolation and reject missing sessions");
  for (const suffix of ["", "/geo", "", "/geo"]) {
    const page = await dockerFetch(origin + "/sites/" + a.siteId + suffix, {
      headers: { Cookie: a.cookie }, measurePage: suffix ? "GEO" : "overview",
    });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("actionScope=" + (suffix ? "geo" : "weekly")));
  }
  const content = await contentJob(a);
  assert.equal((await claim(a).then(response => response.json())).job, null);
  for (const user of users) assert.equal((await heartbeat(user)).status, 200);
  const shared = await worker(a, { action: "claim", workerId: "shared-test", protocolVersion: 2 }, sharedToken);
  assert.ok([401, 403, 503].includes(shared.status));
  assert.equal((await claim(b).then(response => response.json())).job, null);
  assert.equal((await claim(a2).then(response => response.json())).job, null);
  const firstClaim = await claim(a).then(response => response.json());
  assert.equal(firstClaim.job.jobId, content.id); assert.ok(firstClaim.job.prompt && firstClaim.job.outputSchema);
  const stolen = await worker(b, { action: "fail", jobId: firstClaim.job.jobId, leaseToken: firstClaim.job.leaseToken, error: "worker_stopped" });
  assert.ok([403, 409].includes(stolen.status));
  const stolenBySameAccount = await worker(a2, { action: "fail", jobId: firstClaim.job.jobId, leaseToken: firstClaim.job.leaseToken, error: "worker_stopped" });
  assert.ok([403, 409].includes(stolenBySameAccount.status)); await finishContent(a, firstClaim.job);
  check("Only the signed-in owner device can claim or finish content; shared worker tokens are rejected");
  await checkWorkbenchActions(a, b, a2);
  await admin("devices", { installationId: a.client.snapshot().installationId, enabled: false, group: "" });
  const disabledApi = await local("/api/sites", undefined, a);
  assert.equal(disabledApi.status, 403);
  assert.equal((await disabledApi.json()).error, "device_disabled");
  const receipt = (await state()).hostedReceipts.find(row =>
    row.installationId === a.client.snapshot().installationId && row.component === "http_api");
  assert.equal(receipt?.status, "blocked");
  assert.equal(receipt?.code, "device_disabled");
  const disabledPage = await local(`/sites/${a.siteId}`, undefined, a);
  assert.equal(new URL(disabledPage.headers.get("location"), origin).pathname, "/managed-status");
  assert.equal((await local("/api/sites", undefined, b)).status, 200);
  assert.equal((await claim(a)).status, 403);
  const deviceJob = await ordinaryJob(a, true); await queued([deviceJob]);
  await admin("devices", { installationId: a.client.snapshot().installationId, enabled: true, group: "" });
  await completed([deviceJob]); assert.equal((await local("/api/sites", undefined, a)).status, 200);
  check("Device suspension blocks its API, native claim and device-bound ordinary jobs; restoration resumes them");
  await account(a, false);
  const accountJob = await ordinaryJob(a), otherJob = await ordinaryJob(b);
  await queued([accountJob]); await completed([otherJob]);
  await account(a, true); await completed([accountJob]);
  check("Account suspension pauses scheduled account jobs while another account continues");
  await policy({ maintenance: true, message: "Isolated maintenance" });
  const dashboard = await local(`/sites/${a.siteId}`, undefined, a);
  assert.equal(dashboard.status, 200);
  assert.ok((await dashboard.text()).includes("Isolated maintenance"), "dashboard should include the administrator's announcement");
  for (const user of users) {
    assert.equal((await local("/api/sites", undefined, user)).status, 200);
    assert.equal((await local("/api/sites", { domain: "never-requested.example.test" }, user)).status, 503);
    assert.equal((await claim(user).then(response => response.json())).job, null);
  }
  const maintenanceJobs = await Promise.all(users.map(user => ordinaryJob(user))); await queued(maintenanceJobs);
  await policy({}); await completed(maintenanceJobs);
  check("Global maintenance preserves read access, blocks writes and both workers, then recovers queued work");
  await policy({ scope: "account", scopeId: a.account.id, features: { ...features, codex: false, jobs: false } });
  const featureJob = await ordinaryJob(a); await contentJob(a);
  assert.equal((await claim(a).then(response => response.json())).job, null); await queued([featureJob]);
  await policy({ scope: "account", scopeId: a.account.id }); await completed([featureJob]);
  const recoveredContent = await claim(a).then(response => response.json()); assert.ok(recoveredContent.job); await finishContent(a, recoveredContent.job);
  check("Per-account feature switches gate ordinary and native content work");
  const oldCookie = a.cookie, oldToken = a.token;
  await a.client.login(a.credentials);
  assert.equal((await local("/api/sites", undefined, { cookie: oldCookie })).status, 401);
  assert.ok([401, 403, 503].includes((await worker(a, { action: "heartbeat", workerId: "old-token" }, oldToken)).status));
  await handoff(a); assert.equal((await local("/api/sites", undefined, a)).status, 200);
  assert.equal((await local("/api/sites", undefined, { cookie: oldCookie })).status, 401);
  assert.equal((await local("/api/sites", undefined, a2)).status, 200);
  check("Token rotation invalidates the previous browser session and native credential while retaining account data");
  await compose(["exec", "-T", "control", "node", "-e", "process.kill(1,'SIGUSR2')"]);
  await until(async () => (await local("/api/sites", undefined, a)).status === 503, "control_internal_outage", 15000);
  const outageJob = await ordinaryJob(a);
  assert.equal((await claim(a)).status, 503); await queued([outageJob]);
  await compose(["exec", "-T", "control", "node", "-e", "process.kill(1,'SIGUSR2')"]);
  await until(async () => (await local("/api/sites", undefined, a)).status === 200, "control_internal_recovery", 15000);
  await completed([outageJob]);
  check("Temporary management outage fails closed with 503 and preserves sessions for recovery");
  await admin("devices", { installationId: a.client.snapshot().installationId, enabled: false, group: "" });
  const logout = await dockerFetch(origin + "/api/hosted/session", { method: "DELETE", headers: {
    Origin: origin, "Content-Type": "application/json", Authorization: "Bearer " + a.token,
  }, body: JSON.stringify({ productId, installationId: a.client.snapshot().installationId, accountId: a.client.snapshot().accountId, desktopVersion: version }) });
  assert.equal(logout.status, 200, "device sign-out: " + (logout.ok ? "ok" : (await logout.json()).error));
  await admin("devices", { installationId: a.client.snapshot().installationId, enabled: true, group: "" });
  assert.equal((await local("/api/sites", undefined, a)).status, 401);
  assert.equal((await local("/api/sites", undefined, a2)).status, 200);
  assert.equal((await local("/api/sites", undefined, b)).status, 200);
  check("Sign-out revokes this device's copied session even while disabled and leaves other devices signed in");
  const overview = await state();
  assert.ok(overview.hostedReceipts?.length > 0);
  report.hostedReceiptCount = overview.hostedReceipts.length;
  check("Control plane receives authenticated server policy execution receipts");
  report.pass = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "hosted_smoke_failed";
  console.error("Hosted smoke failed: " + report.error); process.exitCode = 1;
} finally {
  if (started) {
    try { await compose(["down", "--volumes", "--remove-orphans"], undefined, 120000); report.cleanup.push("Isolated compose project and database volume removed"); }
    catch { report.cleanup.push("Compose cleanup failed; stop only project " + project); process.exitCode = 1; }
  }
  if (imageBuilt && process.env.ABORDER_SMOKE_KEEP_IMAGE !== "1") {
    try { await execute(["image", "rm", image]); report.cleanup.push("Run-specific runtime image removed"); }
    catch { report.cleanup.push("Runtime image cleanup failed: " + image); process.exitCode = 1; }
  }
  if ((!started || report.cleanup.includes("Isolated compose project and database volume removed"))
    && path.dirname(path.resolve(directory)) === path.resolve(tmpdir()) && path.basename(directory).startsWith(project + "-")) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
  report.finishedAt = new Date().toISOString(); writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log("Report: " + reportFile);
}
