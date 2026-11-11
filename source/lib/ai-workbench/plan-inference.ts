import { openaiFetch } from "@/lib/chatgpt-connection/openai-fetch";
import { z } from "zod";
import { db } from "@/lib/db";
import { assertPlanConnection, getPlanAccessToken, listPlanModels } from "@/lib/chatgpt-connection/service";
import { ContentError } from "@/lib/content-planner/http";
import { RUN_TIMEOUT_MS } from "@/lib/content-planner/data";
import { workbenchRequestSchema, generationSchemaFor } from "./schema";
import { assertKeywordRequest } from "./keyword-research";
import { assertResearchRequest } from "./research-analysis";
import { buildWorkbenchPrompt, runWorkbenchLease } from "./worker";
import { planError, planRequest, readPlanResponse } from "./plan-response";

const requestSchema = z.object({ jobId: z.string().regex(/^aw_[a-zA-Z0-9_-]{1,90}$/), leaseToken: z.string().min(16).max(200) }).strict();
export async function runPlanInference(raw: unknown, requestSignal: AbortSignal) {
  const input = requestSchema.parse(raw);
  const leaseWhere = () => ({ id: input.jobId, status: "RUNNING" as const, leaseToken: input.leaseToken,
    leaseExpiresAt: { gt: new Date() }, startedAt: { gt: new Date(Date.now() - RUN_TIMEOUT_MS) } });
  const job = await db.aiWorkbenchJob.findFirst({ where: leaseWhere(), include: { site: { select: { userId: true } } } });
  if (!job) throw new ContentError("Job lease is no longer valid", 409);
  const request = workbenchRequestSchema.parse(job.request);
  assertKeywordRequest(request);
  assertResearchRequest(request);
  if (request.provider !== "CHATGPT_APP" || !request.profileId || !request.model || !request.planOnlyConfirmed || request.connectionEpoch === undefined) throw new ContentError("This job does not use a confirmed ChatGPT app connection", 409);
  // The unique row is consumed before any inference. Duplicate requests never generate twice.
  const claimed = await db.chatGptInference.createMany({ data: [{ jobId: job.id }], skipDuplicates: true });
  if (!claimed.count) throw new ContentError("This task has already started an inference request", 409);
  const abort = new AbortController();
  const signal = AbortSignal.any([requestSignal, abort.signal, AbortSignal.timeout(510000)]);
  const userId = job.site.userId; const profileId = request.profileId;
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return; checking = true;
    try {
      if (!await db.aiWorkbenchJob.findFirst({ where: leaseWhere(), select: { id: true } })) throw new Error("lease_ended");
      await assertPlanConnection(userId, profileId, request.connectionEpoch);
    } catch { abort.abort(); } finally { checking = false; }
  }, 5000);
  try {
    const token = await getPlanAccessToken(userId, profileId, request.connectionEpoch);
    const models = await listPlanModels(token);
    if (!models.some(model => model.slug === request.model)) throw new ContentError("Selected model is not in this ChatGPT account's current model list. Refresh models and start a new task.", 409);
    await assertPlanConnection(userId, profileId, request.connectionEpoch);
    signal.throwIfAborted();
    const response = await openaiFetch("https://api.openai.com/v1/responses", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, redirect: "error", cache: "no-store", signal,
      body: JSON.stringify(planRequest(request.model, buildWorkbenchPrompt(request, job.context), z.toJSONSchema(generationSchemaFor(request.kind), { target: "draft-7" }))),
    });
    const result = await readPlanResponse(response, signal, async usage => {
      // Usage belongs to this single inference, even if its draft later fails validation
      // or the user canceled. No status, draft, connection or lease is changed here.
      await db.aiWorkbenchJob.updateMany({ where: { id: job.id, siteId: job.siteId }, data: { usage } });
    });
    await assertPlanConnection(userId, profileId, request.connectionEpoch);
    await runWorkbenchLease(db, { action: "complete", ...input, result }, new Date());
    return { ok: true };
  } catch (error) {
    const message = error instanceof ContentError ? error.message : planError(null).message;
    // Canceled/expired jobs cannot be overwritten by late output or errors.
    await runWorkbenchLease(db, { action: "fail", ...input, error: message }, new Date()).catch(() => {});
    return { ok: false };
  } finally { clearInterval(timer); abort.abort(); }
}
