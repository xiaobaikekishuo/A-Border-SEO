import { randomUUID } from "node:crypto";
import type { ManusResearchTask as TaskRow } from "@prisma/client";
import { ContentError } from "@/lib/content-planner/http";
import { db } from "@/lib/db";
import { desktopMaintenanceActive } from "@/lib/desktop/maintenance";
import { RESEARCH_LANGUAGES, RESEARCH_LOCATIONS } from "@/lib/dataforseo/market";
import { readTrackingWorkspace } from "@/lib/geo/tracking";
import { normalizeDomain } from "@/lib/geo/visibility-rules";
import { managedAllows } from "@/lib/managed/policy";
import { createTemplateTask, ManusError, readTemplateTask } from "./client";
import { userKey, type ManusTaskStatus } from "./tasks";
import {
  isManusTemplate, parseTemplateInput, readTemplateResult, storedRows, TEMPLATE_LIMITS,
  type GeoSourcesInput, type LinkProspectsInput, type ManusTemplate, type TemplateInput, type TemplateRow,
} from "./templates";

/*
 * Manus research templates (lib/manus/templates.ts) for a site: the options
 * the forms start from, the saved tasks, a paid submission guarded like
 * keyword research (an explicit confirmation, a request id that makes a
 * retry replay the first submission, a reservation before the one paid
 * call), and refreshing a task's result from Manus.
 */

type Owner = { userId: string; siteId: string };

export type ResearchTask = {
  id: string;
  kind: ManusTemplate;
  requestId: string;
  input: TemplateInput;
  status: ManusTaskStatus;
  taskUrl: string | null;
  summary: string | null;
  rows: TemplateRow[];
  /** Whether Manus extracted the structured result: null until the task finished. */
  extracted: boolean | null;
  errorCode: string | null;
  refreshable: boolean;
  createdAt: string;
  updatedAt: string;
};
export type GeoGapOption = { domain: string; type: string; gapAnswers: number; answers: number; competitors: string[] };
export type TemplateOptions = {
  site: string;
  /** The research market, in words, as the task receives it. */
  market: string;
  /** GEO_SOURCES: the brand and competitors of prompt tracking, and its citation gaps. */
  brand: string | null;
  competitors: string[];
  gaps: GeoGapOption[];
  /** LINK_PROSPECTS: competitor domains from prompt tracking, as a starting point. */
  competitorDomains: string[];
};
export type ResearchTaskList = { connected: boolean; tasks: ResearchTask[]; nextCursor: string | null; options: TemplateOptions };

