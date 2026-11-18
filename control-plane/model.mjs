import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { audience, compareVersions, evaluateLease, managedFeatures as featureNames, signLease } from "../source/lib/managed/protocol.mjs";
import { transaction } from "./db.mjs";

export const defaultProduct = "a-border-seo";
export const featureDefaults = Object.fromEntries(featureNames.map(name => [name, true]));
export const epoch = () => Math.floor(Date.now() / 1000);
export const digest = value => createHash("sha256").update(value).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");

export class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}
export function insist(condition, code = "invalid_input", status = 400) {
  if (!condition) throw new RequestError(status, code);
}
const slugPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const identityPattern = /^[A-Za-z0-9_-]{16,80}$/;
const versionPattern = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
const tokenPattern = /^[a-zA-Z0-9_-]{43}$/;
const groupPattern = /^[a-zA-Z0-9_-]{0,48}$/;
const reportCodePattern = /^[a-z0-9_-]{1,64}$/;
const receiptStatuses = ["received", "draining", "effective", "failed", "upgrading"];
const usernamePattern = /^[a-z0-9_.-]{3,64}$/;
const dummyUserSalt = randomBytes(16);
const dummyUserHash = randomBytes(64);

function match(value, pattern) { return typeof value === "string" && pattern.test(value); }
function whole(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function optionalEpoch(value) { return value === null || whole(value, 0, 253402300799); }
function optionalVersion(value) { return value === null || match(value, versionPattern); }
function bounded(value, max, empty = true) {
  return typeof value === "string" && value.length <= max && (empty || value.trim().length > 0);
}
function features(value) {
  insist(value && featureNames.every(key => typeof value[key] === "boolean"));
  return Object.fromEntries(featureNames.map(key => [key, value[key]]));
}
function getProduct(db, id) {
  insist(match(id, slugPattern));
  const row = db.prepare("SELECT * FROM product WHERE id = ?").get(id);
  insist(row, "product_not_found", 404);
  return row;
}
function getAccount(db, product, id) {
  const row = db.prepare("SELECT * FROM account WHERE product_id = ? AND id = ?").get(product, id);
  insist(row, "account_not_found", 404);
  return row;
}
function deviceRow(db, product, installation) {
  return db.prepare("SELECT * FROM device WHERE product_id = ? AND installation_id = ?").get(product, installation);
}
function getDevice(db, product, installation) {
  const row = deviceRow(db, product, installation);
  insist(row, "device_not_found", 404);
  return row;
}
function publicAccount(row) {
  if (!row) return null;
  return { id: row.id, label: row.label, enabled: Boolean(row.enabled), expiresAt: row.expires_at,
    deviceLimit: row.device_limit, features: JSON.parse(row.features), username: row.username ?? null,
    approval: row.username ? (row.approved_at === null ? "pending" : "approved") : null,
    registeredAt: row.registered_at ?? null };
}
function publicDevice(row) {
  if (!row) return null;
  return { installationId: row.installation_id, accountId: row.account_id, enabled: Boolean(row.enabled),
    revoked: Boolean(row.revoked), group: row.group_name, lastSeenAt: row.last_seen_at,
    desktopVersion: row.desktop_version, backendVersion: row.backend_version, sequence: row.sequence,
    receiptSequence: row.receipt_sequence, receiptRevision: row.receipt_revision, receiptStatus: row.receipt_status,
    receiptCode: row.receipt_code, receiptAt: row.receipt_at };
}
function publicPolicy(row) {
  if (!row) return null;
  return { scope: row.scope, scopeId: row.scope_id, disabled: Boolean(row.disabled), maintenance: Boolean(row.maintenance),
    startAt: row.start_at, endAt: row.end_at, message: row.message, features: JSON.parse(row.features) };
}
function publicRelease(row) {
  if (!row) return null;
  return { productId: row.product_id, version: row.version, ...JSON.parse(row.config), verifiedAt: row.verified_at };
}
function publicAudit(row) {
  return { actor: row.actor, action: row.action, scope: row.scope, reason: row.reason, at: row.at,
    before: row.before_json && JSON.parse(row.before_json), after: row.after_json && JSON.parse(row.after_json) };
}
function audit(db, product, actor, action, scope, reason, before, after, now) {
  const beforeJson = before === null ? null : JSON.stringify(before);
  const afterJson = after === null ? null : JSON.stringify(after);
  if (beforeJson === afterJson) return;
  db.prepare(`INSERT INTO audit(product_id, actor, action, scope, reason, before_json, after_json, at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(product, actor, action, scope, reason, beforeJson, afterJson, now);
}
function bump(db, product) {
  db.prepare("UPDATE product SET revision = revision + 1 WHERE id = ?").run(product);
}
function checkReason(body) {
  insist(bounded(body.reason, 500, false), "reason_required");
  return body.reason.trim();
}
function registeredDevices(db, product, account) {
  return db.prepare("SELECT count(*) AS count FROM device WHERE product_id = ? AND account_id = ? AND revoked = 0")
    .get(product, account).count;
}
function activeMaintenance(policy, now) {
  return policy.maintenance && (policy.startAt === null || policy.startAt <= now)
    && (policy.endAt === null || now < policy.endAt);
}
function policyRows(db, product) {
  return db.prepare("SELECT * FROM policy WHERE product_id = ? ORDER BY scope, scope_id").all(product).map(publicPolicy);
}
function releaseRows(db, product) {
  return db.prepare("SELECT * FROM release WHERE product_id = ?").all(product).map(publicRelease)
    .sort((a, b) => compareVersions(b.version, a.version));
}

function scopedTo(policy, device) {
  return policy.scope === "product"
    || (policy.scope === "account" && policy.scopeId === device.account_id)
    || (policy.scope === "device" && policy.scopeId === device.installation_id)
    || (policy.scope === "group" && policy.scopeId === device.group_name);
}
function inCohort(release, device) {
  if (release.paused || !release.verifiedAt || (release.group && release.group !== device.group_name)) return false;
  const bucket = parseInt(digest(`${device.product_id}:${device.installation_id}:${release.version}`).slice(0, 8), 16) % 100;
  return bucket < release.percent;
}

function makeClaims(db, device, config, now) {
  const product = getProduct(db, device.product_id);
  const account = publicAccount(getAccount(db, product.id, device.account_id));
  const matching = policyRows(db, product.id).filter(policy => scopedTo(policy, device));
  const eligible = releaseRows(db, product.id).filter(candidate => inCohort(candidate, device));
  return makeSubjectClaims({ product, account, device, matching, eligible, config, now });
}

function makeSubjectClaims({ product, account, device, matching, eligible, config, now }) {
  const active = matching.filter(policy => activeMaintenance(policy, now));
  const release = eligible[0];
  const enforced = eligible.filter(candidate => candidate.deadline === null || candidate.deadline <= now);
  const minimum = field => enforced.map(candidate => candidate[field]).filter(Boolean).sort(compareVersions).at(-1) ?? null;
  const stops = [now + config.leaseSeconds, account.expiresAt, ...eligible.map(candidate => candidate.deadline)];
  for (const window of matching) {
    if (window.maintenance) stops.push(window.startAt, window.endAt);
  }
  const exp = Math.min(...stops.filter(value => Number.isInteger(value) && value > now));
  return {
    v: 1, iss: config.issuer ?? config.origin, aud: audience,
    productId: product.id, installationId: device?.installation_id ?? null, accountId: account.id,
    iat: now, exp, sequence: device ? device.sequence + 1 : 1, revision: product.revision,
    policy: {
      productDisabled: matching.some(policy => policy.scope === "product" && policy.disabled),
      accountDisabled: !account.enabled || account.approval === "pending"
        || matching.some(policy => policy.scope === "account" && policy.disabled),
      deviceDisabled: Boolean(device && (!device.enabled || device.revoked
        || matching.some(policy => ["device", "group"].includes(policy.scope) && policy.disabled))),
      entitlementExpiresAt: account.expiresAt,
      maintenance: { active: active.length > 0, message: active.map(policy => policy.message).filter(Boolean).join("\n").slice(0, 500) },
      features: Object.fromEntries(featureNames.map(key => [
        key, account.features[key] && matching.every(policy => policy.features[key]),
      ])),
      minimumDesktopVersion: device ? minimum("minimumDesktopVersion") : null,
      minimumBackendVersion: minimum("minimumBackendVersion"),
      release: release ? { version: release.version, notes: release.notes, deadline: release.deadline } : null,
    },
  };
}

function clientIdentity(body) {
  insist(match(body.productId, slugPattern) && match(body.installationId, identityPattern));
}
function clientVersions(body) {
  insist(match(body.desktopVersion, versionPattern) && optionalVersion(body.backendVersion));
}
function issueLease(db, body, device, config, now) {
  const claims = makeClaims(db, device, config, now);
  const lease = signLease(claims, config.kid, config.privateKey);
  db.prepare(`UPDATE device SET sequence = ?, last_seen_at = ?, desktop_version = ?, backend_version = ?
    WHERE product_id = ? AND installation_id = ?`).run(claims.sequence, now, body.desktopVersion, body.backendVersion,
      device.product_id, device.installation_id);
  db.prepare(`INSERT INTO issued_lease(product_id, installation_id, sequence, revision, valid_until, release_version)
    VALUES(?, ?, ?, ?, ?, ?)`).run(device.product_id, device.installation_id, claims.sequence, claims.revision, claims.exp,
      claims.policy.release?.version ?? null);
  db.prepare("DELETE FROM issued_lease WHERE product_id = ? AND installation_id = ? AND sequence <= ?")
    .run(device.product_id, device.installation_id, claims.sequence - 128);
  return lease;
}

function deviceTokenFor(code, product, installation) {
  // The activation secret already has 256 random bits. Domain separation and
  // the fixed binding let a lost response be retried without storing a token.
  return createHash("sha256").update(JSON.stringify(["aborder-device-token-v1", code, product, installation]))
    .digest("base64url");
}
export function activate(db, body, config, now) {
  clientIdentity(body);
  clientVersions(body);
  insist(body.platform === "win32-x64" && match(body.code, tokenPattern), "invalid_activation", 401);
  return transaction(db, () => {
    const hashed = digest(body.code);
    const activation = db.prepare("SELECT * FROM activation WHERE code_hash = ? AND product_id = ?")
      .get(hashed, body.productId);
    insist(activation && activation.expires_at > now && (!activation.target_installation_id
      || activation.target_installation_id === body.installationId), "invalid_activation", 401);
    const account = getAccount(db, body.productId, activation.account_id);
    const token = deviceTokenFor(body.code, body.productId, body.installationId);
    let device = deviceRow(db, body.productId, body.installationId);
    if (activation.consumed_at !== null) {
      insist(activation.installation_id === body.installationId && device?.account_id === account.id
        && device.token_hash === digest(token) && !device.revoked, "invalid_activation", 401);
    } else {
      insist(account.enabled && (account.expires_at === null || account.expires_at > now), "account_unavailable", 403);
      if (device && !device.revoked) {
        insist(device.enabled && device.account_id === account.id, "installation_already_bound", 409);
        db.prepare("UPDATE device SET token_hash = ? WHERE product_id = ? AND installation_id = ?")
          .run(digest(token), body.productId, body.installationId);
        db.prepare("DELETE FROM issued_lease WHERE product_id = ? AND installation_id = ?").run(body.productId, body.installationId);
      } else if (device) {
        insist(activation.target_installation_id === body.installationId, "device_requires_reactivation", 409);
        insist(registeredDevices(db, body.productId, account.id) < account.device_limit, "device_limit_reached", 409);
        db.prepare(`UPDATE device SET account_id = ?, token_hash = ?, enabled = 1, revoked = 0, group_name = '',
          receipt_sequence = NULL, receipt_revision = NULL, receipt_status = NULL, receipt_code = NULL, receipt_at = NULL
          WHERE product_id = ? AND installation_id = ?`).run(account.id, digest(token), body.productId, body.installationId);
        // A new account can reuse a previously unbound installation. Old grants
        // retain lower sequences, while old device credentials stop authenticating.
        db.prepare("DELETE FROM issued_lease WHERE product_id = ? AND installation_id = ?").run(body.productId, body.installationId);
      } else {
        insist(registeredDevices(db, body.productId, account.id) < account.device_limit, "device_limit_reached", 409);
        db.prepare(`INSERT INTO device(product_id, installation_id, account_id, token_hash, last_seen_at, desktop_version, backend_version)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(body.productId, body.installationId, account.id, digest(token), now,
          body.desktopVersion, body.backendVersion);
      }
      db.prepare("UPDATE activation SET installation_id = ?, consumed_at = ? WHERE code_hash = ?")
        .run(body.installationId, now, hashed);
      device = getDevice(db, body.productId, body.installationId);
      audit(db, body.productId, account.id, "device_activated", body.installationId, "one_time_activation", null,
        { accountId: account.id, installationId: device.installation_id }, now);
    }
    return { accountId: account.id, deviceToken: token, lease: issueLease(db, body, device, config, now) };
  });
}

