import { createPrivateKey, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { adminSession, login, sessionCookie } from "./admin-auth.mjs";
import { openDatabase } from "./db.mjs";
import {
  acknowledge, activate, adminMutate, adminState, defaultProduct, epoch, insist, leaseForDevice,
  releaseInput, RequestError, loginUser, registerUser, normalizedUsername, digest,
  authenticateWorkbench, workbenchDevicePolicy, workbenchAccountPolicy, acknowledgeWorkbench,
} from "./model.mjs";
import { verifyOfficialRelease } from "./verify-release.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/admin", ["index.html", "text/html; charset=utf-8"]],
  ["/assets/admin.css", ["admin.css", "text/css; charset=utf-8"]],
  ["/assets/admin.js", ["admin.js", "text/javascript; charset=utf-8"]],
]);
const actionPaths = new Map(["products", "accounts", "activation", "devices", "policy", "releases"]
  .map(name => [`/admin/api/${name}`, name]));
const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function boundedInteger(raw, fallback, minimum, maximum) {
  const number = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error("Invalid numeric service setting.");
  return number;
}
export function readInternalConfig(env = process.env) {
  const secret = env.ABORDER_CONTROL_INTERNAL_SECRET;
  if (secret === undefined) {
    if (env.ABORDER_CONTROL_INTERNAL_BIND !== undefined || env.ABORDER_CONTROL_INTERNAL_PORT !== undefined) {
      throw new Error("The internal listener requires its dedicated secret.");
    }
    return null;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || Buffer.from(secret, "base64url").length !== 32
    || Buffer.from(secret, "base64url").toString("base64url") !== secret) {
    throw new Error("The internal listener requires a 32-byte random base64url secret.");
  }
  const bind = env.ABORDER_CONTROL_INTERNAL_BIND ?? "127.0.0.1";
  if (!["127.0.0.1", "::1"].includes(bind)) throw new Error("The internal listener must bind to a literal loopback address.");
  return { secret, bind, port: boundedInteger(env.ABORDER_CONTROL_INTERNAL_PORT, 18086, 1, 65535) };
}
export function readConfig(env = process.env) {
  const origin = new URL(env.ABORDER_CONTROL_ORIGIN ?? "");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
  if (origin.href !== origin.origin + "/" || !(origin.protocol === "https:"
    || (origin.protocol === "http:" && loopback && env.ABORDER_CONTROL_ALLOW_HTTP_LOOPBACK === "1"))) {
    throw new Error("Set ABORDER_CONTROL_ORIGIN to the public HTTPS origin.");
  }
  const issuer = new URL(env.ABORDER_CONTROL_ISSUER ?? origin.origin);
  if (issuer.href !== issuer.origin + "/" || !(issuer.protocol === "https:"
    || (issuer.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(issuer.hostname)
      && env.ABORDER_CONTROL_ALLOW_HTTP_LOOPBACK === "1"))) {
    throw new Error("Set ABORDER_CONTROL_ISSUER to the stable HTTPS issuer origin.");
  }
  const bind = env.ABORDER_CONTROL_BIND ?? "127.0.0.1";
  if (origin.protocol === "http:" && !["127.0.0.1", "::1", "localhost"].includes(bind)) {
    throw new Error("HTTP test mode requires a loopback listen address.");
  }
  const kid = env.ABORDER_CONTROL_SIGNING_KID;
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(kid ?? "")) throw new Error("Set ABORDER_CONTROL_SIGNING_KID to the client key identifier.");
  const filename = env.ABORDER_CONTROL_SIGNING_KEY_FILE;
  if (!filename) throw new Error("Set ABORDER_CONTROL_SIGNING_KEY_FILE.");
  const privateKey = createPrivateKey(readFileSync(filename));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("The signing key must be Ed25519.");
  const port = boundedInteger(env.ABORDER_CONTROL_PORT, 8080, 1, 65535);
  const internal = readInternalConfig(env);
  if (internal?.port === port) throw new Error("Public and internal listeners require different ports.");
  return { origin: origin.origin, issuer: issuer.origin, secure: origin.protocol === "https:", bind, kid, privateKey, port, internal,
    leaseSeconds: boundedInteger(env.ABORDER_CONTROL_LEASE_SECONDS, 900, 60, 86400),
    database: env.ABORDER_CONTROL_DB ?? "data/control.sqlite" };
}

