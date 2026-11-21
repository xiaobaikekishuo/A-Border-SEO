import { z } from "zod";
import { contentUnits } from "@/lib/text-units";
import { unjudgedAdLaw } from "./ad-law-coverage";
import { isFresh, isQuestionHeading } from "@/lib/geo/readiness-rules";

/*
 * Quality checklist of an article review. Three items need reading the text
 * and come from the model, each with a verbatim quote that is checked here:
 *   DIRECT_ANSWER  the opening answers the main question behind the keyword
 *   FIRST_HAND     the author's own tests, cases or data
 *   SOURCED        important claims name their source
 * Three come from the application, so the model cannot contradict the crawl:
 *   AUTHOR_DATE        author and publication or update date in the page markup
 *   QUESTION_HEADINGS  at least one subheading phrased as a reader's question
 *   AD_LAW             Chinese text only: absolute terms of the Advertising Law
 *                      (art. 9(3)), found here and judged in context by the model
 * Every item is a hint for the owner. Nothing here blocks applying a review.
 */

export const MODEL_QUALITY_KEYS = ["DIRECT_ANSWER", "FIRST_HAND", "SOURCED"] as const;
export const QUALITY_KEYS = ["DIRECT_ANSWER", "FIRST_HAND", "SOURCED", "AUTHOR_DATE", "QUESTION_HEADINGS", "AD_LAW"] as const;
export type QualityKey = typeof QUALITY_KEYS[number];
export const QUALITY_STATUSES = ["PASS", "PARTIAL", "FAIL", "UNKNOWN", "NOT_APPLICABLE"] as const;
export type QualityStatus = typeof QUALITY_STATUSES[number];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const adLawCandidateSchema = z.object({ term: z.string().min(1).max(20), context: z.string().max(120) }).strict();
export type AdLawCandidate = z.infer<typeof adLawCandidateSchema>;

/** What the crawl and the text show without asking the model, saved with the review request. */
export const reviewSignalsSchema = z.object({
  /** Article markup names an author; null when the crawl predates that evidence. */
  author: z.boolean().nullable(),
  published: day.nullable(),
  modified: day.nullable(),
  /** The newest date is within 12 months of the crawl; null when dates were not collected. */
  fresh: z.boolean().nullable(),
  /** Links to other sites from the crawled main content; null for pasted text or older crawls. */
  sourceLinks: z.number().int().min(0).nullable(),
  sourceHosts: z.array(z.string().max(253)).max(5),
  /** Subheadings of the reviewed text; null when none are known. */
  headings: z.object({ total: z.number().int().min(0), questions: z.number().int().min(0) }).strict().nullable(),
  /** Chinese text: candidate absolute terms with their context. null for other languages. */
  adLaw: z.array(adLawCandidateSchema).max(20).nullable(),
}).strict();
export type ReviewSignals = z.infer<typeof reviewSignalsSchema>;

const quote = z.string().trim().max(300);
const advice = z.string().trim().max(600);
/** What the model returns for each article. */
export const modelQualitySchema = z.array(z.object({
  key: z.enum(MODEL_QUALITY_KEYS), status: z.enum(["PASS", "PARTIAL", "FAIL", "UNKNOWN"]), evidence: quote, fix: advice,
}).strict()).max(3);
export const adLawJudgementSchema = z.array(z.object({
  term: z.string().trim().min(1).max(20), quote: z.string().trim().min(1).max(200),
  verdict: z.enum(["RISK", "LIKELY_EXEMPT"]), rewrite: z.string().trim().max(300),
}).strict()).max(20);
export type AdLawJudgement = z.infer<typeof adLawJudgementSchema>[number];
/** The merged checklist saved with the review: all six items. */
export const storedQualitySchema = z.array(z.object({
  key: z.enum(QUALITY_KEYS), status: z.enum(QUALITY_STATUSES), evidence: quote, fix: advice,
}).strict()).max(6);
export type QualityItem = z.infer<typeof storedQualitySchema>[number];

