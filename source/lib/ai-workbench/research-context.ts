import { z } from "zod";
import { ContentError } from "@/lib/content-planner/http";
import type { articleSearchEvidence } from "@/lib/content-planner/article-search-evidence";
import { hostedMode } from "@/lib/hosted/control";
import { generationSchemaFor, type WorkbenchRequest } from "./schema";

export function assertResearchProvider(provider: WorkbenchRequest["provider"]) {
  if (hostedMode()) {
    if (provider !== "CODEX_LOCAL") throw new ContentError("Open the desktop app and sign in to its local Codex worker for research", 409);
  } else if (provider !== "CHATGPT_APP") {
    throw new ContentError("Research requires a connected ChatGPT app account", 409);
  }
}

export function sampleResearchRows<T>(rows: T[], divisor: number) {
  return rows.slice(0, Math.ceil(rows.length / divisor));
}

export function sampleResearchSearch(search: Awaited<ReturnType<typeof articleSearchEvidence>>, urls: Set<string>, divisor: number) {
  return { ...search, pages: sampleResearchRows(search.pages.filter(row => urls.has(row.url)), divisor)
    .map(page => ({ ...page, queries: sampleResearchRows(page.queries, divisor) })) };
}

export function fitResearchContext<T>(input: WorkbenchRequest, context: T, prompt: (input: WorkbenchRequest, context: T) => string,
  sample: (divisor: number) => T) {
  if (input.provider === "CHATGPT_APP") {
    if (JSON.stringify(context).length > 140000) throw new ContentError("Research evidence is too large. Reduce the research sample.");
    return context;
  }
  // Released workers check the length of the serialized claim. Reserve space for the ID, lease and protocol fields.
  const schemaLength = JSON.stringify(z.toJSONSchema(generationSchemaFor(input.kind), { target: "draft-7" })).length;
  const promptBudget = 65536 - 512 - schemaLength;
  for (const divisor of [1, 2, 4, 8, 16, 32, 64, Infinity]) {
    const bounded = divisor === 1 ? context : sample(divisor);
    if (JSON.stringify(prompt(input, bounded)).length <= promptBudget) return bounded;
  }
  throw new ContentError("Research evidence is too large. Shorten your research instructions.");
}
