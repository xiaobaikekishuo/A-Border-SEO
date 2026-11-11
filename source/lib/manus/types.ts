export type ManusResearchInput = {
  seeds: string[];
  audience: string;
  language: string;
};

export type ManusResearchResult = {
  status: "running" | "waiting" | "completed" | "failed";
  taskUrl: string;
  summary: string;
  files: Array<{ name: string; url: string }>;
};

export type ManusErrorCode =
  | "invalid_input" | "unauthorized" | "forbidden" | "rate_limited"
  | "not_found" | "insufficient_credits" | "upstream" | "network" | "invalid_response"
  | "no_workbook" | "workbook_too_large" | "no_report" | "report_too_large";

export class ManusError extends Error {
  constructor(readonly code: ManusErrorCode, readonly ambiguousSubmission = false) {
    super(code);
    this.name = "ManusError";
  }
}
