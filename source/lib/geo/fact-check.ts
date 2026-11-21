/*
 * The brand fact card: facts about the brand an AI answer should get right
 * (founded in, headquarters, price from, warranty). For each answer the card
 * gives a first pass for the reviewer, who makes the call:
 *
 *   STATED  the answer contains the fact's value
 *   CHECK   the answer talks about the fact (its label appears) without the
 *           value: it may state something else, so read it
 *   ABSENT  neither appears
 *
 * Matching is literal after normalization (case, full-width forms, thousands
 * separators, spacing). "|" separates alternatives in a label or a value:
 * "founded|成立" and "2015|二〇一五". It cannot tell a wrong figure from a
 * paraphrase, which is why the verdict stays with the reviewer.
 */

import { WORD_CHAR } from "./visibility-rules";

export type BrandFact = { label: string; value: string };
export type FactStatus = "STATED" | "CHECK" | "ABSENT";
export type FactHint = BrandFact & { status: FactStatus };

export const FACT_LIMITS = { facts: 20, label: 60, value: 300 } as const;

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase()
    .replace(/(\d)[,，](?=\d{3}(?!\d))/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function alternatives(value: string): string[] {
  return value.split("|").map(normalize).filter(Boolean);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `needle` occurs in `text`. Latin words and numbers must stand on
 * their own ("15" is not found in "2015"), though CJK text may touch them
 * ("成立于2015年").
 */
function contains(text: string, needle: string): boolean {
  if (CJK.test(needle)) return text.includes(needle);
  const body = escapeRegex(needle).replace(/ /g, "\\s+");
  return new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, "u").test(text);
}

export function factHints(text: string, facts: readonly BrandFact[]): FactHint[] {
  const body = normalize(text);
  return facts.map(fact => {
    if (alternatives(fact.value).some(value => contains(body, value))) return { ...fact, status: "STATED" };
    if (alternatives(fact.label).some(label => contains(body, label))) return { ...fact, status: "CHECK" };
    return { ...fact, status: "ABSENT" };
  });
}

/** Facts as stored, read defensively. */
export function storedFacts(value: unknown): BrandFact[] {
  if (!Array.isArray(value)) return [];
  const out: BrandFact[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { label, value: fact } = item as { label?: unknown; value?: unknown };
    if (typeof label !== "string" || typeof fact !== "string" || !label.trim() || !fact.trim()) continue;
    out.push({ label: label.trim().slice(0, FACT_LIMITS.label), value: fact.trim().slice(0, FACT_LIMITS.value) });
    if (out.length >= FACT_LIMITS.facts) break;
  }
  return out;
}