function throttle(now) {
  const counters = new Map();
  return (key, limit, seconds) => {
    const time = now();
    let entry = counters.get(key);
    if (counters.size >= 2048) {
      for (const [name, value] of counters) if (value.end <= time) counters.delete(name);
    }
    if (!entry || entry.end <= time) {
      insist(counters.size < 4096, "rate_limited", 429);
      entry = { count: 0, end: time + seconds };
      counters.set(key, entry);
    }
    insist(++entry.count <= limit, "rate_limited", 429);
  };
}
function json(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  insist(req.headers["content-type"]?.split(";")[0].trim().toLowerCase() === "application/json", "json_required", 415);
  const maxBytes = 20 * 1024;
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) insist(Number(contentLength) <= maxBytes, "request_too_large", 413);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    insist(length <= maxBytes, "request_too_large", 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestError(400, "invalid_json"); }
  insist(value !== null && typeof value === "object" && !Array.isArray(value));
  return value;
}
function sameOrigin(req, config) {
  insist(req.headers.origin === config.origin && req.headers["sec-fetch-site"] !== "cross-site", "origin_failed", 403);
}
function bearer(req) {
  return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "")?.[1];
}

export function createControlPlane({ db, config, clock = epoch, verifyRelease = verifyOfficialRelease }) {
  const rate = throttle(clock);
  const server = createServer({ requestTimeout: 35_000, headersTimeout: 10_000, maxHeaderSize: 12 * 1024 }, async (req, res) => {
    for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
    if (config.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    try {
      insist(req.url?.startsWith("/") && !req.url.startsWith("//"), "invalid_path");
      const url = new URL(req.url, config.origin);
      const { pathname } = url;
      const now = clock();
      const ip = req.socket.remoteAddress ?? "unknown";
      if (req.method === "GET" && pathname === "/admin/") {
        res.writeHead(308, { Location: "/admin" });
        return res.end();
      }
      if (req.method === "GET" && assets.has(pathname)) {
        const [file, mime] = assets.get(pathname);
        const bytes = readFileSync(new URL(`./web/${file}`, import.meta.url));
        res.writeHead(200, { "Content-Type": mime });
        return res.end(bytes);
      }
      if (req.method === "GET" && pathname === "/healthz") {
        db.prepare("SELECT 1").get();
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && pathname === "/admin/api/state") {
        const session = adminSession(db, req.headers, now);
        const state = adminState(db, url.searchParams.get("productId") ?? defaultProduct, now);
        return json(res, 200, { ...state, csrf: session.csrf });
      }
      insist(req.method === "POST", "route_not_found", 404);
      if (pathname === "/admin/login") {
        sameOrigin(req, config);
        rate(`login:${ip}`, 20, 60);
        const body = await readBody(req);
        const { token, csrf } = login(db, body, now);
        return json(res, 200, { csrf }, { "Set-Cookie": sessionCookie(token, config.secure) });
      }
      if (pathname === "/admin/logout" || actionPaths.has(pathname)) {
        sameOrigin(req, config);
        const session = adminSession(db, req.headers, now, true);
        rate(`admin:${session.username}`, 60, 60);
        if (pathname === "/admin/logout") {
          db.prepare("DELETE FROM admin_session WHERE token_hash = ?").run(session.token_hash);
          return json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(null, config.secure) });
        }
        const body = await readBody(req);
        const action = actionPaths.get(pathname);
        let verifiedAt = null;
        if (action === "releases" && !releaseInput(body).paused) {
          insist(body.productId === defaultProduct, "product_release_unsupported", 422);
          rate(`verify-release:${session.username}`, 10, 60);
          await verifyRelease(body.version);
          // Recheck the session after the external requests.
          adminSession(db, req.headers, clock(), true);
          verifiedAt = clock();
        }
        return json(res, 200, adminMutate(db, action, body, session.username, clock(), verifiedAt));
      }
      insist(["/v1/activate", "/v1/lease", "/v1/receipt", "/v1/user/register", "/v1/user/login"].includes(pathname), "route_not_found", 404);
      const body = await readBody(req);
      if (pathname.startsWith("/v1/user/")) {
        const registering = pathname === "/v1/user/register";
        // The reverse proxy shares one socket budget. Never trust an arbitrary
        // X-Forwarded-For header; username budgets still protect targeted abuse.
        rate(`user-auth:${ip}`, 60, 60);
        rate(`user-auth-account:${digest(`${body.productId}:${normalizedUsername(body.username)}`)}`, 12, 60);
        if (registering) {
          rate(`user-register:${ip}`, 10, 60);
          return json(res, 200, registerUser(db, body, bearer(req), clock()));
        }
        return json(res, 200, loginUser(db, body, config, clock()));
      }
      if (pathname === "/v1/activate") {
        rate(`activate:${ip}`, 60, 60);
        return json(res, 200, activate(db, body, config, clock()));
      }
      const token = bearer(req);
      insist(token, "device_authentication_failed", 401);
      // Cap work per socket/IP. Clients behind the same HTTPS proxy share a
      // budget, sized above the normal heartbeat load and separate from login.
      rate(`device:${ip}`, 6000, 60);
      if (pathname === "/v1/lease") return json(res, 200, leaseForDevice(db, body, token, config, clock()));
      return json(res, 200, acknowledge(db, body, token, clock()));
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof RequestError) return json(res, error.status, { error: error.message });
      // Request bodies, authentication, tokens and raw stack details are private.
      console.error("control_plane_request_failed", error?.code ?? error?.name ?? "unknown");
      return json(res, 500, { error: "internal_error" });
    }
  });
  server.keepAliveTimeout = 5_000;
  return server;
}

