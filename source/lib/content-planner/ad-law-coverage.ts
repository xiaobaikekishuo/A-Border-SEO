/*
 * Which ad-law candidates (lib/content-planner/review-quality.ts) the model
 * judged. Free of imports: the review checklist in the browser uses it too.
 */

type Candidate = { term: string; context: string };
type Judged = { term: string; quote: string };

const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * The candidates no judgement covers. A judgement covers a candidate of its
 * term when its quote and the candidate's context contain one another; a
 * quote too short to tell where it stands, or matching no context, covers
 * one candidate of its term. One verdict on 第一 therefore does not clear a
 * second 第一 elsewhere in the article.
 */
export function unjudgedAdLaw<T extends Candidate>(candidates: readonly T[], judged: readonly Judged[]): T[] {
  const locates = (entry: Judged) => normalize(entry.quote).length >= entry.term.length + 4;
  const covers = (entry: Judged, candidate: Candidate) => {
    if (entry.term !== candidate.term || !locates(entry)) return false;
    const quote = normalize(entry.quote);
    const context = normalize(candidate.context);
    return context.includes(quote) || quote.includes(context);
  };
  const spare = new Map<string, number>();
  for (const entry of judged) {
    if (!candidates.some(candidate => covers(entry, candidate))) spare.set(entry.term, (spare.get(entry.term) ?? 0) + 1);
  }
  return candidates.filter(candidate => {
    if (judged.some(entry => covers(entry, candidate))) return false;
    const left = spare.get(candidate.term) ?? 0;
    if (!left) return true;
    spare.set(candidate.term, left - 1);
    return false;
  });
}
