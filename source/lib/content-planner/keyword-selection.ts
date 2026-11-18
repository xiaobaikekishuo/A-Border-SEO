import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { keywordIdeaSchema } from "@/lib/ai-workbench/schema";

export const keywordSelectionSchema = z.object({
  jobId: z.string().min(1).max(200),
  indexes: z.array(z.number().int().min(0).max(23)).min(1).max(24)
    .refine(indexes => new Set(indexes).size === indexes.length),
}).strict();
export type KeywordSelection = z.infer<typeof keywordSelectionSchema>;
export const researchReferenceSchema = z.object({ research: z.object({ reference: keywordSelectionSchema }) });
const candidatesSchema = z.object({ keywordIdeas: z.array(keywordIdeaSchema).min(1).max(24) });
const selectedIdeaSchema = keywordIdeaSchema.omit({ rationale: true });
export const savedResearchSchema = z.object({
  reference: keywordSelectionSchema,
  ideas: z.array(selectedIdeaSchema).min(1).max(24),
});
export type ReviewedKeywordSelection = z.infer<typeof savedResearchSchema>;

export function parseKeywordSelection(jobId: unknown, indexes: unknown) {
  if (typeof indexes !== "string" || indexes.length > 71 || !/^\d{1,2}(,\d{1,2})*$/.test(indexes)) return null;
  return keywordSelectionSchema.safeParse({ jobId, indexes: indexes.split(",").map(Number) }).data ?? null;
}

export async function reviewedKeywords(db: Pick<Prisma.TransactionClient, "aiWorkbenchJob">, siteId: string,
  reference: KeywordSelection): Promise<ReviewedKeywordSelection | null> {
  const job = await db.aiWorkbenchJob.findFirst({
    where: { id: reference.jobId, siteId, kind: "KEYWORD_RESEARCH", status: "SUCCEEDED" }, select: { result: true },
  });
  const result = candidatesSchema.safeParse(job?.result).data;
  if (!result || reference.indexes.some(index => !result.keywordIdeas[index])) return null;
  const ideas = reference.indexes.map(index => {
    const { keyword, intent, funnel, cluster, angle } = result.keywordIdeas[index];
    return { keyword, intent, funnel, cluster, angle };
  });
  return { reference, ideas };
}
