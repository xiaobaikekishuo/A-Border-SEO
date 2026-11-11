import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const profile = { findFirst: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn(), create: vi.fn() };
  const attempt = { findUnique: vi.fn(), deleteMany: vi.fn(), create: vi.fn() };
  const tx = { chatGptProfile: profile, chatGptLoginAttempt: attempt, chatGptHost: { upsert: vi.fn() }, $queryRaw: vi.fn() };
  return { db: { ...tx, $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)), site: { findFirst: vi.fn() } }, profile, attempt, tx, verifyIdentity: vi.fn(), tokenRequest: vi.fn() };
});
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("./protocol", async original => ({ ...await original<typeof import("./protocol")>(), verifyIdentity: mocks.verifyIdentity, tokenRequest: mocks.tokenRequest }));
import { encrypt, decrypt } from "@/lib/encryption";
import { ContentError } from "@/lib/content-planner/http";
import { assertPlanConnection, finishConnection, getConnectionStatus, getPlanAccessToken, runConnectionAction } from "./service";
import { CALLBACK, hashState, PLAN_SCOPE } from "./protocol";

const state = "s".repeat(43), owner = "owner", profileId = "profile";
const baseTokens = () => ({ accessToken: "local-access-secret", refreshToken: "local-refresh-secret", idToken: "local-id-secret", scopes: [PLAN_SCOPE, "resource.invoke"], expiresAt: Date.now() + 3600000 });
const profile = () => ({ id: profileId, userId: owner, subject: "verified-subject", clientId: "oaiapp_local", email: "owner@example.test", scopes: [PLAN_SCOPE, "resource.invoke"], encryptedTokens: encrypt(JSON.stringify(baseTokens())), selected: true, epoch: 1 });
const pending = () => ({ stateHash: hashState(state), profileId, userId: owner, epoch: 1, expiresAt: new Date(Date.now() + 60000), returnPath: "/sites/site/assistant", encryptedPending: encrypt(JSON.stringify({ nonce: "nonce", verifier: "verifier", clientId: "oaiapp_local" })) });
beforeEach(() => {
  vi.clearAllMocks(); process.env.NEXTAUTH_SECRET = "test-only-not-real-secrets";
  mocks.attempt.deleteMany.mockResolvedValue({ count: 1 }); mocks.profile.updateMany.mockResolvedValue({ count: 1 }); mocks.profile.findUniqueOrThrow.mockResolvedValue(profile());
  mocks.profile.findFirst.mockResolvedValue(profile()); mocks.profile.update.mockResolvedValue(profile());
  mocks.verifyIdentity.mockResolvedValue({ subject: "verified-subject", email: "owner@example.test" });
  mocks.tokenRequest.mockResolvedValue({ token_type: "Bearer", access_token: "new-access", refresh_token: "new-refresh", id_token: "new-id", expires_in: 3600, scope: `${PLAN_SCOPE} resource.invoke` });
});
describe("one-use OAuth callback", () => {
  it("rejects missing, unknown, expired, replayed and duplicate state without code exchange", async () => {
    expect((await finishConnection(new URL(CALLBACK))).error).toBe("chatgpt_state_invalid");
    mocks.attempt.findUnique.mockResolvedValue(null);
    expect((await finishConnection(new URL(`${CALLBACK}?state=${state}&code=code`))).error).toBe("chatgpt_state_expired");
    mocks.attempt.findUnique.mockResolvedValue({ ...pending(), expiresAt: new Date(0) });
    expect((await finishConnection(new URL(`${CALLBACK}?state=${state}&code=code`))).error).toBe("chatgpt_state_expired");
    mocks.attempt.findUnique.mockResolvedValue(pending()); mocks.attempt.deleteMany.mockResolvedValue({ count: 0 });
    expect((await finishConnection(new URL(`${CALLBACK}?state=${state}&code=code`))).error).toBe("chatgpt_state_expired");
    expect((await finishConnection(new URL(`${CALLBACK}?state=${state}&state=${state}&code=code`))).error).toBe("chatgpt_state_invalid");
    expect(mocks.tokenRequest).not.toHaveBeenCalled();
  });
  it("consumes valid cancellation without exchanging a code", async () => {
    mocks.attempt.findUnique.mockResolvedValue(pending());
    expect(await finishConnection(new URL(`${CALLBACK}?state=${state}&error=access_denied`))).toEqual({ path: "/sites/site/assistant", error: "chatgpt_authorization_declined" });
    expect(mocks.attempt.deleteMany).toHaveBeenCalled(); expect(mocks.tokenRequest).not.toHaveBeenCalled();
  });
  it("does not resurrect a connection canceled before or during exchange", async () => {
    mocks.attempt.findUnique.mockResolvedValue(pending()); mocks.profile.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await finishConnection(new URL(`${CALLBACK}?state=${state}&code=code`))).error).toBe("chatgpt_connection_changed");
    expect(mocks.tokenRequest).not.toHaveBeenCalled();
    mocks.profile.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect((await finishConnection(new URL(`${CALLBACK}?state=${state}&code=code`))).error).toBe("chatgpt_connection_changed");
  });
  it("persists issued registration before exchange, verifies identity, encrypts stored credentials", async () => {
    mocks.attempt.findUnique.mockResolvedValue({ ...pending(), encryptedPending: encrypt(JSON.stringify({ nonce: "nonce", verifier: "verifier", clientId: null })) });
    expect(await finishConnection(new URL(`${CALLBACK}?state=${state}&code=code&client_id=oaiapp_local`))).toEqual({ path: "/sites/site/assistant" });
    expect(mocks.profile.updateMany.mock.invocationCallOrder[0]).toBeLessThan(mocks.tokenRequest.mock.invocationCallOrder[0]);
    expect(mocks.verifyIdentity).toHaveBeenCalledWith("new-id", "oaiapp_local", "nonce", "verified-subject");
    const written = mocks.profile.updateMany.mock.calls.find(([args]) => args.data.encryptedTokens)?.[0].data.encryptedTokens;
    expect(written).not.toContain("new-access"); expect(JSON.parse(decrypt(written)).accessToken).toBe("new-access");
  });
});
describe("owned ChatGPT profile usage", () => {
  it.each(["keyword-research", "domain-overview", "backlinks"])("returns sign-in to the owned %s page without permitting arbitrary redirects", async page => {
    mocks.db.site.findFirst.mockResolvedValue({ id: "site" });
    mocks.tx.chatGptHost.upsert.mockResolvedValue({ hostId: "urn:uuid:test-host" });
    const returnPath = `/sites/site/${page}`;
    await expect(runConnectionAction(owner, { action: "connect", profileId, returnPath })).resolves.toHaveProperty("url");
    expect(mocks.db.site.findFirst).toHaveBeenCalledWith({ where: { id: "site", userId: owner }, select: { id: true } });
    expect(mocks.attempt.create).toHaveBeenCalledWith({ data: expect.objectContaining({ returnPath, userId: owner }) });
    for (const path of ["https://outside.test", "//outside.test", `${returnPath}?redirect=outside`, `${returnPath}/extra`, "/sites/site/settings", `/sites/../${page}`]) {
      await expect(runConnectionAction(owner, { action: "connect", profileId, returnPath: path })).rejects.toThrow("Invalid return destination");
    }
    mocks.db.site.findFirst.mockResolvedValue(null);
    await expect(runConnectionAction(owner, { action: "connect", profileId, returnPath })).rejects.toThrow("Invalid return destination");
  });
  it("pins queued requests to the validated connection epoch", async () => {
    await expect(assertPlanConnection(owner, profileId, 1)).resolves.toEqual({ epoch: 1 });
    await expect(assertPlanConnection(owner, profileId, 0)).rejects.toThrow("chatgpt_connection_changed");
    await expect(getPlanAccessToken(owner, profileId, 0)).rejects.toThrow("chatgpt_connection_changed");
    expect(mocks.tokenRequest).not.toHaveBeenCalled();
  });
  it("requires ownership and both inference permissions", async () => {
    mocks.profile.findFirst.mockResolvedValue(null); await expect(assertPlanConnection(owner, profileId)).rejects.toThrow();
    mocks.profile.findFirst.mockResolvedValue({ ...profile(), scopes: [PLAN_SCOPE] }); await expect(assertPlanConnection(owner, profileId)).rejects.toThrow("chatgpt_plan_permission_required");
    expect(mocks.profile.findFirst).toHaveBeenCalledWith({ where: { id: profileId, userId: owner } });
  });
  it("returns only display status, never credentials or registration secrets", async () => {
    mocks.profile.findMany.mockResolvedValue([profile()]);
    const status = await getConnectionStatus(owner);
    expect(status).toMatchObject({ sharing: true, connected: true, profileId });
    const text = JSON.stringify(status); for (const secret of ["local-access", "local-refresh", "local-id", "oaiapp_local", "verified-subject", "encryptedTokens"]) expect(text).not.toContain(secret);
  });
  it("serializes refresh, persists replacement and granted scope reduction before refusing inference", async () => {
    mocks.profile.findFirst.mockResolvedValue({ ...profile(), encryptedTokens: encrypt(JSON.stringify({ ...baseTokens(), expiresAt: Date.now() - 1 })) });
    mocks.tokenRequest.mockResolvedValue({ token_type: "Bearer", access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: "openid" });
    await expect(getPlanAccessToken(owner, profileId)).rejects.toThrow("chatgpt_plan_permission_required");
    expect(mocks.tx.$queryRaw).toHaveBeenCalled(); expect(mocks.verifyIdentity).not.toHaveBeenCalled();
    const saved = mocks.profile.update.mock.calls[0][0].data;
    expect(saved.scopes).toEqual(["openid"]); expect(JSON.parse(decrypt(saved.encryptedTokens)).refreshToken).toBe("new-refresh");
  });
  it("clears terminal refresh failures but retains registration mapping", async () => {
    mocks.profile.findFirst.mockResolvedValue({ ...profile(), encryptedTokens: encrypt(JSON.stringify({ ...baseTokens(), expiresAt: Date.now() - 1 })) });
    mocks.tokenRequest.mockRejectedValue(new ContentError("chatgpt_sign_in_required", 502));
    await expect(getPlanAccessToken(owner, profileId)).rejects.toThrow("chatgpt_sign_in_required");
    expect(mocks.profile.update).toHaveBeenCalledWith({ where: { id: profileId }, data: { encryptedTokens: null, scopes: [], expiresAt: null, epoch: { increment: 1 } } });
  });
  it("reflects terminal refresh in the current status response", async () => {
    const expired = { ...profile(), encryptedTokens: encrypt(JSON.stringify({ ...baseTokens(), expiresAt: Date.now() - 1 })) };
    mocks.profile.findMany.mockResolvedValue([expired]);
    mocks.profile.findFirst.mockResolvedValueOnce(expired).mockResolvedValueOnce({ ...expired, encryptedTokens: null, scopes: [] });
    mocks.tokenRequest.mockRejectedValue(new ContentError("chatgpt_sign_in_required", 502));
    await expect(getConnectionStatus(owner, true)).resolves.toMatchObject({ connected: false, sharing: false, modelError: "chatgpt_sign_in_required" });
  });
});