const PAGE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function publicTask(row: TaskRow): ResearchTask {
  // The app may have stopped between sending the request and saving its receipt: never create again for this id.
  const interrupted = row.status === "submitting" && Date.now() - row.createdAt.getTime() > 120_000;
  return {
    id: row.id, kind: row.kind as ManusTemplate, requestId: row.requestId, input: row.input as unknown as TemplateInput,
    status: interrupted ? "unknown" : row.status as ManusTaskStatus, taskUrl: row.taskUrl, summary: row.summary,
    rows: storedRows(row.kind, row.rows), extracted: row.extracted, errorCode: interrupted ? "submission_unknown" : row.errorCode,
    refreshable: !!row.remoteId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export function templateOf(value: unknown): ManusTemplate {
  if (!isManusTemplate(value)) throw new ContentError("unknown_template", 400);
  return value;
}

async function siteOf(owner: Owner) {
  const site = await db.site.findFirst({
    where: { id: owner.siteId, userId: owner.userId },
    select: { domain: true, researchLanguage: true, researchLocation: true },
  });
  if (!site) throw new ContentError("site_not_found", 404);
  return { ...site, host: normalizeDomain(site.domain) ?? site.domain.toLowerCase() };
}

function marketText(site: { researchLanguage: string; researchLocation: number }): string {
  const location = RESEARCH_LOCATIONS.find(l => l.value === site.researchLocation)?.en ?? `location ${site.researchLocation}`;
  const language = RESEARCH_LANGUAGES.find(l => l.value === site.researchLanguage)?.en ?? site.researchLanguage;
  return `${location}, ${language}`;
}

/** What the forms start from: the market, and for GEO sources the brand, competitors and citation gaps of prompt tracking. */
export async function templateOptions(owner: Owner): Promise<TemplateOptions> {
  const site = await siteOf(owner);
  const geo = await readTrackingWorkspace(db, owner.userId, owner.siteId);
  const brands = geo.settings?.brands;
  return {
    site: site.host,
    market: marketText(site),
    brand: brands?.own.name ?? null,
    competitors: brands?.competitors.map(c => c.name) ?? [],
    gaps: geo.gaps.slice(0, 30).map(g => ({ domain: g.domain, type: g.type, gapAnswers: g.gapAnswers, answers: g.answers, competitors: g.competitors })),
    competitorDomains: [...new Set(brands?.competitors.flatMap(c => c.domains) ?? [])].slice(0, TEMPLATE_LIMITS.prospectCompetitors),
  };
}

export async function researchList(owner: Owner, kind: ManusTemplate, cursor: string | null): Promise<ResearchTaskList> {
  const where = { ...owner, kind };
  if (cursor && !(await db.manusResearchTask.findFirst({ where: { ...where, id: cursor }, select: { id: true } }))) {
    throw new ContentError("invalid_cursor", 400);
  }
  const [rows, key, options] = await Promise.all([
    db.manusResearchTask.findMany({
      where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: PAGE + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    }),
    db.apiKey.findUnique({ where: { userId_provider: { userId: owner.userId, provider: "manus" } }, select: { id: true } }),
    cursor ? null : templateOptions(owner),
  ]);
  const tasks = rows.slice(0, PAGE).map(publicTask);
  return {
    connected: !!key, tasks, nextCursor: rows.length > PAGE ? tasks[PAGE - 1].id : null,
    options: options ?? { site: "", market: "", brand: null, competitors: [], gaps: [], competitorDomains: [] },
  };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** The task input from a form, built from the app's own data where it can be (the citation gaps). */
async function buildInput(owner: Owner, kind: ManusTemplate, body: Record<string, unknown>): Promise<TemplateInput> {
  const site = await siteOf(owner);
  const profile = body.profile === "standard" ? "standard" : "lite";
  const language = text(body.language);
  try {
    if (kind === "GEO_SOURCES") {
      const geo = await readTrackingWorkspace(db, owner.userId, owner.siteId);
      const brands = geo.settings?.brands;
      if (!brands) throw new ContentError("geo_not_set_up", 409);
      const prompts = new Map(geo.prompts.map(p => [p.id, p.text]));
      const chosen = [...new Set(list(body.domains))].slice(0, TEMPLATE_LIMITS.sources);
      const sources = chosen.flatMap(domain => {
        const gap = geo.gaps.find(g => g.domain === domain);
        return gap ? [{
          domain: gap.domain, type: gap.type, competitors: gap.competitors.slice(0, TEMPLATE_LIMITS.competitors),
          prompts: gap.promptIds.map(id => prompts.get(id)).filter((p): p is string => !!p).slice(0, 3).map(p => p.slice(0, 300)),
          urls: gap.urls.filter(u => /^https?:\/\//.test(u) && u.length <= 2048).slice(0, 3),
        }] : [];
      });
      if (!sources.length) throw new ContentError("no_sources", 400);
      return parseTemplateInput("GEO_SOURCES", {
        site: site.host, brand: brands.own.name, competitors: brands.competitors.map(c => c.name), market: marketText(site), language, profile, sources,
      } satisfies GeoSourcesInput);
    }
    const competitors = list(body.competitors).map(c => normalizeDomain(c));
    if (competitors.some(c => !c)) throw new ContentError("invalid_input", 400);
    return parseTemplateInput("LINK_PROSPECTS", {
      site: site.host, topic: text(body.topic), competitors: competitors as string[], audience: text(body.audience), language, profile,
    } satisfies LinkProspectsInput);
  } catch (error) {
    if (error instanceof ContentError) throw error;
    throw new ContentError("invalid_input", 400);
  }
}

/** What the person asked for: a retry with the same request id must ask for the same thing. */
function sameRequest(kind: ManusTemplate, a: TemplateInput, b: TemplateInput): boolean {
  const key = (input: TemplateInput) => "sources" in input
    ? JSON.stringify([kind, input.language, input.profile, input.sources.map(s => s.domain)])
    : JSON.stringify([kind, input.language, input.profile, input.topic, input.competitors, input.audience]);
  return key(a) === key(b);
}

export async function submitResearch(owner: Owner, kind: ManusTemplate, raw: unknown): Promise<ResearchTask> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ContentError("invalid_input");
  const body = raw as Record<string, unknown>;
  if (body.confirmed !== true) throw new ContentError("confirmation_required", 409);
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId)) throw new ContentError("invalid_request_id");
  const input = await buildInput(owner, kind, body);
  const receipt = { ...owner, requestId: body.requestId.toLowerCase() };
  const where = { userId_siteId_requestId: receipt };
  const replay = (row: TaskRow) => {
    if (row.kind !== kind || !sameRequest(kind, row.input as unknown as TemplateInput, input)) throw new ContentError("request_id_conflict", 409);
    return publicTask(row);
  };
  const prior = await db.manusResearchTask.findUnique({ where });
  if (prior) return replay(prior);
  const key = await userKey(owner.userId);
  if (JSON.stringify(input).includes(key)) throw new ContentError("invalid_input");
  if (desktopMaintenanceActive() || !managedAllows("manus")) throw new ContentError("workspace_maintenance", 503);
  const id = randomUUID();
  // A durable reservation precedes the only paid call; concurrent submissions replay the winner.
  const claim = await db.manusResearchTask.createMany({
    data: { id, ...receipt, kind, input: { ...input }, status: "submitting" }, skipDuplicates: true,
  });
  if (!claim.count) return replay(await db.manusResearchTask.findUniqueOrThrow({ where }));
  if (!managedAllows("manus")) {
    return publicTask(await db.manusResearchTask.update({ where: { id, ...owner }, data: { status: "failed", errorCode: "workspace_maintenance" } }));
  }
  let remote;
  try {
    remote = await createTemplateTask(key, kind, input, input.profile);
  } catch (err) {
    const ambiguous = !(err instanceof ManusError) || err.ambiguousSubmission;
    return publicTask(await db.manusResearchTask.update({
      where: { id, ...owner },
      data: { status: ambiguous ? "unknown" : "failed", errorCode: err instanceof ManusError ? err.code : "submission_unknown" },
    }));
  }
  return publicTask(await db.manusResearchTask.update({
    where: { id, ...owner },
    data: { status: "pending", remoteId: remote.remoteId, taskUrl: remote.taskUrl },
  }));
}

export async function refreshResearch(owner: Owner, id: string): Promise<ResearchTask> {
  const where = { id, ...owner };
  const row = await db.manusResearchTask.findFirst({ where });
  if (!row) throw new ContentError("task_not_found", 404);
  if (!row.remoteId) return publicTask(row);
  const kind = templateOf(row.kind);
  const site = await siteOf(owner);
  const latest = await readTemplateTask(await userKey(owner.userId), row.remoteId);
  const result = latest.status === "completed" ? readTemplateResult(kind, latest.structured, site.host) : null;
  const finished = latest.status === "completed" && latest.structured !== null;
  // A concurrent refresh may already have stored a newer observation.
  await db.manusResearchTask.updateMany({
    where: { ...where, revision: row.revision },
    data: {
      status: latest.status, taskUrl: latest.taskUrl, summary: result?.summary || latest.summary || null,
      ...(result ? { rows: result.rows } : {}),
      extracted: finished ? !!result : null,
      errorCode: finished && !result ? "no_structured_result" : null,
      revision: { increment: 1 },
    },
  });
  return publicTask(await db.manusResearchTask.findFirstOrThrow({ where }));
}
