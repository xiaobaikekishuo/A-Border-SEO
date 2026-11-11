/*
 * Prompt tracking analysis: whether an AI answer mentions the site's brand,
 * cites its pages, and how it compares with the competitors the user lists.
 * Pure functions over the answer text and the cited URLs; lib/geo/tracking.ts
 * stores the results.
 *
 * Mentions are case-insensitive. A Latin-script name must stand as a word
 * ("Kammak" does not match inside "Kammakhome"); a name in Chinese, Japanese
 * or Korean script matches anywhere. Citations belong to a brand when the
 * cited host is one of its domains or a subdomain of one.
 */

export type BrandEntity = { name: string; aliases: string[]; domains: string[] };
export type TrackingBrands = { own: BrandEntity; competitors: BrandEntity[] };
export type Citation = { url: string; domain: string; title: string | null; rank: number };
export type Mention = { name: string; own: boolean; count: number; first: number };
export type AnswerAnalysis = {
  ownMentioned: boolean;
  ownCited: boolean;
  /** 1-based position of the first citation of the site among the answer's citations. */
  ownRank: number | null;
  /** 1-based position of the brand among the tracked brands the answer names, by first appearance. */
  mentionRank: number | null;
  mentions: Mention[];
  /** Competitors with at least one cited page. */
  competitorsCited: string[];
};

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "https://www.Example.com/x" or "www.example.com" to "example.com"; null when not a domain. */
export function normalizeDomain(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (!host) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try { host = new URL(host).hostname; } catch { return null; }
  } else {
    host = host.split(/[/?#]/, 1)[0].replace(/:\d+$/, "");
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  return DOMAIN.test(host) ? host : null;
}

export function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

/** http(s) URLs only, without fragments, first appearance kept, ranked by order. */
export function normalizeCitations(raw: readonly { url?: string | null; title?: string | null }[], limit = 60): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const item of raw) {
    if (!item?.url || out.length >= limit) continue;
    let url: URL;
    try { url = new URL(item.url.trim()); } catch { continue; }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    url.hash = "";
    // Tracking parameters added by AI products say nothing about the page.
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
    const href = url.toString().slice(0, 2048);
    const domain = normalizeDomain(url.hostname);
    if (!domain || seen.has(href)) continue;
    seen.add(href);
    out.push({ url: href, domain, title: item.title?.trim().slice(0, 300) || null, rank: out.length + 1 });
  }
  return out;
}

/** Markdown links [text](https://…) in an answer, for platforms that only cite inline. */
export function markdownLinks(text: string): { url: string; title: string | null }[] {
  const out: { url: string; title: string | null }[] = [];
  for (const m of text.matchAll(/\[([^\]\n]{0,300})\]\((https?:\/\/[^\s)]+)\)/g)) out.push({ url: m[2], title: m[1] || null });
  return out;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** How often any of `names` appears, and where first. */
export function countMentions(text: string, names: readonly string[]): { count: number; first: number } {
  let count = 0;
  let first = -1;
  for (const raw of names) {
    const name = raw.trim();
    if (name.length < 2) continue;
    const body = escapeRegex(name).replace(/\s+/g, "\\s+");
    const pattern = CJK.test(name) ? new RegExp(body, "giu") : new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
    for (const m of text.matchAll(pattern)) {
      count++;
      if (first < 0 || (m.index ?? 0) < first) first = m.index ?? 0;
    }
  }
  return { count, first };
}

function entityNames(entity: BrandEntity): string[] {
  return [entity.name, ...entity.aliases, ...entity.domains].filter(Boolean);
}

