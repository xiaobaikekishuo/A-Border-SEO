import type { articleSearchEvidence } from "@/lib/content-planner/article-search-evidence";
import type { StructuredDataReport } from "@/lib/seo/structured-data";

export type DiagnosticSelection = {
  pageId?: string; url?: string; query?: string;
  opportunity?: "striking_distance" | "low_ctr" | "content_decay" | "cannibalization";
  crawlId?: string;
};
export type DiagnosticEvidence = {
  siteId: string;
  selection: DiagnosticSelection;
  limits?: { queryCandidates: number; auditIssues: number; bodyCharacters: number; bodyIsExcerpt: boolean; queryCandidatesAtLimit: boolean; auditIssuesAtLimit: boolean };
  pages: { id: string | null; url: string; title: string | null; hasBody: boolean }[];
  page: {
    id: string; url: string; title: string | null; description: string | null;
    statusCode: number; canonical: string | null; indexable: boolean;
    robotsMeta: string | null; noindexSource: string | null;
    body: string; bodySource: "CRAWL" | "NONE"; headings: string[];
  } | null;
  crawl: { id: string; finishedAt: string | null; sampleLimited: boolean } | null;
  issues: { type: string; severity: string; message: string; disposition: "observed" | "unverified" }[];
  searchEvidence: Awaited<ReturnType<typeof articleSearchEvidence>>;
  queryEvidence: { query: string; status: "UNKNOWN" | "REPORTED" | "NO_RECORDED_ROWS"; clicks: number | null; impressions: number | null; ctr: number | null; position: number | null } | null;
  schemaReport: StructuredDataReport | null;
};
