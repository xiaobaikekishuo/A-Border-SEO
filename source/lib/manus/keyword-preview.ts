import type { ManusKeywordPreview } from "@prisma/client";
import { db } from "@/lib/db";
import { ContentError } from "@/lib/content-planner/http";
import { downloadResearchWorkbook } from "./client";
import { parseKeywordWorkbook, MAX_WORKBOOK_BYTES, KeywordWorkbookError, type ManusKeywordCandidate } from "./keyword-workbook";
import { taskOwner, userKey } from "./tasks";

export type PreviewParams = { siteId: string; taskId: string };
export async function previewOwner({ siteId, taskId }: PreviewParams) {
  const owner = await taskOwner(siteId);
  const task = await db.manusKeywordTask.findFirst({
    where: { id: taskId, ...owner }, select: { status: true, remoteId: true },
  });
  if (!task) throw new ContentError("task_not_found", 404);
  if (task.status !== "completed") throw new ContentError("task_not_completed", 409);
  return { ...owner, taskId, remoteId: task.remoteId };
}
type Owner = Awaited<ReturnType<typeof previewOwner>>;
const normalize = (query: string) => query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

function candidateTerms(rows: ManusKeywordCandidate[]) {
  const terms = new Map<string, string>();
  for (const row of rows) {
    for (const term of [row.keyword, row.alternateKeyword]) {
      if (term && !terms.has(normalize(term))) terms.set(normalize(term), term);
    }
  }
  return terms;
}

async function present(owner: Owner, preview: ManusKeywordPreview | null) {
  if (!preview) return { rows: [], revision: 0, source: null, filename: "", saved: [] };
  const rows = preview.rows as unknown as ManusKeywordCandidate[];
  const terms = candidateTerms(rows);
  const savedRows = await db.savedKeyword.findMany({ where: { siteId: owner.siteId }, select: { query: true } });
  const saved = [...new Set(savedRows.map(r => terms.get(normalize(r.query))).filter(Boolean))];
  return { rows, revision: preview.revision, source: preview.source, filename: preview.filename, saved };
}

export async function getPreview(owner: Owner) {
  return present(owner, await db.manusKeywordPreview.findUnique({ where: { taskId: owner.taskId } }));
}

async function readUpload(req: Request) {
  const encodedName = req.headers.get("x-workbook-name") || "keywords.xlsx";
  let filename: string;
  try { filename = decodeURIComponent(encodedName); } catch { throw new ContentError("invalid_workbook"); }
  if (filename.length > 255 || /[/\\\u0000-\u001f\u007f]/u.test(filename) || !/\.xlsx$/i.test(filename)) {
    throw new ContentError("unsupported_workbook", 415);
  }
  if (!req.body) throw new ContentError("invalid_workbook");
  if (Number(req.headers.get("content-length")) > MAX_WORKBOOK_BYTES) throw new ContentError("workbook_too_large", 413);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WORKBOOK_BYTES) { await reader.cancel(); throw new ContentError("workbook_too_large", 413); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return { filename, bytes: Buffer.concat(parts, size) };
}

export async function loadPreview(owner: Owner, req: Request) {
  const upload = req.headers.get("content-type")?.split(";")[0].trim() === "application/octet-stream";
  // Next's HTTP adapter can supply an empty stream for a browser POST with no payload.
  if (!upload && req.body) {
    const reader = req.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength) {
          await reader.cancel();
          throw new ContentError("unsupported_workbook", 415);
        }
      }
    } finally { reader.releaseLock(); }
  }
  if (!upload && !owner.remoteId) throw new ContentError("no_workbook", 404);
  const workbook = upload ? await readUpload(req) : await downloadResearchWorkbook(await userKey(owner.userId), owner.remoteId!);
  let rows: ManusKeywordCandidate[];
  try { rows = parseKeywordWorkbook(workbook.bytes, workbook.filename); }
  catch (error) {
    if (error instanceof KeywordWorkbookError) throw new ContentError(error.code, error.code === "workbook_too_large" ? 413 : 422);
    throw error;
  }
  const fields = { source: upload ? "upload" : "manus", filename: workbook.filename, rows: rows.map(row => ({ ...row })) };
  const preview = await db.manusKeywordPreview.upsert({
    where: { taskId: owner.taskId }, create: { taskId: owner.taskId, ...fields },
    update: { ...fields, revision: { increment: 1 } },
  });
  return present(owner, preview);
}

export async function saveSelection(owner: Owner, raw: unknown) {
  const { revision, keywords } = (raw ?? {}) as { revision?: unknown; keywords?: unknown };
  if (!Number.isSafeInteger(revision) || !Array.isArray(keywords) || !keywords.length) throw new ContentError("invalid_selection");
  if (keywords.length > 500) throw new ContentError("selection_too_large", 413);
  if (!keywords.every((item): item is string => typeof item === "string" && item.trim().length > 0)) throw new ContentError("invalid_selection");
  return db.$transaction(async tx => {
    // Serialize simultaneous selections from different research tasks for this site.
    await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id"=${owner.siteId} AND "userId"=${owner.userId} FOR UPDATE`;
    const [preview] = await tx.$queryRaw<Pick<ManusKeywordPreview, "revision" | "rows">[]>`SELECT "revision", "rows" FROM "ManusKeywordPreview" WHERE "taskId"=${owner.taskId} FOR SHARE`;
    if (!preview) throw new ContentError("no_preview", 409);
    if (preview.revision !== revision) throw new ContentError("preview_changed", 409);
    const terms = candidateTerms(preview.rows as unknown as ManusKeywordCandidate[]);
    const requested = [...new Set(keywords.map(normalize))];
    if (requested.some(term => !terms.has(term))) throw new ContentError("invalid_selection");
    const existing = await tx.savedKeyword.findMany({ where: { siteId: owner.siteId }, select: { query: true } });
    const saved = new Set(existing.map(row => normalize(row.query)));
    const data = requested.filter(t => !saved.has(t)).map(t => ({ siteId: owner.siteId, query: terms.get(t)! }));
    const added = data.length ? (await tx.savedKeyword.createMany({ data, skipDuplicates: true })).count : 0;
    return { added, skipped: requested.length - added };
  });
}