function authenticatedDevice(db, body, token) {
  clientIdentity(body);
  insist(match(token, tokenPattern), "device_authentication_failed", 401);
  const device = db.prepare("SELECT * FROM device WHERE token_hash = ? AND product_id = ? AND installation_id = ?")
    .get(digest(token), body.productId, body.installationId);
  insist(device, "device_authentication_failed", 401);
  return device;
}

export function normalizedUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function userCredentials(body, registering = false) {
  const username = normalizedUsername(body.username);
  insist(match(username, usernamePattern) && typeof body.password === "string"
    && body.password.length <= 128 && body.password.length >= (registering ? 8 : 1),
  registering ? "invalid_registration" : "invalid_user_credentials", registering ? 400 : 401);
  return username;
}
function passwordMatches(account, password) {
  const stored = account?.password_hash?.split(":").map(value => Buffer.from(value, "hex"));
  const supplied = scryptSync(password, stored?.[0] ?? dummyUserSalt, 64);
  return timingSafeEqual(supplied, stored?.[1] ?? dummyUserHash) && Boolean(account);
}

export function registerUser(db, body, token, now) {
  clientIdentity(body);
  clientVersions(body);
  insist(body.platform === "win32-x64");
  const username = userCredentials(body, true);
  getProduct(db, body.productId);
  const salt = randomBytes(16);
  const hash = `${salt.toString("hex")}:${scryptSync(body.password, salt, 64).toString("hex")}`;
  return transaction(db, () => {
    insist(!db.prepare("SELECT 1 FROM account WHERE product_id = ? AND username = ?")
      .get(body.productId, username), "username_taken", 409);
    let accountId, before = null;
    const existingDevice = deviceRow(db, body.productId, body.installationId);
    if (token !== undefined || existingDevice) {
      const device = authenticatedDevice(db, body, token);
      insist(!device.revoked && device.enabled, "device_unavailable", 403);
      const account = getAccount(db, body.productId, device.account_id);
      insist(!account.username, "account_already_registered", 409);
      accountId = account.id;
      before = publicAccount(account);
    } else {
      accountId = randomUUID();
      db.prepare(`INSERT INTO account(product_id, id, label, enabled, expires_at, device_limit, features)
        VALUES(?, ?, ?, 0, NULL, 1, ?)`).run(body.productId, accountId, username, JSON.stringify(featureDefaults));
    }
    db.prepare(`UPDATE account SET enabled = 0, username = ?, password_hash = ?, registered_at = ?,
      approved_at = NULL, registration_installation_id = ? WHERE product_id = ? AND id = ?`)
      .run(username, hash, now, body.installationId, body.productId, accountId);
    bump(db, body.productId);
    audit(db, body.productId, accountId, "user_registered", accountId, "administrator_approval_required", before,
      publicAccount(getAccount(db, body.productId, accountId)), now);
    return { registered: true, accountId, username, approval: "pending" };
  });
}