export function analyzeAnswer(text: string, citations: readonly Citation[], brands: TrackingBrands): AnswerAnalysis {
  const entities = [{ entity: brands.own, own: true }, ...brands.competitors.map(entity => ({ entity, own: false }))];
  const mentions: Mention[] = [];
  for (const { entity, own } of entities) {
    const { count, first } = countMentions(text, entityNames(entity));
    if (count > 0) mentions.push({ name: entity.name, own, count, first });
  }
  const ordered = [...mentions].sort((a, b) => a.first - b.first);
  const ownMention = ordered.findIndex(m => m.own);
  const owns = (domain: string, entity: BrandEntity) => entity.domains.some(d => domainMatches(domain, d));
  const ownCitation = citations.find(c => owns(c.domain, brands.own));
  return {
    ownMentioned: ownMention >= 0,
    ownCited: !!ownCitation,
    ownRank: ownCitation?.rank ?? null,
    mentionRank: ownMention >= 0 ? ownMention + 1 : null,
    mentions,
    competitorsCited: brands.competitors.filter(c => citations.some(cit => owns(cit.domain, c))).map(c => c.name),
  };
}

export type AnswerRow = {
  platform: string;
  status: "OK" | "NO_ANSWER" | "FAILED";
  ownMentioned: boolean;
  ownCited: boolean;
  ownRank: number | null;
  mentionRank: number | null;
  mentions: Mention[];
  citations: Citation[];
};

export type PlatformVisibility = {
  /** Answers that came back (an answer saying nothing about the brand counts). */
  answers: number;
  /** Checks with no AI answer for the prompt (no AI Overview shown, for example). */
  noAnswer: number;
  failed: number;
  mentionRate: number | null;
  citationRate: number | null;
  avgCitationRank: number | null;
  avgMentionRank: number | null;
  /** The brand's share of the answers naming any tracked brand, counted once per answer. */
  shareOfVoice: number | null;
  competitors: { name: string; mentioned: number; cited: number }[];
  topDomains: { domain: string; count: number; own: boolean }[];
  ownPages: { url: string; count: number }[];
};

const round = (n: number) => Math.round(n * 1000) / 1000;
const mean = (values: number[]) => (values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null);

export function summarizeVisibility(rows: readonly AnswerRow[], brands: TrackingBrands, topN = 10): PlatformVisibility {
  const ok = rows.filter(r => r.status === "OK");
  const named = ok.filter(r => r.mentions.length > 0);
  const domainCounts = new Map<string, number>();
  const pageCounts = new Map<string, number>();
  for (const row of ok) {
    for (const domain of new Set(row.citations.map(c => c.domain))) domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    for (const c of row.citations) {
      if (brands.own.domains.some(d => domainMatches(c.domain, d))) pageCounts.set(c.url, (pageCounts.get(c.url) ?? 0) + 1);
    }
  }
  const isOwn = (domain: string) => brands.own.domains.some(d => domainMatches(domain, d));
  return {
    answers: ok.length,
    noAnswer: rows.filter(r => r.status === "NO_ANSWER").length,
    failed: rows.filter(r => r.status === "FAILED").length,
    mentionRate: ok.length ? round(ok.filter(r => r.ownMentioned).length / ok.length) : null,
    citationRate: ok.length ? round(ok.filter(r => r.ownCited).length / ok.length) : null,
    avgCitationRank: mean(ok.flatMap(r => (r.ownRank ? [r.ownRank] : []))),
    avgMentionRank: mean(ok.flatMap(r => (r.mentionRank ? [r.mentionRank] : []))),
    shareOfVoice: named.length ? round(named.filter(r => r.ownMentioned).length / named.reduce((sum, r) => sum + r.mentions.length, 0)) : null,
    competitors: brands.competitors.map(c => ({
      name: c.name,
      mentioned: ok.filter(r => r.mentions.some(m => !m.own && m.name === c.name)).length,
      cited: ok.filter(r => r.citations.some(cit => c.domains.some(d => domainMatches(cit.domain, d)))).length,
    })),
    topDomains: [...domainCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN)
      .map(([domain, count]) => ({ domain, count, own: isOwn(domain) })),
    ownPages: [...pageCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN).map(([url, count]) => ({ url, count })),
  };
}
