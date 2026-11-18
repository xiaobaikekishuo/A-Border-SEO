import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { ManagedClient } from "../desktop/managed-client.mjs";
import * as protocol from "../source/lib/managed/protocol.mjs";

if (process.argv[2] !== "--run") {
  console.log("Usage: node scripts/smoke-managed-workspace.mjs --run [deployment-directory]");
  process.exit(0);
}
const base = path.resolve(process.argv[3] ?? "reports/deployment-aborder");
const version = process.env.ABORDER_SMOKE_VERSION ?? JSON.parse(readFileSync(new URL("../source/package.json", import.meta.url), "utf8")).version;
const image = process.env.ABORDER_SMOKE_IMAGE ?? `aborder-seo-internal:${version}`;
const config = protocol.validateConfig(JSON.parse(readFileSync(path.join(base,"management-config.json"),"utf8")));
const adminCredentials = JSON.parse(readFileSync(path.join(base,"admin-credentials.json"),"utf8"));
const runId = Date.now().toString(36) + randomBytes(3).toString("hex");
const project = "aborder-registration-smoke-" + runId;
const directory = path.join(base, project);
mkdirSync(directory,{recursive:true,mode:0o700});
const nonceDir = path.join(directory,"private","desktop-maintenance");
mkdirSync(nonceDir,{recursive:true,mode:0o700});
const nonceFile = path.join(nonceDir,"login-nonce");
const origin = "http://127.0.0.1:18330";
const report = { startedAt:new Date().toISOString(), project, origin, image, version, checks:[], pass:false, cleanup:[] };
const check = label => { report.checks.push(label); console.log("PASS "+label); };
const docker = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA,"Programs","DockerDesktop","resources","bin","docker.exe"),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles,"Docker","Docker","resources","bin","docker.exe")].find(x=>x&&existsSync(x)) ?? "docker";
const composeFile = path.join(directory,"compose.json");
function execute(args,input,timeout=120000) {
  return new Promise((resolve,reject)=>{
    const process = spawn(docker,["--context","desktop-linux",...args],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
    let stdout="",stderr="";
    process.stdout.on("data",chunk=>{stdout+=chunk;});
    process.stderr.on("data",chunk=>{stderr+=chunk;});
    const timer=setTimeout(()=>{process.kill();reject(new Error("Docker operation timed out"));},timeout);
    process.once("error",error=>{clearTimeout(timer);reject(error);});
    process.once("exit",code=>{clearTimeout(timer);code===0?resolve(stdout):reject(new Error("Docker operation failed: "+stderr.slice(-1800)));});
    process.stdin.end(input);
  });
}
const compose=(args,input,timeout)=>execute(["compose","-p",project,"-f",composeFile,...args],input,timeout);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(checker,label,timeout=90000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    try { const result=await checker(); if(result)return result; } catch {}
    await pause(1000);
  }
  throw new Error("Timed out: "+label);
}
const features={jobs:true,codex:true,manus:true,geo:true};
const fixtureKey=randomBytes(32);
const userCredentials={username:"workspace_"+runId,password:randomBytes(24).toString("base64url")};
const seal=async value=>{
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",fixtureKey,iv);
  const body=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),body]).toString("base64");
};
const open=async value=>{
  const raw=Buffer.from(value,"base64"),cipher=createDecipheriv("aes-256-gcm",fixtureKey,raw.subarray(0,12));
  cipher.setAuthTag(raw.subarray(12,28));
  return Buffer.concat([cipher.update(raw.subarray(28)),cipher.final()]).toString();
};
const client=new ManagedClient({protocol,config,file:path.join(directory,"identity.json"),dataRoot:directory,
  desktopVersion:version,versions:()=>({backendVersion:version}),requireUser:true,seal,open,onChange(){}});