// Same or similar meaning as 国家级, 最高级 and 最佳 (Advertising Law art. 9(3)), as commonly enforced.
const AD_LAW_WORDS = [
  "国家级", "世界级", "全球级", "宇宙级", "国际级", "最高级", "顶级", "顶尖", "极品", "极致", "至尊", "巅峰",
  "第一", "唯一", "首个", "首家", "首选", "首创", "独家", "独一无二", "绝无仅有", "史无前例", "前所未有", "无与伦比",
  "王牌", "冠军", "领导品牌", "领先品牌", "领袖品牌", "金牌", "绝对", "完美", "无敌", "万能", "永久", "百分之百", "100%",
  "零风险", "无副作用", "根治", "NO.1", "No.1", "TOP1", "Top1",
];
const SUPERLATIVE = "最(?:佳|好|优|强|大|高|低|先进|便宜|实惠|划算|安全|权威|专业|受欢迎|畅销|热销|流行|有效|舒适|健康|正宗|纯正|靠谱|值得|全|快|稳定|耐用)";
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Listed words first, longest first: an alternation takes the first that matches, and 最高级 must win over 最高.
const AD_LAW = new RegExp(`${[...AD_LAW_WORDS].sort((a, b) => b.length - a.length).map(escape).join("|")}|${SUPERLATIVE}`, "gu");
// Ordinals and idioms, not claims: 第一步, 第一次, 第一时间, 第一手, 绝对值.
const NOT_A_CLAIM = /^(?:第一(?:步|次|章|节|条|天|点|部分|阶段|期|季|层|轮|届|页|段|集|批|手|时间|印象|反应|眼|个月|年|周|[百千万])|绝对值)/u;
const MAX_CANDIDATES = 20;

const HAN = /\p{Script=Han}/gu;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
/** Mostly Chinese: Han characters make up at least 30% of the text and Japanese kana are rare. */
export function isChineseText(text: string): boolean {
  const han = text.match(HAN)?.length ?? 0;
  const units = contentUnits(text);
  if (!units || han / units < 0.3) return false;
  return (text.match(KANA)?.length ?? 0) < han * 0.1;
}

