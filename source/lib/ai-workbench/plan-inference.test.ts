import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, lazyDb, type TestDb } from "@/lib/testing/pglite";

const holder = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("@/lib/db", async () => ({ db: (await import("@/lib/testing/pglite")).lazyDb(holder) }));
const auth = vi.hoisted(() => ({ assertPlanConnection: vi.fn(), getPlanAccessToken: vi.fn(), listPlanModels: vi.fn() }));
vi.mock("@/lib/chatgpt-connection/service", () => auth);
import { runPlanInference } from "./plan-inference";
import { runWorkerAction } from "@/lib/content-planner/worker";

let database: TestDb; const db = lazyDb(holder); const fetchMock = vi.fn();
const result = { title: "Draft", summary: "A review draft", contentMarkdown: "# Draft\nReview the facts.", metaTitle: "Draft", metaDescription: "Draft description", changeNotes: [], factChecks: ["Review before publishing"], internalLinks: [] };
const input = { jobId: "aw_plan_inference", leaseToken: "test_lease_token_123456789" };
function completeResponse(usage?: unknown, output = result) {
  return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
}
beforeAll(async () => {
  database = await createTestDb(); holder.db = database.db;
  await db.user.create({ data: { id: "plan-owner", email: "plan@example.test" } });
  await db.site.create({ data: { id: "plan-site", userId: "plan-owner", domain: "plan.example.test" } });
}, 120000);
afterAll(async () => { vi.unstubAllGlobals(); await database?.close(); });
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset().mockImplementation(async () => completeResponse());
  auth.assertPlanConnection.mockReset().mockResolvedValue({ epoch: 1 });
  auth.getPlanAccessToken.mockReset().mockResolvedValue("test-oauth-credential-never-returned");
  auth.listPlanModels.mockReset().mockResolvedValue([{ slug: "account-model", displayName: "Account model" }]);
  await db.chatGptInference.deleteMany(); await db.aiWorkbenchJob.deleteMany();
  const now = new Date();
  await db.aiWorkbenchJob.create({ data: { id: input.jobId, siteId: "plan-site", kind: "WRITE_ARTICLE", title: "Draft", request: { provider: "CHATGPT_APP", profileId: "owned-profile", model: "account-model", kind: "WRITE_ARTICLE", title: "Draft", planOnlyConfirmed: true, connectionEpoch: 1 }, context: { allowedInternalLinks: [] }, status: "RUNNING", leaseToken: input.leaseToken, leaseExpiresAt: new Date(now.getTime() + 120000), startedAt: now } });
});
describe("pinned ChatGPT app workbench inference", () => {
  it.each(["DOMAIN_ANALYSIS", "BACKLINK_ANALYSIS"] as const)("runs %s once through the owned account with report output and usage", async kind => {
    const output = { ...result, metaTitle: "", metaDescription: "", paragraphEdits: [] };
    await db.aiWorkbenchJob.update({ where: { id: input.jobId }, data: { kind, request: { provider: "CHATGPT_APP", profileId: "owned-profile", model: "account-model", kind, title: "Research", researchAnalysis: { targetMarket: "US readers" }, planOnlyConfirmed: true, connectionEpoch: 1 } } });
    fetchMock.mockResolvedValue(completeResponse({ input_tokens: 80, output_tokens: 40, total_tokens: 120 }, output));
    const results = await Promise.allSettled([runPlanInference(input, new AbortController().signal), runPlanInference(input, new AbortController().signal)]);
    expect(results.some(item => item.status === "fulfilled" && item.value.ok)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, posted] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const payload = JSON.parse(posted.body);
    expect(payload).toMatchObject({ model: "account-model", store: false, stream: true });
    expect(JSON.stringify(payload)).toContain(`Task: ${kind}`);
    expect(JSON.stringify(payload)).toContain("not sessions, visits, market search volume");
    expect(auth.getPlanAccessToken).toHaveBeenCalledWith("plan-owner", "owned-profile", 1);
    expect(await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: input.jobId } })).toMatchObject({ status: "SUCCEEDED", result: output, usage: { source: "CHATGPT_RESPONSE", totalTokens: 120 } });
    expect(await db.chatGptInference.count()).toBe(1);
  });
  it.each(["DOMAIN_ANALYSIS", "BACKLINK_ANALYSIS"] as const)("stops %s on account limit with no retry or billing fallback", async kind => {
    await db.aiWorkbenchJob.update({ where: { id: input.jobId }, data: { kind, request: { provider: "CHATGPT_APP", profileId: "owned-profile", model: "account-model", kind, title: "Research", researchAnalysis: { targetMarket: "US readers" }, planOnlyConfirmed: true, connectionEpoch: 1 } } });
    fetchMock.mockResolvedValue(new Response("Private upstream diagnostic", { status: 429 }));
    expect(await runPlanInference(input, new AbortController().signal)).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: input.jobId } })).status).toBe("FAILED");
    await expect(runPlanInference(input, new AbortController().signal)).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.getPlanAccessToken).toHaveBeenCalledTimes(1);
  });
  it("runs keyword research through the same pinned account and telemetry without automatic saving", async () => {
    const output = { ...result, metaTitle: "", metaDescription: "", paragraphEdits: [], keywordIdeas: [{ keyword: "Account region settings", intent: "INFORMATIONAL", funnel: "TOFU", cluster: "Account regions", angle: "Explain region settings", rationale: "Inferred idea that needs demand verification" }] };
    await db.aiWorkbenchJob.update({ where: { id: input.jobId }, data: { kind: "KEYWORD_RESEARCH", request: { provider: "CHATGPT_APP", profileId: "owned-profile", model: "account-model", kind: "KEYWORD_RESEARCH", title: "Account regions", keyword: "Account regions", keywordResearch: { count: 12, targetMarket: "United States" }, planOnlyConfirmed: true, connectionEpoch: 1 } } });
    fetchMock.mockResolvedValue(completeResponse({ input_tokens: 50, output_tokens: 20, total_tokens: 70 }, output));
    expect(await runPlanInference(input, new AbortController().signal)).toEqual({ ok: true });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(JSON.stringify(payload)).toContain("keywordIdeas");
    expect(JSON.stringify(payload)).toContain("Never invent or estimate search volume");
    expect(auth.getPlanAccessToken).toHaveBeenCalledWith("plan-owner", "owned-profile", 1);
    expect(await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: input.jobId } })).toMatchObject({ status: "SUCCEEDED", result: output, usage: { totalTokens: 70 } });
    expect(await db.savedKeyword.count({ where: { siteId: "plan-site" } })).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("stores provider telemetry separately from the draft and keeps missing history unknown", async () => {
    fetchMock.mockResolvedValue(completeResponse({ input_tokens: 100, output_tokens: 20, total_tokens: 120 }));
    expect(await runPlanInference(input, new AbortController().signal)).toEqual({ ok: true });
    const job = await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: input.jobId } });
    expect(job.usage).toEqual({ source: "CHATGPT_RESPONSE", inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: null, reasoningTokens: null });
    expect(job.result).toEqual(result);
  });
  it("keeps consumed usage even when the completed draft fails validation", async () => {
    fetchMock.mockResolvedValue(completeResponse({ input_tokens: 20, output_tokens: 10, total_tokens: 30 }, { ...result, contentMarkdown: "[invented](https://unknown.example.test/)" }));
    expect(await runPlanInference(input, new AbortController().signal)).toEqual({ ok: false });
    expect(await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: input.jobId } })).toMatchObject({ status: "FAILED", result: null, usage: { totalTokens: 30 } });
  });
  it("retains usage metadata from a failed upstream response", async () => {
    fetchMock.mockResolvedValue(new Response(`data: ${JSON.stringify({ type: "response.failed", response: { usage: { input_tokens: 20, output_tokens: 0, total_tokens: 20 }, error: { code: "subscription_sharing_usage_limit_exceeded" } } })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    expect(await runPlanInference(input, new AbortController().signal)).toEqual({ ok: false });
    expect(await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: input.jobId } })).toMatchObject({ status: "FAILED", result: null, usage: { totalTokens: 20 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("records late real usage without reviving a canceled draft", async () => {
    fetchMock.mockImplementation(async () => { await db.aiWorkbenchJob.update({ where: { id: input.jobId }, data: { status: "FAILED", error: "canceled", leaseToken: null, leaseExpiresAt: null } }); return completeResponse({ input_tokens: 40, output_tokens: 10, total_tokens: 50 }); });
    expect(await runPlanInference(input, new AbortController().signal)).toEqual({ ok: false });
    expect(await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: input.jobId } })).toMatchObject({ status: "FAILED", error: "canceled", result: null, usage: { totalTokens: 50 } });
  });
  it("uses the selected owner's OAuth connection, persists validated output and exposes no token", async () => {
    expect(await runPlanInference(input, new AbortController().signal)).toEqual({ ok: true });
    expect(auth.getPlanAccessToken).toHaveBeenCalledWith("plan-owner", "owned-profile", 1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses"); expect(request.redirect).toBe("error");
    expect(JSON.parse(request.body)).toMatchObject({ model: "account-model", store: false, stream: true });
    const job = await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: input.jobId } });
    expect(job.status).toBe("SUCCEEDED"); expect(job.result).toEqual(result); expect(JSON.stringify(job)).not.toContain("test-oauth-credential");
  });
  it("consumes the inference marker once even with concurrent repeat requests", async () => {
    await Promise.allSettled([runPlanInference(input, new AbortController().signal), runPlanInference(input, new AbortController().signal)]);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(await db.chatGptInference.count()).toBe(1);
  });
  it("rejects invalid lease and CLI jobs before using account credentials", async () => {
    await expect(runPlanInference({ ...input, leaseToken: "invalid_lease_123456" }, new AbortController().signal)).rejects.toMatchObject({ status: 409 });
    await db.aiWorkbenchJob.update({ where: { id: input.jobId }, data: { request: { kind: "WRITE_ARTICLE", title: "CLI draft" } } });
    await expect(runPlanInference(input, new AbortController().signal)).rejects.toThrow("does not use");
    expect(auth.getPlanAccessToken).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("stops on quota failure with no retry or account fallback", async () => {
    fetchMock.mockResolvedValue(new Response("private diagnostic text", { status: 429 }));
    expect(await runPlanInference(input, new AbortController().signal)).toEqual({ ok: false });
    const job = await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: input.jobId } });
    expect(job.status).toBe("FAILED"); expect(job.error).toContain("Manage usage"); expect(job.error).not.toContain("private diagnostic"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("requires current model access and never substitutes another model", async () => {
    auth.listPlanModels.mockResolvedValue([{ slug: "other-model", displayName: "Other" }]);
    expect(await runPlanInference(input, new AbortController().signal)).toEqual({ ok: false }); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not overwrite cancellation with late completed output", async () => {
    fetchMock.mockImplementation(async () => { await db.aiWorkbenchJob.update({ where: { id: input.jobId }, data: { status: "FAILED", error: "canceled", leaseToken: null, leaseExpiresAt: null } }); return completeResponse(); });
    expect(await runPlanInference(input, new AbortController().signal)).toEqual({ ok: false });
    expect(await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: input.jobId } })).toMatchObject({ status: "FAILED", error: "canceled", result: null });
  });
  it("old helpers receive no executable CLI prompt for an app job", async () => {
    await db.aiWorkbenchJob.update({ where: { id: input.jobId }, data: { status: "QUEUED", leaseToken: null, leaseExpiresAt: null, startedAt: null } });
    const claim = await runWorkerAction(db, { action: "claim", workerId: "legacy-helper" });
    expect(claim).toMatchObject({ job: { provider: "CHATGPT_APP", prompt: "", outputSchema: {} } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
