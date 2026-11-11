import type { DiagnosticSelection } from "@/lib/ai-workbench/diagnostic-types";

export function opportunityWorkbenchHref(siteId: string, selection: Pick<DiagnosticSelection, "url" | "query" | "opportunity">) {
  const params = new URLSearchParams();
  if (selection.url) params.set("url", selection.url);
  if (selection.query) params.set("query", selection.query);
  if (selection.opportunity) params.set("opportunity", selection.opportunity);
  return `/sites/${encodeURIComponent(siteId)}/assistant?${params}`;
}
