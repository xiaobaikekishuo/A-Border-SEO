import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { audience, readManagedState, signLease, validateConfig, verifyLease, type LeaseClaims } from "./protocol.mjs";

const pair = generateKeyPairSync("ed25519");
const originalOrigin = "https://original-control.example.test";
const movedOrigin = "https://new-workbench.example.test";
const base = { serverUrl: originalOrigin, productId: "a-border-seo",
  keys: { fixture: pair.publicKey.export({ type: "spki", format: "pem" }).toString() } };
const claims: LeaseClaims = { v: 1, iss: originalOrigin, aud: audience, productId: base.productId,
  installationId: "installation-fixture", accountId: "account-fixture", iat: 1000, exp: 1900, sequence: 1, revision: 1,
  policy: { productDisabled: false, accountDisabled: false, deviceDisabled: false, entitlementExpiresAt: null,
    maintenance: { active: false, message: "" }, features: { jobs: true, codex: true, manus: true, geo: true },
    minimumDesktopVersion: null, minimumBackendVersion: null, release: null } };

describe("management transport origin and pinned issuer", () => {
  it("defaults an omitted issuer to the transport origin and normalizes an optional root slash", () => {
    expect(validateConfig({ ...base, serverUrl: originalOrigin + "/" })).toEqual({ ...base, issuer: originalOrigin });
    expect(validateConfig({ ...base, issuer: originalOrigin + "/" }).issuer).toBe(originalOrigin);
  });

  it("preserves the explicit issuer when the public transport origin moves", () => {
    const config = validateConfig({ ...base, serverUrl: movedOrigin, issuer: originalOrigin });
    expect(config.serverUrl).toBe(movedOrigin);
    expect(config.issuer).toBe(originalOrigin);
    const token = signLease(claims, "fixture", pair.privateKey);
    expect(verifyLease(token, { config, installationId: claims.installationId, accountId: claims.accountId, now: 1100 })).toEqual(claims);
    expect(readManagedState(config, { v: 1, installationId: claims.installationId, accountId: claims.accountId,
      lease: token, desktopVersion: "1.5.0", receivedAt: 1000, highestWallTime: 1100 },
    { backendVersion: "1.5.0", now: 1100 }).allowed).toBe(true);
  });

  it("rejects a valid signature from the new transport or an unrelated issuer instead of the pinned issuer", () => {
    const config = validateConfig({ ...base, serverUrl: movedOrigin, issuer: originalOrigin });
    for (const issuer of [movedOrigin, "https://other.example.test"]) {
      const token = signLease({ ...claims, iss: issuer }, "fixture", pair.privateKey);
      expect(() => verifyLease(token, { config, installationId: claims.installationId, accountId: claims.accountId, now: 1100 }))
        .toThrow("invalid_lease_binding");
    }
  });

  it.each([undefined, null, "", "/relative", "https://user@example.test", "https://user:pass@example.test", "https://@example.test",
    "https://example.test/path", "https://example.test/path/..", "https://example.test?x=1", "https://example.test?",
    "https://example.test#fragment", "https://example.test#", " https://example.test", "https://example.test\n",
    "file:///tmp/test", "javascript:alert(1)", "http://remote.example.test"])("rejects non-origin or unsafe transport %s", value => {
    expect(() => validateConfig({ ...base, serverUrl: value })).toThrow("invalid_management_config");
  });

  it.each([null, "", "https://user@example.test", "https://@example.test", "https://example.test/path", "https://example.test/./",
    "https://example.test?next=evil", "https://example.test#", " https://example.test", "https://example.test\n",
    "http://remote.example.test", "ftp://example.test"])("validates an explicit issuer independently and strictly: %s", value => {
    expect(() => validateConfig({ ...base, issuer: value })).toThrow("invalid_management_config");
  });

  it("permits HTTP only for explicit loopback test mode, independently for transport and issuer", () => {
    const transport = "http://127.0.0.1:18085";
    const issuer = "http://[::1]:18084";
    expect(() => validateConfig({ ...base, serverUrl: transport, issuer })).toThrow("invalid_management_config");
    expect(validateConfig({ ...base, serverUrl: transport, issuer }, { allowHttpLoopback: true }))
      .toEqual({ ...base, serverUrl: transport, issuer });
    expect(() => validateConfig({ ...base, issuer: "http://localhost:18084" })).toThrow("invalid_management_config");
    for (const field of ["serverUrl", "issuer"]) {
      expect(() => validateConfig({ ...base, [field]: "http://remote.example.test" }, { allowHttpLoopback: true }))
        .toThrow("invalid_management_config");
    }
  });
});
