import { articleReviewSchema } from "./article-review-schema";

export type OptimizationEvidence = {
  acceptedAt: string; sourceUrl: string; bodySource: string; crawlAt: string | null;
  links: { target: string; sourceSection: string; anchor: string; reason: string; status: "OBSERVED" | "NOT_OBSERVED" | "NOT_CHECKED" }[];
};
export function optimizationEvidence(value: unknown, sourceUrl: string | null, pages: Set<string>, links: Set<string>, crawlAt: Date | null): OptimizationEvidence | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const review = articleReviewSchema.shape.articles.element.safeParse(record.review);
  if (!review.success || typeof record.acceptedAt !== "string" || typeof record.sourceUrl !== "string" || sourceUrl !== record.sourceUrl) return null;
  const checked = !!crawlAt && crawlAt.getTime() > Date.parse(record.acceptedAt) && pages.has(sourceUrl);
  return { acceptedAt: record.acceptedAt, sourceUrl, bodySource: String(record.bodySource ?? "UNKNOWN"), crawlAt: crawlAt?.toISOString() ?? null,
    links: review.data.internalLinks.map(link => ({ ...link, status: !checked ? "NOT_CHECKED" : links.has(JSON.stringify([sourceUrl, link.target])) ? "OBSERVED" : "NOT_OBSERVED" })) };
}
