import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const audience = "aborder-managed-client";
export const maxLeaseSeconds = 86_400;
export const clockToleranceSeconds = 120;
export const managedFeatures = Object.freeze(["jobs", "codex", "manus", "geo"]);
const blockedFeatures = Object.freeze({ jobs: false, codex: false, manus: false, geo: false });
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const versionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const base64url = /^[a-zA-Z0-9_-]+$/;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const stringMatches = (pattern, value) => typeof value === "string" && pattern.test(value);

export function compareVersions(left, right) {
  if (!stringMatches(versionPattern, left) || !stringMatches(versionPattern, right)) throw new Error("invalid_version");
  const parts = right.split(".").map(Number);
  for (const [index, value] of left.split(".").map(Number).entries()) {
    if (value !== parts[index]) return value < parts[index] ? -1 : 1;
  }
  return 0;
}

function managementOrigin(value, allowHttpLoopback) {
  if (typeof value !== "string" || value.length > 256) throw new Error("invalid_management_config");
  let url;
  try { url = new URL(value); } catch { throw new Error("invalid_management_config"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.hash || url.search
    || (url.protocol !== "https:" && !(allowHttpLoopback && loopback && url.protocol === "http:"))
    || (value !== url.origin && value !== url.origin + "/")) throw new Error("invalid_management_config");
  return url.origin;
}

export function validateConfig(config, { allowHttpLoopback = false } = {}) {
  if (!record(config) || !stringMatches(identifier, config.productId) || !record(config.keys)) throw new Error("invalid_management_config");
  const serverUrl = managementOrigin(config.serverUrl, allowHttpLoopback);
  // The pinned issuer is an authorization identity, while serverUrl is the
  // current transport origin. A configured move must not rewrite that identity.
  const issuer = config.issuer === undefined ? serverUrl : managementOrigin(config.issuer, allowHttpLoopback);
  const keys = Object.entries(config.keys);
  if (keys.length < 1 || keys.length > 8) throw new Error("invalid_management_config");
  for (const [kid, pem] of keys) {
    if (!stringMatches(identifier, kid) || typeof pem !== "string" || pem.length > 512
      || !pem.startsWith("-----BEGIN PUBLIC KEY-----") || createPublicKey(pem).asymmetricKeyType !== "ed25519") {
      throw new Error("invalid_management_config");
    }
  }
  return { serverUrl, issuer, productId: config.productId, keys: Object.fromEntries(keys) };
}

function validateClaims(claims) {
  if (!record(claims) || claims.v !== 1 || typeof claims.iss !== "string" || claims.iss.length > 256
    || claims.aud !== audience || !stringMatches(identifier, claims.productId)
    || !stringMatches(identifier, claims.installationId) || !stringMatches(identifier, claims.accountId)
    || !integer(claims.iat) || !integer(claims.exp) || claims.exp <= claims.iat || claims.exp - claims.iat > maxLeaseSeconds
    || !integer(claims.sequence) || claims.sequence === 0 || !integer(claims.revision) || claims.revision === 0) {
    throw new Error("invalid_lease");
  }
  const p = claims.policy;
  if (!record(p) || !["productDisabled", "accountDisabled", "deviceDisabled"].every(key => typeof p[key] === "boolean")
    || !(p.entitlementExpiresAt === null || integer(p.entitlementExpiresAt))
    || !record(p.maintenance) || typeof p.maintenance.active !== "boolean"
    || typeof p.maintenance.message !== "string" || p.maintenance.message.length > 2000
    || !record(p.features) || !managedFeatures.every(key => typeof p.features[key] === "boolean")
    || ![p.minimumDesktopVersion, p.minimumBackendVersion].every(value => value === null || stringMatches(versionPattern, value))) {
    throw new Error("invalid_lease_policy");
  }
  const release = p.release;
  if (release !== null && (!record(release) || !stringMatches(versionPattern, release.version)
    || typeof release.notes !== "string" || release.notes.length > 4000
    || !(release.deadline === null || integer(release.deadline)))) throw new Error("invalid_lease_policy");
  return claims;
}

const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");

export function signLease(claims, kid, privateKey) {
  validateClaims(claims);
  if (!stringMatches(identifier, kid)) throw new Error("invalid_signing_key");
  const key = typeof privateKey === "string" || Buffer.isBuffer(privateKey) ? createPrivateKey(privateKey) : privateKey;
  if (key?.asymmetricKeyType !== "ed25519" || key.type !== "private") throw new Error("invalid_signing_key");
  const input = `${encode({ alg: "EdDSA", typ: "JWT", kid })}.${encode(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
}

function decode(segment) {
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) throw new Error("invalid_lease");
  return bytes;
}

export function verifyLease(token, { config, installationId, accountId, now = Math.floor(Date.now() / 1000), allowExpired = false }) {
  if (typeof token !== "string" || token.length > 24_000) throw new Error("invalid_lease");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every(part => base64url.test(part))) throw new Error("invalid_lease");
  const [header, payload, signature] = parts;
  const fields = JSON.parse(decode(header).toString("utf8"));
  if (!record(fields) || Object.keys(fields).length !== 3 || fields.alg !== "EdDSA" || fields.typ !== "JWT"
    || !stringMatches(identifier, fields.kid) || !Object.hasOwn(config.keys, fields.kid)) throw new Error("invalid_lease_key");
  const key = createPublicKey(config.keys[fields.kid]);
  const bytes = decode(signature);
  if (key.asymmetricKeyType !== "ed25519" || bytes.length !== 64
    || !verify(null, Buffer.from(`${header}.${payload}`), key, bytes)) throw new Error("invalid_lease_signature");
  const claims = validateClaims(JSON.parse(decode(payload).toString("utf8")));
  if (claims.iss !== config.issuer || claims.productId !== config.productId
    || claims.installationId !== installationId || claims.accountId !== accountId) throw new Error("invalid_lease_binding");
  if (!integer(now) || claims.iat > now + clockToleranceSeconds) throw new Error("clock_invalid");
  if (!allowExpired && claims.exp <= now) throw new Error("lease_expired");
  return claims;
}

export function denied(reason) {
  return { allowed: false, reason, features: blockedFeatures, revision: null, sequence: null, maintenanceMessage: "", release: null };
}

export function evaluateLease(claims, { desktopVersion, backendVersion, now = Math.floor(Date.now() / 1000), clockInvalid = false }) {
  if (!claims) return denied("activation_required");
  const { policy: p } = claims;
  const below = (version, minimum) => minimum !== null && (!stringMatches(versionPattern, version) || compareVersions(version, minimum) < 0);
  let reason = null;
  if (p.productDisabled) reason = "product_disabled";
  else if (p.accountDisabled) reason = "account_disabled";
  else if (p.deviceDisabled) reason = "device_disabled";
  else if (clockInvalid) reason = "clock_invalid";
  else if (p.entitlementExpiresAt !== null && p.entitlementExpiresAt <= now) reason = "entitlement_expired";
  else if (claims.exp <= now) reason = "lease_expired";
  else if (below(desktopVersion, p.minimumDesktopVersion) || below(backendVersion, p.minimumBackendVersion)) reason = "update_required";
  else if (p.maintenance.active) reason = "maintenance";
  return {
    allowed: reason === null,
    reason,
    features: reason ? blockedFeatures : Object.fromEntries(managedFeatures.map(name => [name, p.features[name]])),
    revision: claims.revision, sequence: claims.sequence,
    maintenanceMessage: p.maintenance.message, release: p.release,
  };
}

export function readManagedState(config, state, { backendVersion, now = Math.floor(Date.now() / 1000) }) {
  if (!state || state.lease === null) return denied("activation_required");
  if (state.v !== 1 || !integer(state.highestWallTime) || !integer(state.receivedAt)
    || state.receivedAt > state.highestWallTime || !stringMatches(versionPattern, state.desktopVersion)) return denied("invalid_lease");
  const clockInvalid = now + clockToleranceSeconds < state.highestWallTime;
  try {
    const claims = verifyLease(state.lease, {
      config, installationId: state.installationId, accountId: state.accountId,
      now: Math.max(now, state.highestWallTime), allowExpired: true,
    });
    return evaluateLease(claims, { desktopVersion: state.desktopVersion, backendVersion,
      now: Math.max(now, state.highestWallTime), clockInvalid });
  } catch (error) {
    return denied(error?.message === "clock_invalid" ? "clock_invalid" : "invalid_lease");
  }
}