let adminCookie,csrf,account,started=false;
const adminPost=async (action,body)=>{
  const response=await fetch(config.serverUrl+"/admin/api/"+action,{method:"POST",signal:AbortSignal.timeout(12000),
    headers:{"Content-Type":"application/json",Origin:config.serverUrl,Cookie:adminCookie,"X-CSRF-Token":csrf},
    body:JSON.stringify({productId:config.productId,reason:"Isolated real workspace deployment verification",...body})});
  const value=await response.json();
  assert.equal(response.status,200,JSON.stringify(value));
  return value;
};
const setAccount=enabled=>adminPost("accounts",{id:account.id,label:account.label,enabled,expiresAt:account.expiresAt,deviceLimit:1,features});
const local=(route,body,cookie)=>fetch(origin+route,{method:body===undefined?"GET":"POST",signal:AbortSignal.timeout(10000),
  headers:{Origin:origin,"Content-Type":"application/json","X-Requested-With":"XmlHttpRequest",...(cookie?{Cookie:cookie}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
const health=()=>local("/api/health").then(r=>r.json());
const dbScript=async source=>JSON.parse((await compose(["exec","-T","app","node","--input-type=module","-"],
  `import {PrismaClient} from '@prisma/client'; const db=new PrismaClient(); try { ${source} } finally { await db.$disconnect(); }`)).trim());

try {
  await execute(["image","inspect",image,"--format","{{.Id}}"]);
  const login=await fetch(config.serverUrl+"/admin/login",{method:"POST",signal:AbortSignal.timeout(12000),
    headers:{Origin:config.serverUrl,"Content-Type":"application/json"},body:JSON.stringify(adminCredentials)});
  assert.equal(login.status,200);
  csrf=(await login.json()).csrf;adminCookie=login.headers.get("set-cookie").split(";")[0];
  await client.register(userCredentials);
  await assert.rejects(client.login(userCredentials),/account_pending/);
  const overview=await fetch(config.serverUrl+"/admin/api/state",{headers:{Cookie:adminCookie}}).then(r=>r.json());
  account=overview.accounts.find(x=>x.username===userCredentials.username);assert(account);
  await setAccount(true);
  await client.login(userCredentials);
  report.accountId=account.id;
  report.installationId=client.snapshot().installationId;
  assert(client.snapshot().decision.allowed);
  check("Public registration requires approval; approved actual desktop client receives signed lease");
  const dbPassword=randomBytes(24).toString("hex"),workerToken=randomBytes(32).toString("base64url");
  const commonEnv={NODE_ENV:"production",DATABASE_URL:`postgresql://fixture:${dbPassword}@db:5432/fixture`,
    NEXTAUTH_URL:origin,AUTH_URL:origin,NEXTAUTH_SECRET:randomBytes(32).toString("base64url"),AUTH_TRUST_HOST:"true",
    ABORDER_DESKTOP_MODE:"1",ABORDER_MANAGED:"1",ABORDER_MANAGED_POLICY_DIR:"/run/aborder-managed",
    ABORDER_DESKTOP_LOGIN_NONCE_FILE:"/run/aborder-desktop/login-nonce",ABORDER_DESKTOP_MAINTENANCE_FILE:"/run/aborder-desktop/maintenance",
    LOCAL_CONTENT_WORKER_TOKEN:workerToken};
  const mounts=[{type:"bind",source:path.join(directory,"private","managed"),target:"/run/aborder-managed",read_only:true},
    {type:"bind",source:nonceDir,target:"/run/aborder-desktop",read_only:true}];
  const composeData={services:{
    db:{image:"postgres:16-alpine",environment:{POSTGRES_DB:"fixture",POSTGRES_USER:"fixture",POSTGRES_PASSWORD:dbPassword},
      volumes:["database:/var/lib/postgresql/data"],healthcheck:{test:["CMD-SHELL","pg_isready -U fixture -d fixture"],interval:"2s",timeout:"3s",retries:30}},
    app:{image,command:["sh","-c","node node_modules/prisma/build/index.js migrate deploy && node server.js"],
      environment:{...commonEnv,WORKER_MODE:"off"},volumes:mounts,ports:["127.0.0.1:18330:3000"],depends_on:{db:{condition:"service_healthy"}},
      healthcheck:{test:["CMD","node","-e","fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],interval:"3s",timeout:"3s",retries:40}},
    worker:{image,command:["node","worker.cjs"],environment:{...commonEnv,WORKER_MODE:"worker"},
      volumes:mounts,depends_on:{app:{condition:"service_healthy"}},stop_grace_period:"35s"},
  },volumes:{database:{}}};
  writeFileSync(composeFile,JSON.stringify(composeData,null,2),{mode:0o600});
  started=true;
  await compose(["up","-d"],undefined,180000);
  const initial=await until(async()=>{const h=await health();return h.status==="ok"&&h.managed.workerApplied&&h;},"initial worker heartbeat");
  assert.equal(initial.version,version);assert(initial.desktopMode);check("Fresh PostgreSQL migration, app and real Docker worker healthy without Google credentials");
  const nonce=randomBytes(32).toString("base64url");writeFileSync(nonceFile,nonce,{mode:0o600});
  const binding=()=>{const s=client.snapshot();return {nonce,installationId:s.installationId,accountId:s.accountId,sequence:s.decision.sequence};};
  assert.equal((await local("/api/desktop/managed-login",{...binding(),nonce:randomBytes(32).toString("base64url")})).status,403);
  const entered=await local("/api/desktop/managed-login",binding());assert.equal(entered.status,200,await entered.clone().text());
  const cookie=entered.headers.get("set-cookie").split(";")[0];assert(cookie.startsWith("authjs.session-token="));
  assert.equal((await local("/api/sites",undefined,cookie)).status,200);
  assert.equal((await local("/api/sites")).status,401);check("Nonce-protected handoff creates real local user session; sites API rejects unauthenticated access");
  const googleStatus=await local("/api/google/connection",undefined,cookie);
  assert.equal(googleStatus.status,200);
  const googleConnection=await googleStatus.json();
  assert.equal(googleConnection.configured,false);assert.equal(googleConnection.connected,false);
  assert.equal(googleConnection.redirectUri,origin+"/api/auth/callback/google");
  const unknownGoogleState="aborder-gsc."+randomBytes(32).toString("base64url");
  const googleCallback=await local("/api/auth/callback/google?state="+unknownGoogleState+"&error=access_denied");
  assert.equal(googleCallback.status,400);
  assert((await googleCallback.text()).includes("connection request is invalid or expired"));
  assert.equal(googleCallback.headers.get("set-cookie"),null);
  assert.equal((await local("/api/sites",undefined,cookie)).status,200);
  check("Google callback uses the registered path and rejects an unknown connection state without signing in or changing the existing session");
  const added=await local("/api/sites",{domain:"https://example.com/"},cookie);
  assert.equal(added.status,201,await added.clone().text());
  const manualSite=await added.json();
  assert.equal(manualSite.domain,"example.com");assert.equal(manualSite.gscProperty,null);
  const sites=await local("/api/sites",undefined,cookie).then(r=>r.json());
  assert(sites.some(site=>site.id===manualSite.id&&site.gscProperty===null));
  const stored=await dbScript(`const s=await db.site.findUniqueOrThrow({where:{id:${JSON.stringify(manualSite.id)}},include:{user:{select:{googleTokens:true}}}});
    console.log(JSON.stringify({gscJobs:await db.job.count({where:{siteId:s.id,type:'gsc-sync'}}),googleConnected:s.user.googleTokens!==null}));`);
  assert.equal(stored.gscJobs,0);assert.equal(stored.googleConnected,false);
  assert.equal((await local("/api/sites",{domain:"example.com"},cookie)).status,409);
  check("Google connection reports unavailable; new user creates and lists a manual site without tokens or GSC jobs; duplicates are rejected");
  const assistant=await local(`/api/sites/${manualSite.id}/assistant`,undefined,cookie);
  assert.equal(assistant.status,200,await assistant.clone().text());
  assert(Array.isArray((await assistant.json()).jobs));
  const assistantPage=await local(`/sites/${manualSite.id}/assistant`,undefined,cookie);
  assert.equal(assistantPage.status,200);
  assert((await assistantPage.text()).includes("Continue with ChatGPT"));
  const overviewPage=await local(`/sites/${manualSite.id}`,undefined,cookie);
  assert.equal(overviewPage.status,200);
  const overviewHtml=await overviewPage.text();
  assert(overviewHtml.includes("Your site is ready")||overviewHtml.includes("网站已添加"));
  check("Manual site opens overview and Codex workbench with a real session and displays the ChatGPT connection entry");
  if (process.env.ABORDER_SMOKE_BROWSER === "1") {
    const { chromium, expect } = await import(new URL("../source/node_modules/@playwright/test/index.mjs", import.meta.url).href);
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
      const separator = cookie.indexOf("=");
      await context.addCookies([
        { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: origin, httpOnly: true, sameSite: "Lax" },
        { name: "aborder-locale", value: "en", url: origin, sameSite: "Lax" },
      ]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(origin + "/sites", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Add site", exact: true }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("button", { name: "Enter domain", exact: true })).toHaveAttribute("aria-pressed", "true");
      await dialog.getByLabel("Website domain", { exact: true }).fill("example.org");
      const createdResponse = page.waitForResponse(response => response.url() === origin + "/api/sites" && response.request().method() === "POST");
      await dialog.getByRole("button", { name: "Add site", exact: true }).click();
      const created = await createdResponse;
      assert.equal(created.status(), 201);
      assert.deepEqual(created.request().postDataJSON(), { domain: "example.org" });
      const browserSite = await created.json();
      assert.equal(browserSite.domain, "example.org"); assert.equal(browserSite.gscProperty, null);
      await page.waitForURL(origin + "/sites/" + browserSite.id);
      await expect(page.getByText("Your site is ready", { exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(directory, "browser-manual-site.png"), fullPage: true });
      await page.goto(origin + "/sites", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Add site", exact: true }).first().click();
      await dialog.getByRole("button", { name: "Import from Google", exact: true }).click();
      await expect(dialog.getByText("Google is not configured for this installation. You can add a site manually and ask the administrator to enable this connection later.", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Connect Google", exact: true })).toBeDisabled();
      await page.screenshot({ path: path.join(directory, "browser-google-unconfigured.png"), fullPage: true });
      report.browser = { isolatedContext: true, channel: "chrome", siteId: browserSite.id,
        screenshots: ["browser-manual-site.png", "browser-google-unconfigured.png"] };
      check("Isolated Chrome submits the real add-site form and opens the site; Google import clearly reports missing configuration");
    } finally { await browser.close(); }
  }
  if (process.env.ABORDER_SMOKE_BING === "1") {
    const { runBingReportSmoke } = await import("./smoke-bing-report.mjs");
    await runBingReportSmoke({ local, cookie, siteId: manualSite.id, dbScript, origin, directory, report, check });
  }
  await setAccount(false);await client.poll({force:true});
  assert.equal((await local("/api/sites",undefined,cookie)).status,403);
  const blocked=await until(async()=>{const h=await health();return h.managed.reason==="account_disabled"&&h.managed.phase==="effective"&&h;},"disabled policy applied by worker");
  assert(blocked.managed.workerApplied);await client.report("effective","account_disabled");
  check("Public account disable blocks existing browser cookie; actual Docker worker confirms policy applied");
  const seed=await dbScript(`const u=await db.user.findFirstOrThrow(); const s=await db.site.create({data:{userId:u.id,domain:'fixture.example.test'}});
    const p=await db.contentPillar.create({data:{siteId:s.id,title:'Fixture',keyword:'fixture'}});
    const j=await db.job.create({data:{siteId:s.id,type:'alerts-evaluate',source:'manual',maxAttempts:1}});
    const c=await db.contentPlanJob.create({data:{siteId:s.id,pillarId:p.id}});
    console.log(JSON.stringify({site:s.id,job:j.id,content:c.id}));`);
  const claim=await fetch(origin+"/api/local-content-worker",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+workerToken},
    body:JSON.stringify({action:"claim",workerId:"isolated-registration-fixture",protocolVersion:2})});
  assert.equal(claim.status,200);assert.equal((await claim.json()).job,null);
  await pause(5000);
  const queued=await dbScript(`console.log(JSON.stringify({job:(await db.job.findUniqueOrThrow({where:{id:${JSON.stringify(seed.job)}}})).status,
    content:(await db.contentPlanJob.findUniqueOrThrow({where:{id:${JSON.stringify(seed.content)}}})).status}));`);
  assert.equal(queued.job,"QUEUED");assert.equal(queued.content,"QUEUED");
  check("Queued ordinary job and local Codex content job remain unclaimed while disabled");
  await dbScript(`await db.site.delete({where:{id:${JSON.stringify(seed.site)}}});console.log('{}');`);
  await setAccount(true);await client.poll({force:true});
  assert.equal((await local("/api/sites",undefined,cookie)).status,200);
  check("Administrator recovery restores the same account without a new Google login");
  unlinkSync(nonceFile);
  assert.equal((await local("/api/sites",undefined,cookie)).status,401);
  check("Removing privileged desktop nonce invalidates a copied browser session");
  writeFileSync(nonceFile,nonce,{mode:0o600});
  await client.logout();
  assert.equal((await local("/api/sites",undefined,cookie)).status,403);
  const loggedOut=await until(async()=>{const h=await health();return !h.managed.allowed&&h.managed.phase==="effective"&&h;},"logout policy worker heartbeat");
  assert(loggedOut.managed.workerApplied);assert.equal(client.snapshot().signedIn,false);
  check("Desktop logout removes signed grant and real app/worker authority");
  report.pass=true;
} catch(error) {
  report.error=error.message;process.exitCode=1;console.error("Workspace smoke failed: "+error.message);
} finally {
  if(started)try{await compose(["down","--volumes","--remove-orphans"],undefined,120000);report.cleanup.push("Owned Compose project and fixture volume removed");}catch(error){report.cleanup.push("Compose cleanup failed: "+error.message);report.pass=false;process.exitCode=1;}
  if(account&&adminCookie) {
    try {
      const overview=await fetch(config.serverUrl+"/admin/api/state",{headers:{Cookie:adminCookie}}).then(r=>r.json());
      const device=overview.devices.find(d=>d.installationId===client.snapshot().installationId&&d.accountId===account.id);
      if(device)await adminPost("devices",{installationId:device.installationId,enabled:false,unbind:true,group:device.group??""});
      await setAccount(false);report.cleanup.push("Dedicated verification account disabled and its device revoked");
    }catch(error){report.cleanup.push("Account cleanup failed: "+error.message);report.pass=false;process.exitCode=1;}
  }
  if(adminCookie)await fetch(config.serverUrl+"/admin/logout",{method:"POST",headers:{Origin:config.serverUrl,Cookie:adminCookie,"X-CSRF-Token":csrf}}).catch(()=>{});
  report.finishedAt=new Date().toISOString();
  writeFileSync(path.join(directory,"result.json"),JSON.stringify(report,null,2));
  console.log("Workspace report: "+path.join(directory,"result.json"));
}