export function loginUser(db, body, config, now) {
  clientIdentity(body);
  clientVersions(body);
  insist(body.platform === "win32-x64");
  const username = userCredentials(body);
  const matchedAccount = db.prepare("SELECT * FROM account WHERE product_id = ? AND username = ?").get(body.productId, username);
  insist(passwordMatches(matchedAccount, body.password), "invalid_user_credentials", 401);
  return transaction(db, () => {
    const account = getAccount(db, body.productId, matchedAccount.id);
    insist(account.password_hash === matchedAccount.password_hash, "invalid_user_credentials", 401);
    insist(account.approved_at !== null, "account_pending", 403);
    insist(account.enabled, "account_disabled", 403);
    insist(account.expires_at === null || account.expires_at > now, "account_expired", 403);
    let device = deviceRow(db, body.productId, body.installationId);
    const token = randomToken();
    if (device) {
      insist(device.account_id === account.id, "installation_already_bound", 409);
      insist(!device.revoked, "device_requires_reactivation", 409);
      insist(device.enabled, "device_disabled", 403);
      db.prepare("UPDATE device SET token_hash = ? WHERE product_id = ? AND installation_id = ?")
        .run(digest(token), body.productId, body.installationId);
      db.prepare("DELETE FROM issued_lease WHERE product_id = ? AND installation_id = ?")
        .run(body.productId, body.installationId);
    } else {
      insist(registeredDevices(db, body.productId, account.id) < account.device_limit, "device_limit_reached", 409);
      db.prepare(`INSERT INTO device(product_id, installation_id, account_id, token_hash, last_seen_at, desktop_version, backend_version)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(body.productId, body.installationId, account.id, digest(token), now,
          body.desktopVersion, body.backendVersion);
    }
    device = getDevice(db, body.productId, body.installationId);
    audit(db, body.productId, account.id, "user_login", body.installationId, "registered_user_login", null,
      { accountId: account.id, installationId: device.installation_id }, now);
    return { accountId: account.id, deviceToken: token, lease: issueLease(db, body, device, config, now), user: { username } };
  });
}

export function leaseForDevice(db, body, token, config, now) {
  clientVersions(body);
  insist(body.platform === "win32-x64");
  return transaction(db, () => ({ lease: issueLease(db, body, authenticatedDevice(db, body, token), config, now) }));
}

function internalMac(config, value) {
  return createHmac("sha256", config.internal.secret).update(value).digest("base64url");
}
function constantTokenEquals(left, right) {
  return match(left, tokenPattern) && match(right, tokenPattern)
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
function hostedBinding(device, config) {
  return internalMac(config, JSON.stringify(["aborder-hosted-session-v1", device.product_id,
    device.account_id, device.installation_id, device.token_hash]));
}
function hostedSubject(body, device = null) {
  return { productId: body.productId, accountId: device?.account_id ?? body.accountId,
    installationId: device?.installation_id ?? null,
    desktopVersion: device ? body.desktopVersion : null, backendVersion: body.backendVersion };
}
function hostedFingerprint(snapshot) {
  return digest(JSON.stringify([snapshot.revision, snapshot.policy, snapshot.allowed, snapshot.reason, snapshot.features]));
}
function hostedSnapshot(db, body, device, claims, config, now) {
  const account = publicAccount(getAccount(db, claims.productId, claims.accountId));
  const evaluated = evaluateLease(claims, { desktopVersion: body.desktopVersion, backendVersion: body.backendVersion, now });
  const snapshot = { v: 1, issuer: config.issuer ?? config.origin, scope: device ? "device" : "account",
    ...hostedSubject(body, device), username: account.username, label: account.label,
    checkedAt: now, validUntil: Math.min(claims.exp, now + 30), revision: claims.revision,
    policy: claims.policy, allowed: evaluated.allowed, reason: evaluated.reason, features: evaluated.features,
    maintenanceMessage: evaluated.maintenanceMessage, release: evaluated.release };
  // The ticket attests to this check only. It is not an offline authorization,
  // a desktop lease, or proof that a job or client has executed the policy.
  const ticket = { v: 1, scope: snapshot.scope, subject: hostedSubject(body, device),
    sessionBinding: device ? hostedBinding(device, config) : null,
    checkedAt: snapshot.checkedAt, validUntil: snapshot.validUntil, fingerprint: hostedFingerprint(snapshot) };
  const encoded = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  return { ...snapshot, receiptTicket: encoded + "." + internalMac(config, "aborder-hosted-receipt-v1:" + encoded) };
}
function validateHostedVersions(body, device = true) {
  // The backend supplies its actual running version, never a desktop-supplied
  // claim about a local Docker image. Account jobs have no desktop requirement.
  insist(match(body.backendVersion, versionPattern));
  if (device) insist(match(body.desktopVersion, versionPattern));
}

export function authenticateWorkbench(db, body, config, now) {
  validateHostedVersions(body);
  const device = authenticatedDevice(db, body, body.deviceToken);
  insist(!device.revoked && (body.accountId === undefined || body.accountId === device.account_id),
    "device_authentication_failed", 401);
  const snapshot = hostedSnapshot(db, body, device, makeClaims(db, device, config, now), config, now);
  return { ...snapshot, sessionBinding: hostedBinding(device, config) };
}

function hostedDevice(db, body, config) {
  clientIdentity(body);
  insist(match(body.accountId, identityPattern), "device_authentication_failed", 401);
  const device = deviceRow(db, body.productId, body.installationId);
  insist(device && !device.revoked && device.account_id === body.accountId
    && constantTokenEquals(body.sessionBinding, hostedBinding(device, config)), "device_authentication_failed", 401);
  return device;
}

export function workbenchDevicePolicy(db, body, config, now) {
  validateHostedVersions(body);
  const device = hostedDevice(db, body, config);
  return hostedSnapshot(db, body, device, makeClaims(db, device, config, now), config, now);
}

export function workbenchAccountPolicy(db, body, config, now) {
  insist(match(body.productId, slugPattern) && match(body.accountId, identityPattern));
  validateHostedVersions(body, false);
  const product = getProduct(db, body.productId);
  const account = publicAccount(getAccount(db, product.id, body.accountId));
  const matching = policyRows(db, product.id).filter(policy => policy.scope === "product"
    || (policy.scope === "account" && policy.scopeId === account.id));
  // A shared worker has no device rollout bucket. Only a verified, unpaused,
  // globally completed rollout defines its backend floor. Device-originated
  // work must retain its own device context and call the device policy route.
  const eligible = releaseRows(db, product.id).filter(release => !release.paused && release.verifiedAt
    && release.percent === 100 && release.group === "");
  const claims = makeSubjectClaims({ product, account, device: null, matching, eligible, config, now });
  return hostedSnapshot(db, body, null, claims, config, now);
}

export function acknowledgeWorkbench(db, body, config, now) {
  insist(typeof body.ticket === "string" && body.ticket.length <= 8000, "invalid_hosted_receipt");
  const parts = body.ticket.split(".");
  insist(parts.length === 2 && /^[A-Za-z0-9_-]+$/.test(parts[0])
    && constantTokenEquals(parts[1], internalMac(config, "aborder-hosted-receipt-v1:" + parts[0])), "invalid_hosted_receipt", 401);
  let ticket;
  try { ticket = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch { throw new RequestError(400, "invalid_hosted_receipt"); }
  insist(ticket?.v === 1 && ["device", "account"].includes(ticket.scope) && ticket.subject
    && whole(ticket.checkedAt, 0, now) && whole(ticket.validUntil, now + 1, ticket.checkedAt + 30),
  "hosted_receipt_expired", 409);
  insist(["effective", "blocked", "draining", "failed"].includes(body.status)
    && (body.code === undefined || match(body.code, reportCodePattern)), "invalid_hosted_receipt");
  insist(["http_session", "http_api", "content_worker", "ordinary_worker"].includes(body.component)
    && (ticket.scope === "device" || !["http_session", "content_worker"].includes(body.component)), "invalid_hosted_receipt_component");
  return transaction(db, () => {
    const request = { ...ticket.subject, sessionBinding: ticket.sessionBinding };
    const current = ticket.scope === "device" ? workbenchDevicePolicy(db, request, config, now)
      : workbenchAccountPolicy(db, request, config, now);
    insist(hostedFingerprint(current) === ticket.fingerprint, "hosted_policy_changed", 409);
    insist(body.status !== "blocked" || !current.allowed || Object.values(current.features).some(value => !value),
      "hosted_receipt_status_mismatch", 409);
    const subjectId = current.installationId ?? current.accountId;
    const previous = db.prepare("SELECT checked_at FROM hosted_receipt WHERE product_id = ? AND scope = ? AND subject_id = ? AND component = ?")
      .get(current.productId, current.scope, subjectId, body.component);
    insist(!previous || previous.checked_at <= ticket.checkedAt, "hosted_receipt_stale", 409);
    const device = current.scope === "device" ? hostedDevice(db, request, config) : null;
    db.prepare(`INSERT INTO hosted_receipt(product_id, scope, subject_id, component, account_id, installation_id,
      token_hash, revision, desktop_version, backend_version, status, code, checked_at, valid_until, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id, scope, subject_id, component) DO UPDATE SET account_id = excluded.account_id,
      installation_id = excluded.installation_id, token_hash = excluded.token_hash, revision = excluded.revision,
      desktop_version = excluded.desktop_version, backend_version = excluded.backend_version,
      status = excluded.status, code = excluded.code, checked_at = excluded.checked_at,
      valid_until = excluded.valid_until, at = excluded.at`).run(current.productId, current.scope, subjectId, body.component,
      current.accountId, current.installationId, device?.token_hash ?? null, current.revision,
      request.desktopVersion, request.backendVersion, body.status, body.code ?? null,
      ticket.checkedAt, ticket.validUntil, now);
    return { ok: true, scope: current.scope, component: body.component, revision: current.revision, at: now };
  });
}

export function acknowledge(db, body, token, now) {
  clientVersions(body);
  const code = body.code ?? null;
  insist(whole(body.sequence, 1, Number.MAX_SAFE_INTEGER) && whole(body.revision, 1, Number.MAX_SAFE_INTEGER)
    && receiptStatuses.includes(body.status) && (code === null || match(code, reportCodePattern)));
  return transaction(db, () => {
    const device = authenticatedDevice(db, body, token);
    const key = [device.product_id, device.installation_id];
    const issued = db.prepare("SELECT * FROM issued_lease WHERE product_id = ? AND installation_id = ? AND sequence = ?")
      .get(...key, body.sequence);
    insist(issued && issued.revision === body.revision, "unknown_lease_receipt", 409);
    if (code === "update_verified") {
      insist(body.status === "effective" && issued.release_version
        && body.desktopVersion === issued.release_version && body.backendVersion === issued.release_version, "update_not_verified", 409);
    }
    const final = ["effective", "failed"];
    if ((device.receipt_sequence ?? 0) > body.sequence || (device.receipt_sequence === body.sequence && (
      (device.receipt_status === body.status && device.receipt_code === code)
      || (body.status === "received" && device.receipt_status !== "received")
      || (final.includes(device.receipt_status) && body.status === "draining")
    ))) return { ok: true };

    const current = body.sequence === device.sequence;
    db.prepare(`UPDATE device SET receipt_sequence = ?, receipt_revision = ?, receipt_status = ?, receipt_code = ?,
      receipt_at = ?, last_seen_at = ?, desktop_version = ?, backend_version = ?
      WHERE product_id = ? AND installation_id = ?`).run(body.sequence, body.revision, body.status, code,
      now, now, current ? body.desktopVersion : device.desktop_version, current ? body.backendVersion : device.backend_version, ...key);
    if (issued.release_version && body.status === "failed" && code?.startsWith("update_")) {
      db.prepare(`INSERT INTO rollout_failure(product_id, release_version, installation_id, at, code)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(product_id, release_version, installation_id) DO UPDATE SET at = excluded.at, code = excluded.code`)
        .run(device.product_id, issued.release_version, device.installation_id, now, code);
    }
    if (code === "update_verified") {
      db.prepare(`INSERT INTO rollout_success(product_id, release_version, installation_id, at) VALUES (?, ?, ?, ?)
        ON CONFLICT(product_id, release_version, installation_id) DO UPDATE SET at = excluded.at`)
        .run(device.product_id, issued.release_version, device.installation_id, now);
    }
    // Keep a history of operational transitions. Repeated received/effective
    // heartbeats at one policy revision do not add a row every minute.
    const reason = code ?? body.status;
    const previousReceipt = db.prepare(`SELECT 1 FROM audit
      WHERE product_id = ? AND action = 'device_receipt' AND scope = ? AND reason = ?
        AND json_extract(after_json, '$.revision') = ? AND json_extract(after_json, '$.status') = ? LIMIT 1`)
      .get(device.product_id, device.installation_id, reason, body.revision, body.status);
    if (!previousReceipt) {
      audit(db, device.product_id, device.installation_id, "device_receipt", device.installation_id, reason,
        { status: device.receipt_status, revision: device.receipt_revision },
        { status: body.status, revision: body.revision, release: issued.release_version }, now);
    }
    return { ok: true };
  });
}

function upsertAccount(db, product, body, now) {
  insist(bounded(body.label, 100, false) && typeof body.enabled === "boolean" && optionalEpoch(body.expiresAt)
    && whole(body.deviceLimit, 1, 1000));
  const id = body.id ?? randomUUID();
  insist(match(id, identityPattern));
  const before = body.id ? publicAccount(getAccount(db, product, id)) : null;
  if (before) insist(body.deviceLimit >= registeredDevices(db, product, id), "device_limit_below_bindings", 409);
  const after = { id, label: body.label.trim(), enabled: body.enabled, expiresAt: body.expiresAt,
    deviceLimit: body.deviceLimit, features: features(body.features) };
  db.prepare(`INSERT INTO account(product_id, id, label, enabled, expires_at, device_limit, features) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id, id) DO UPDATE SET label = excluded.label, enabled = excluded.enabled,
      expires_at = excluded.expires_at, device_limit = excluded.device_limit, features = excluded.features`)
    .run(product, id, after.label, Number(after.enabled), after.expiresAt, after.deviceLimit, JSON.stringify(after.features));
  if (body.enabled && before?.approval === "pending") {
    db.prepare("UPDATE account SET approved_at = ? WHERE product_id = ? AND id = ?").run(now, product, id);
  }
  return { before, after: publicAccount(getAccount(db, product, id)), scope: id };
}

function updateDevice(db, product, body) {
  insist(match(body.installationId, identityPattern) && match(body.group, groupPattern) && typeof body.enabled === "boolean"
    && (body.unbind === undefined || typeof body.unbind === "boolean"));
  const before = publicDevice(getDevice(db, product, body.installationId));
  const revoked = body.unbind || before.revoked;
  insist(!(before.revoked && body.enabled && !body.unbind), "device_requires_reactivation", 409);
  db.prepare("UPDATE device SET enabled = ?, revoked = ?, group_name = ? WHERE product_id = ? AND installation_id = ?")
    .run(Number(body.enabled && !revoked), Number(revoked), body.group, product, body.installationId);
  return { before, after: publicDevice(getDevice(db, product, body.installationId)), scope: body.installationId };
}

function upsertPolicy(db, product, body) {
  insist(["product", "account", "device", "group"].includes(body.scope)
    && typeof body.disabled === "boolean" && typeof body.maintenance === "boolean"
    && optionalEpoch(body.startAt) && optionalEpoch(body.endAt) && bounded(body.message, 500));
  if (body.startAt !== null && body.endAt !== null) insist(body.startAt < body.endAt, "invalid_maintenance_window");
  let scopeId = body.scopeId;
  if (body.scope === "product") insist(scopeId === "", "invalid_scope");
  else if (body.scope === "group") insist(match(scopeId, groupPattern) && scopeId, "invalid_scope");
  else {
    insist(match(scopeId, identityPattern), "invalid_scope");
    if (body.scope === "account") getAccount(db, product, scopeId);
    else getDevice(db, product, scopeId);
  }
  const before = publicPolicy(db.prepare("SELECT * FROM policy WHERE product_id = ? AND scope = ? AND scope_id = ?")
    .get(product, body.scope, scopeId));
  const after = { scope: body.scope, scopeId, disabled: body.disabled, maintenance: body.maintenance,
    startAt: body.startAt, endAt: body.endAt, message: body.message.trim(), features: features(body.features) };
  db.prepare(`INSERT INTO policy(product_id, scope, scope_id, disabled, maintenance, start_at, end_at, message, features)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(product_id, scope, scope_id) DO UPDATE SET disabled = excluded.disabled,
    maintenance = excluded.maintenance, start_at = excluded.start_at, end_at = excluded.end_at,
    message = excluded.message, features = excluded.features`).run(product, after.scope, scopeId, Number(after.disabled),
      Number(after.maintenance), after.startAt, after.endAt, after.message, JSON.stringify(after.features));
  return { before, after, scope: `${after.scope}:${scopeId || product}` };
}

export function releaseInput(body) {
  insist(match(body.version, versionPattern) && ["test", "stable"].includes(body.channel) && whole(body.percent, 0, 100)
    && match(body.group, groupPattern) && (body.channel === "stable" || body.group)
    && optionalVersion(body.minimumDesktopVersion) && optionalVersion(body.minimumBackendVersion)
    && optionalEpoch(body.deadline) && bounded(body.notes, 3000) && typeof body.paused === "boolean");
  for (const minimum of [body.minimumDesktopVersion, body.minimumBackendVersion]) {
    insist(minimum === null || compareVersions(minimum, body.version) <= 0, "minimum_exceeds_release");
  }
  return { channel: body.channel, percent: body.percent, group: body.group, minimumDesktopVersion: body.minimumDesktopVersion,
    minimumBackendVersion: body.minimumBackendVersion, deadline: body.deadline, notes: body.notes.trim(), paused: body.paused };
}
function upsertRelease(db, product, body, verifiedAt) {
  const config = releaseInput(body);
  const before = publicRelease(db.prepare("SELECT * FROM release WHERE product_id = ? AND version = ?").get(product, body.version));
  insist(config.paused || verifiedAt !== null, "release_unverified", 422);
  const expanded = before && (config.percent > before.percent || config.group !== before.group
    || (before.channel === "test" && config.channel === "stable"));
  if (!config.paused && expanded) {
    insist(!db.prepare("SELECT 1 FROM rollout_failure WHERE product_id = ? AND release_version = ?")
      .get(product, body.version), "rollout_failed", 409);
  }
  const verified = verifiedAt ?? before?.verifiedAt ?? null;
  db.prepare(`INSERT INTO release(product_id, version, config, verified_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(product_id, version) DO UPDATE SET config = excluded.config, verified_at = excluded.verified_at`)
    .run(product, body.version, JSON.stringify(config), verified);
  return { before, after: { productId: product, version: body.version, ...config, verifiedAt: verified }, scope: body.version };
}

export function adminMutate(db, action, body, actor, now, verifiedAt = null) {
  const reason = checkReason(body);
  return transaction(db, () => {
    if (action === "products") {
      insist(match(body.id, slugPattern) && bounded(body.name, 100, false));
      insist(!db.prepare("SELECT 1 FROM product WHERE id = ?").get(body.id), "product_exists", 409);
      const row = { id: body.id, name: body.name.trim(), revision: 1 };
      db.prepare("INSERT INTO product(id, name) VALUES (?, ?)").run(row.id, row.name);
      audit(db, row.id, actor, action, row.id, reason, null, row, now);
      return row;
    }
    const product = getProduct(db, body.productId).id;
    if (action === "activation") {
      insist(match(body.accountId, identityPattern));
      const account = getAccount(db, product, body.accountId);
      insist(account.enabled && (account.expires_at === null || account.expires_at > now), "account_unavailable", 409);
      const target = body.installationId ?? null;
      if (target !== null) {
        insist(match(target, identityPattern));
        insist(getDevice(db, product, target).revoked, "device_already_bound", 409);
      }
      const code = randomToken();
      const expiresAt = now + 15 * 60;
      db.prepare("DELETE FROM activation WHERE expires_at <= ?").run(now);
      db.prepare("INSERT INTO activation(code_hash, product_id, account_id, expires_at, target_installation_id) VALUES (?, ?, ?, ?, ?)")
        .run(digest(code), product, account.id, expiresAt, target);
      audit(db, product, actor, action, account.id, reason, null, { expiresAt, installationId: target }, now);
      return { code, expiresAt };
    }
    let change;
    if (action === "accounts") change = upsertAccount(db, product, body, now);
    else if (action === "devices") change = updateDevice(db, product, body);
    else if (action === "policy") change = upsertPolicy(db, product, body);
    else if (action === "releases") change = upsertRelease(db, product, body, verifiedAt);
    else throw new RequestError(404, "route_not_found");
    if (JSON.stringify(change.before) !== JSON.stringify(change.after)) {
      bump(db, product);
      audit(db, product, actor, action, change.scope, reason, change.before, change.after, now);
    }
    return change.after;
  });
}

export function adminState(db, productId, now) {
  const product = getProduct(db, productId);
  const accounts = db.prepare("SELECT * FROM account WHERE product_id = ? ORDER BY label, id").all(product.id).map(publicAccount);
  const deviceRows = db.prepare(`SELECT device.*, issued_lease.valid_until AS receipt_valid_until FROM device
    LEFT JOIN issued_lease ON issued_lease.product_id = device.product_id AND issued_lease.installation_id = device.installation_id
      AND issued_lease.sequence = device.receipt_sequence
    WHERE device.product_id = ?
    ORDER BY device.last_seen_at DESC, device.installation_id`)
    .all(product.id);
  const devices = deviceRows.map(publicDevice);
  const policies = policyRows(db, product.id);
  const releases = releaseRows(db, product.id);
  const auditRows = db.prepare("SELECT * FROM audit WHERE product_id = ? ORDER BY id DESC LIMIT 200").all(product.id);
  const successes = db.prepare("SELECT release_version, installation_id, at FROM rollout_success WHERE product_id = ?").all(product.id);
  const failures = db.prepare("SELECT release_version, installation_id, at FROM rollout_failure WHERE product_id = ?").all(product.id);
  const hostedReceipts = db.prepare(`SELECT r.scope, r.component, r.subject_id AS subjectId, r.account_id AS accountId,
    r.installation_id AS installationId, r.revision, r.desktop_version AS desktopVersion,
    r.backend_version AS backendVersion, r.status, r.code, r.checked_at AS checkedAt,
    r.valid_until AS validUntil, r.at,
    CASE WHEN r.component != 'legacy' AND r.revision = ? AND r.valid_until > ? AND (r.scope = 'account'
      OR (d.revoked = 0 AND d.account_id = r.account_id AND d.token_hash = r.token_hash)) THEN 1 ELSE 0 END AS current
    FROM hosted_receipt r LEFT JOIN device d ON d.product_id = r.product_id AND d.installation_id = r.installation_id
    WHERE r.product_id = ? ORDER BY r.at DESC`).all(product.revision, now, product.id)
    .map(row => ({ ...row, current: Boolean(row.current) }));
  const outcome = (rows, installation, version) => rows.find(row => row.installation_id === installation && row.release_version === version);
  const summary = { devices: devices.length, online: 0, maintenance: policies.some(policy => policy.scope === "product"
    && activeMaintenance(policy, now)), versions: { desktop: {}, backend: {} },
  receipts: { pending: 0, received: 0, draining: 0, effective: 0, failed: 0, upgrading: 0, offline: 0 },
  upgrades: { succeeded: 0, failed: 0, upgrading: 0, pending: 0 } };
  for (const [index, device] of devices.entries()) {
    const online = device.lastSeenAt >= now - 180;
    if (online) summary.online++;
    const status = !online ? "offline" : device.receiptRevision !== product.revision || !device.receiptStatus
      || (deviceRows[index].receipt_valid_until ?? 0) <= now
      ? "pending" : device.receiptStatus;
    summary.receipts[status]++;
    for (const [kind, version] of [["desktop", device.desktopVersion], ["backend", device.backendVersion]]) {
      const label = version ?? "unknown";
      summary.versions[kind][label] = (summary.versions[kind][label] ?? 0) + 1;
    }
    const release = releases.find(candidate => inCohort(candidate, deviceRows[index]));
    if (release) {
      const success = outcome(successes, device.installationId, release.version);
      const failure = outcome(failures, device.installationId, release.version);
      if (success && (!failure || success.at >= failure.at)) summary.upgrades.succeeded++;
      else if (failure) summary.upgrades.failed++;
      else if (status === "upgrading") summary.upgrades.upgrading++;
      else if (device.desktopVersion !== release.version || device.backendVersion !== release.version) summary.upgrades.pending++;
    }
  }
  for (const release of releases) {
    release.rollout = {
      succeeded: successes.filter(row => row.release_version === release.version).length,
      failed: failures.filter(row => row.release_version === release.version).length,
    };
  }
  return { products: db.prepare("SELECT * FROM product ORDER BY id").all(), product, accounts, devices, policies, releases,
    audit: auditRows.map(publicAudit), hostedReceipts, summary };
}