export function createInternalControlPlane({ db, config, clock = epoch }) {
  if (!config.internal) throw new Error("The internal listener is not configured.");
  // This listener is intentionally absent from createControlPlane. A public
  // reverse proxy to the management port cannot reach these endpoints.
  const actions = new Map([
    ["/internal/v1/workbench/authenticate", authenticateWorkbench],
    ["/internal/v1/workbench/device-policy", workbenchDevicePolicy],
    ["/internal/v1/workbench/account-policy", workbenchAccountPolicy],
    ["/internal/v1/workbench/receipt", acknowledgeWorkbench],
  ]);
  const rate = throttle(clock);
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 4096 }, async (req, res) => {
    for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
    try {
      insist(["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)
        && req.headers.origin === undefined && req.headers.forwarded === undefined
        && !Object.keys(req.headers).some(key => key.startsWith("x-forwarded-")), "internal_transport_rejected", 403);
      const token = bearer(req);
      insist(token && timingSafeEqual(Buffer.from(token), Buffer.from(config.internal.secret)), "internal_authentication_failed", 401);
      insist(req.method === "POST" && actions.has(req.url), "route_not_found", 404);
      rate("internal", 30_000, 60);
      const body = await readBody(req);
      return json(res, 200, actions.get(req.url)(db, body, config, clock()));
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof RequestError) return json(res, error.status, { error: error.message });
      // Neither request bodies, bindings, receipts nor raw failures are logged.
      console.error("control_plane_internal_request_failed");
      return json(res, 500, { error: "internal_error" });
    }
  });
  server.keepAliveTimeout = 5_000;
  return server;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const config = readConfig();
  const db = openDatabase(config.database);
  const server = createControlPlane({ db, config });
  const servers = [server];
  if (config.internal) servers.push(createInternalControlPlane({ db, config }));
  let shuttingDown = false;
  const close = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    Promise.all(servers.map(item => new Promise(resolve => item.close(resolve)))).then(() => db.close());
  };
  for (const item of servers) item.on("error", () => {
    console.error("control_plane_listen_failed");
    process.exitCode = 1;
    close();
  });
  if (config.internal) servers[1].listen(config.internal.port, config.internal.bind);
  server.listen(config.port, config.bind, () => console.log(`A-Border SEO control plane listening on ${config.bind}:${config.port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, close);
  }
}