/** Candidate absolute terms in Chinese text, with up to 20 characters of context on each side. */
export function adLawCandidates(text: string): AdLawCandidate[] {
  const found: AdLawCandidate[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(AD_LAW)) {
    const at = match.index ?? 0;
    if (NOT_A_CLAIM.test(text.slice(at, at + 8))) continue;
    const context = text.slice(Math.max(0, at - 20), at + match[0].length + 20).replace(/\s+/g, " ").trim();
    const key = `${match[0]}\u0000${context}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ term: match[0], context });
    if (found.length >= MAX_CANDIDATES) break;
  }
  return found;
}

/** Markdown headings ("## Why ...") of pasted text; pasted text has no crawled headings. */
export function markdownHeadings(text: string): string[] {
  return [...text.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)].map(match => match[1]).filter(Boolean).slice(0, 80);
}

const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * The application's half of the checklist, from the latest crawl. `schemaReport`
 * and `geoSignals` are the saved AuditPage JSON; `crawlAt` dates the evidence.
 */
export function reviewSignals(input: {
  text: string; headings: string[]; source: "CRAWL" | "PASTED";
  schemaReport: unknown; geoSignals: unknown; crawlAt: Date | null;
}): ReviewSignals {
  const report = input.schemaReport && typeof input.schemaReport === "object" ? input.schemaReport as { version?: unknown; signals?: Record<string, unknown> | null } : null;
  const schema = report && typeof report.version === "number" && report.version >= 2 && report.signals && typeof report.signals === "object" ? report.signals : null;
  const raw = input.geoSignals && typeof input.geoSignals === "object" ? input.geoSignals as Record<string, unknown> : null;
  const geo = raw && raw.version === 1 && typeof raw.sourceLinks === "number" ? raw : null;
  // GEO evidence already merges the markup dates with meta tags and <time>.
  const published = geo ? (isDay(geo.published) ? geo.published : null) : schema && isDay(schema.published) ? schema.published : null;
  const modified = geo ? (isDay(geo.modified) ? geo.modified : null) : schema && isDay(schema.modified) ? schema.modified : null;
  const datesKnown = !!geo || !!schema;
  const headingList = input.source === "CRAWL" ? input.headings : markdownHeadings(input.text);
  const crawled = input.source === "CRAWL" && geo;
  return {
    author: schema ? schema.author === true : null,
    published, modified,
    fresh: datesKnown ? isFresh([published, modified], input.crawlAt ?? new Date()) : null,
    sourceLinks: crawled ? Number(crawled.sourceLinks) : null,
    sourceHosts: crawled && Array.isArray(crawled.sourceHosts) ? crawled.sourceHosts.filter((host): host is string => typeof host === "string" && host.length <= 253).slice(0, 5) : [],
    headings: headingList.length ? { total: headingList.length, questions: headingList.filter(isQuestionHeading).length } : null,
    adLaw: isChineseText(input.text) ? adLawCandidates(input.text) : null,
  };
}

const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const item = (key: QualityKey, status: QualityStatus, evidence = "", fix = ""): QualityItem => ({ key, status, evidence, fix });

/** Model judgements of the candidates that quote the reviewed text; anything else is dropped. */
export function checkedAdLaw(judged: AdLawJudgement[] | undefined, signals: ReviewSignals | null | undefined, text: string): AdLawJudgement[] {
  if (!signals?.adLaw?.length || !judged?.length) return [];
  const terms = new Set(signals.adLaw.map(candidate => candidate.term));
  const haystack = normalize(text);
  const seen = new Set<string>();
  return judged.filter(entry => {
    const quoted = normalize(entry.quote);
    const key = `${entry.term}\u0000${quoted}`;
    if (!terms.has(entry.term) || !quoted.includes(entry.term) || !haystack.includes(quoted) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(entry => ({ ...entry, rewrite: entry.verdict === "RISK" ? entry.rewrite : "" })).slice(0, MAX_CANDIDATES);
}

/**
 * The six-item checklist saved with an article: the model's three items keep
 * their status only when their quote is in the reviewed text; the other three
 * are computed from `signals`. Requests saved before 1.5.8 have no signals.
 */
export function mergedQuality(model: z.infer<typeof modelQualitySchema> | undefined, signals: ReviewSignals | null | undefined, text: string, adLaw: AdLawJudgement[]): QualityItem[] {
  const haystack = normalize(text);
  const fromModel = MODEL_QUALITY_KEYS.map(key => {
    const found = model?.find(entry => entry.key === key);
    if (!found) return item(key, "UNKNOWN");
    const evidence = normalize(found.evidence);
    // A quote that is not in the text, or a pass without one, cannot be checked.
    if (evidence && !haystack.includes(evidence)) return item(key, "UNKNOWN", "", found.fix);
    if ((found.status === "PASS" || found.status === "PARTIAL") && !evidence) return item(key, "UNKNOWN", "", found.fix);
    return item(key, found.status, evidence, found.status === "PASS" ? "" : found.fix);
  });
  if (!signals) return [...fromModel, item("AUTHOR_DATE", "UNKNOWN"), item("QUESTION_HEADINGS", "UNKNOWN"), item("AD_LAW", "UNKNOWN")];
  const hasDate = !!(signals.published || signals.modified);
  const authorDate: QualityStatus = signals.author === null && signals.fresh === null ? "UNKNOWN"
    : signals.author === true && hasDate && signals.fresh === true ? "PASS"
      : signals.author === false && !hasDate && signals.fresh !== null ? "FAIL"
        : "PARTIAL";
  const headings: QualityStatus = !signals.headings ? "UNKNOWN" : signals.headings.questions > 0 ? "PASS" : "FAIL";
  const adLawStatus: QualityStatus = signals.adLaw === null ? "NOT_APPLICABLE"
    : adLaw.some(entry => entry.verdict === "RISK") ? "FAIL"
      : unjudgedAdLaw(signals.adLaw, adLaw).length ? "PARTIAL"
        : "PASS";
  return [...fromModel, item("AUTHOR_DATE", authorDate), item("QUESTION_HEADINGS", headings), item("AD_LAW", adLawStatus)];
}

/**
 * Update tasks for the brief from the failed or partial checks, in the
 * article's language. The model's items carry their own fix text.
 */
export function qualityTasks(quality: QualityItem[] | undefined, signals: ReviewSignals | null | undefined, adLaw: AdLawJudgement[] | undefined): string[] {
  if (!quality?.length) return [];
  const zh = signals?.adLaw != null;
  const tasks: string[] = [];
  for (const entry of quality) {
    if (entry.status !== "FAIL" && entry.status !== "PARTIAL") continue;
    if (entry.fix) { tasks.push(entry.fix); continue; }
    if (entry.key === "AUTHOR_DATE") {
      tasks.push(zh ? "补充可见的作者署名和发布或更新日期，并在 Article 标记中填写 author、datePublished、dateModified；内容过时的先更新。"
        : "Show the author and the publication or update date on the page, add author, datePublished and dateModified to the Article markup, and update outdated content first.");
    } else if (entry.key === "QUESTION_HEADINGS") {
      tasks.push(zh ? "把 1 到 3 个小标题改成读者会问的问题，并在标题下第一句直接回答。"
        : "Rephrase one to three subheadings as the questions readers ask, and answer each in the first sentence below it.");
    } else if (entry.key === "AD_LAW") {
      const risky = [...new Set((adLaw ?? []).filter(value => value.verdict === "RISK").map(value => value.term))];
      tasks.push(risky.length ? `改写有广告法风险的绝对化用语：${risky.slice(0, 8).join("、")}。` : "人工确认文中的绝对化用语是否属于广告法豁免情形。");
    }
  }
  return tasks.map(task => `QUALITY: ${task}`.slice(0, 1000));
}
