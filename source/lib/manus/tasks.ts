import { randomUUID } from "node:crypto";
import type { ManusKeywordTask as TaskRow } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { ContentError } from "@/lib/content-planner/http";
import { decrypt } from "@/lib/encryption";
import { createResearch, readResearch, normalizeResearchInput, ManusError, type ManusResearchInput } from "./client";

export type ManusTaskStatus = "submitting" | "unknown" | "pending" | "running" | "waiting" | "completed" | "failed";
export type ManusKeywordTask = {
  id: string;
  requestId: string;
  input: ManusResearchInput;
  status: ManusTaskStatus;
  taskUrl: string | null;
  result: string | null;
  files: { name: string; url: string }[];
  errorCode: string | null;
  refreshable: boolean;
  createdAt: string;
  updatedAt: string;
};
export type ManusTaskList = { connected: boolean; tasks: ManusKeywordTask[]; nextCursor: string | null };
type Owner = { userId: string; siteId: string };

export async function taskOwner(siteId: string): Promise<Owner> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new ContentError("sign_in_required", 401);
  const site = await db.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) throw new ContentError("site_not_found", 404);
  return { userId, siteId };
}

function publicTask(row: TaskRow): ManusKeywordTask {
  // If the app stopped between sending the request and saving its receipt,
  // the task might exist at Manus. Never dispatch another create for this ID.
  const interrupted = row.status === "submitting" && Date.now() - row.createdAt.getTime() > 120_000;
  return {
    id: row.id, requestId: row.requestId,
    input: row.input as unknown as ManusResearchInput,
    status: interrupted ? "unknown" : row.status as ManusTaskStatus,
    result: row.result, files: row.files as ManusKeywordTask["files"], taskUrl: row.taskUrl,
    errorCode: interrupted ? "submission_unknown" : row.errorCode,
    refreshable: !!row.remoteId,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export async function userKey(userId: string): Promise<string> {
  const row = await db.apiKey.findUnique({
    where: { userId_provider: { userId, provider: "manus" } },
    select: { encryptedPassword: true },
  });
  if (!row) throw new ContentError("missing_key", 409);
  try { return decrypt(row.encryptedPassword); }
  catch { throw new ContentError("unreadable_key", 409); }
}

export async function taskList(owner: Owner, cursor: string | null): Promise<ManusTaskList> {
  if (cursor && !(await db.manusKeywordTask.findFirst({ where: { ...owner, id: cursor }, select: { id: true } }))) {
    throw new ContentError("invalid_cursor", 400);
  }
  const [rows, key] = await Promise.all([
    db.manusKeywordTask.findMany({
      where: owner, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    }),
    db.apiKey.findUnique({ where: { userId_provider: { userId: owner.userId, provider: "manus" } }, select: { id: true } }),
  ]);
  const tasks = rows.slice(0, 20).map(publicTask);
  return { tasks, connected: !!key, nextCursor: rows.length > 20 ? tasks[19].id : null };
}

export async function submitTask(owner: Owner, raw: unknown): Promise<ManusKeywordTask> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ContentError("invalid_input");
  const body = raw as Record<string, unknown>;
  if (body.confirmed !== true) throw new ContentError("confirmation_required", 409);
  if (typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) {
    throw new ContentError("invalid_request_id");
  }
  const input = normalizeResearchInput({ seeds: body.seeds, audience: body.audience, language: body.language });
  const receipt = { ...owner, requestId: body.requestId.toLowerCase() };
  const where = { userId_siteId_requestId: receipt };
  function replay(row: TaskRow) {
    const task = publicTask(row);
    const saved = task.input;
    if (saved.audience !== input.audience || saved.language !== input.language || JSON.stringify(saved.seeds) !== JSON.stringify(input.seeds)) {
      throw new ContentError("request_id_conflict", 409);
    }
    return task;
  }
  const prior = await db.manusKeywordTask.findUnique({ where });
  if (prior) return replay(prior);
  const key = await userKey(owner.userId);
  if ([...input.seeds, input.audience, input.language].some(value => value.includes(key))) {
    throw new ContentError("invalid_input");
  }
  const id = randomUUID();
  // A durable reservation precedes the only paid call. ON CONFLICT DO NOTHING
  // makes concurrent browser submissions replay the winner's local receipt.
  const claim = await db.manusKeywordTask.createMany({
    data: { id, ...receipt, input: { ...input }, status: "submitting" }, skipDuplicates: true,
  });
  if (!claim.count) return replay(await db.manusKeywordTask.findUniqueOrThrow({ where }));
  let remote;
  try {
    remote = await createResearch(key, input);
  } catch (err) {
    const ambiguous = !(err instanceof ManusError) || err.ambiguousSubmission;
    return publicTask(await db.manusKeywordTask.update({
      where: { id, ...owner },
      data: { status: ambiguous ? "unknown" : "failed", errorCode: err instanceof ManusError ? err.code : "submission_unknown" },
    }));
  }
  return publicTask(await db.manusKeywordTask.update({
    where: { id, ...owner },
    data: { status: "pending", remoteId: remote.remoteId, taskUrl: remote.taskUrl },
  }));
}

export async function refreshTask(owner: Owner, id: string): Promise<ManusKeywordTask> {
  const where = { id, ...owner };
  const row = await db.manusKeywordTask.findFirst({ where });
  if (!row) throw new ContentError("task_not_found", 404);
  if (!row.remoteId) return publicTask(row);
  const latest = await readResearch(await userKey(owner.userId), row.remoteId);
  // A concurrent refresh may already have stored a newer observation.
  await db.manusKeywordTask.updateMany({
    where: { ...where, revision: row.revision },
    data: { status: latest.status, result: latest.summary || null, taskUrl: latest.taskUrl,
      files: latest.files.map(({ name, url }) => ({ name, url })), errorCode: null, revision: { increment: 1 } },
  });
  return publicTask(await db.manusKeywordTask.findFirstOrThrow({ where }));
}

export function taskResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function taskFailure(error: unknown) {
  if (error instanceof ContentError) return taskResponse({ error: error.message }, error.status);
  if (error instanceof ManusError) {
    const code = error.code;
    if (code === "no_workbook" || code === "no_report") return taskResponse({ error: code }, 404);
    if (code === "workbook_too_large" || code === "report_too_large") return taskResponse({ error: code }, 413);
    return taskResponse({ error: code }, code === "invalid_input" ? 400 : 502);
  }
  return taskResponse({ error: "internal_error" }, 500);
}
