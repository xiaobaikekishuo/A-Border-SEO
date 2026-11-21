import { normalizeUrl } from "@/lib/crawler/urls";

/*
 * hreflang checks (IssueType HREFLANG), after Google's rules for localized
 * versions (developers.google.com/search/docs/specialty/international/localized-versions):
 *
 *   - the value is an ISO 639-1 language, optionally an ISO 15924 script and
 *     an ISO 3166-1 alpha-2 region (en, en-GB, zh-Hant-TW), or x-default.
 *     A region alone ("us") is not a language; UN M.49 areas (es-419) and
 *     reserved codes (UK, EU, UN) are not supported.
 *   - URLs are fully qualified.
 *   - every version lists itself and every other version, and each listed
 *     version links back. Without the return link Google can ignore the pair.
 *   - the listed URLs are the canonical, indexable pages, not redirects.
 *
 * A listed page the crawl did not fetch (another domain, past the page
 * limit) cannot be verified and is skipped. Pages whose canonical points
 * elsewhere are skipped too: Google reads hreflang on canonical pages.
 * All problems of one page form one finding.
 */

const LANGUAGES = new Set(("aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz " +
  "ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv " +
  "ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no " +
  "nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti " +
  "tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu").split(" "));

const REGIONS = new Set(("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
  "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW").split(" "));

/** Withdrawn ISO 639 codes and their replacements. */
const DEPRECATED: Record<string, string> = { iw: "he", in: "id", ji: "yi", jw: "jv", mo: "ro" };
/** Reserved or user-assigned region codes that are not ISO 3166-1 countries, with the code to use where there is one. */
const RESERVED: Record<string, string | null> = { UK: "GB", EU: null, EZ: null, UN: null, AC: null, CP: null, DG: null, EA: null, IC: null, TA: null, XK: null };

export type HreflangCodeCheck =
  | { ok: true }
  | { ok: false; kind: "invalid_code" | "unsupported_region"; hint: string | null; regionOnly?: boolean };

/** Whether one hreflang value follows Google's format; `hint` is the likely intended value where it can be told. */
export function checkHreflangCode(raw: string): HreflangCodeCheck {
  const value = raw.trim();
  if (/^x-default$/i.test(value)) return { ok: true };
  if (!value) return { ok: false, kind: "invalid_code", hint: null };
  if (value.includes("_")) {
    const fixed = value.replace(/_/g, "-");
    return { ok: false, kind: "invalid_code", hint: checkHreflangCode(fixed).ok ? fixed : null };
  }
  const parts = value.split("-");
  if (parts.some(part => !part)) return { ok: false, kind: "invalid_code", hint: null };
  const language = parts[0].toLowerCase();
  if (DEPRECATED[language]) return { ok: false, kind: "invalid_code", hint: [DEPRECATED[language], ...parts.slice(1)].join("-") };
  if (!LANGUAGES.has(language)) {
    // "us", "gb", "cn": a country without a language. Google does not derive one from it.
    const regionOnly = parts.length === 1 && REGIONS.has(language.toUpperCase());
    return { ok: false, kind: "invalid_code", hint: null, ...(regionOnly ? { regionOnly } : {}) };
  }
  let i = 1;
  if (parts[i] !== undefined && /^[a-z]{4}$/i.test(parts[i])) i++; // ISO 15924 script, e.g. Hant
  if (parts[i] !== undefined) {
    const region = parts[i];
    if (/^\d{3}$/.test(region)) return { ok: false, kind: "unsupported_region", hint: null };
    if (!/^[a-z]{2}$/i.test(region)) return { ok: false, kind: "invalid_code", hint: null };
    const upper = region.toUpperCase();
    if (upper in RESERVED) {
      const replacement = RESERVED[upper];
      return { ok: false, kind: "unsupported_region", hint: replacement ? [...parts.slice(0, i), replacement].join("-") : null };
    }
    if (!REGIONS.has(upper)) return { ok: false, kind: "invalid_code", hint: null };
    i++;
  }
  return i === parts.length ? { ok: true } : { ok: false, kind: "invalid_code", hint: null };
}

export type HreflangTag = { lang: string; href: string };
export type HreflangPage = {
  url: string;
  statusCode: number;
  indexable: boolean;
  /** Normalized canonical URL, or null. */
  canonical: string | null;
  hreflangTags: readonly HreflangTag[];
};

export type HreflangProblemKind =
  | "invalid_code" | "unsupported_region" | "relative_url" | "conflict"
  | "missing_self" | "no_return" | "bad_alternate" | "missing_x_default";
export type HreflangProblem = {
  kind: HreflangProblemKind;
  lang?: string;
  href?: string;
  hint?: string | null;
  /** bad_alternate: why the listed page cannot be the alternate. */
  reason?: "redirect" | "broken" | "noindex" | "non_canonical";
  /** conflict: how many different URLs one value points to. */
  count?: number;
};
export type HreflangIssue = {
  url: string;
  type: "HREFLANG";
  severity: "WARNING" | "INFO";
  message: string;
  details: Record<string, unknown>;
};

const ORDER: HreflangProblemKind[] = ["invalid_code", "unsupported_region", "relative_url", "conflict", "missing_self", "no_return", "bad_alternate", "missing_x_default"];
const REASON_TEXT = { redirect: "redirecting", broken: "broken", noindex: "noindex", non_canonical: "non-canonical" } as const;

export function hreflangMessage(problem: HreflangProblem): string {
  switch (problem.kind) {
    case "invalid_code": return `Invalid hreflang value "${problem.lang}"`;
    case "unsupported_region": return `Unsupported hreflang region in "${problem.lang}"`;
    case "relative_url": return `hreflang URL is not absolute: ${problem.href}`;
    case "conflict": return `hreflang "${problem.lang}" points to ${problem.count} different URLs`;
    case "missing_self": return "hreflang set does not list this page";
    case "no_return": return `No return hreflang link from ${problem.href}`;
    case "bad_alternate": return `hreflang "${problem.lang}" points to a ${REASON_TEXT[problem.reason ?? "broken"]} URL: ${problem.href}`;
    case "missing_x_default": return "hreflang set has no x-default";
  }
}

export function hreflangIssues(
  pages: readonly HreflangPage[],
  opts: {
    /** Requested URL → final URL of every redirect the crawl followed (normalized). */
    redirects?: ReadonlyMap<string, string>;
    howToFix?: string;
  } = {}
): HreflangIssue[] {
  const byUrl = new Map(pages.map(page => [page.url, page] as const));
  const target = (tag: HreflangTag, base: string) => normalizeUrl(tag.href.trim(), base);
  const out: HreflangIssue[] = [];
  for (const page of pages) {
    if (!page.hreflangTags.length || page.statusCode !== 200 || !page.indexable) continue;
    if (page.canonical && page.canonical !== page.url) continue;
    const problems: HreflangProblem[] = [];
    const codes = new Set<string>();
    const byCode = new Map<string, { lang: string; urls: Set<string> }>();
    let listsSelf = false;
    let xDefault = false;
    for (const tag of page.hreflangTags) {
      const lang = tag.lang.trim();
      const key = lang.toLowerCase();
      if (!codes.has(key)) {
        codes.add(key);
        const check = checkHreflangCode(lang);
        if (!check.ok) problems.push({ kind: check.kind, lang, hint: check.hint });
      }
      if (key === "x-default") xDefault = true;
      if (!/^https?:\/\//i.test(tag.href.trim())) problems.push({ kind: "relative_url", lang, href: tag.href.trim().slice(0, 500) });
      const url = target(tag, page.url);
      if (!url) continue;
      if (url === page.url) listsSelf = true;
      const entry = byCode.get(key) ?? { lang, urls: new Set<string>() };
      entry.urls.add(url);
      byCode.set(key, entry);
    }
    for (const { lang, urls } of byCode.values()) if (urls.size > 1) problems.push({ kind: "conflict", lang, count: urls.size });
    if (!listsSelf) problems.push({ kind: "missing_self" });
    const checked = new Set<string>();
    for (const tag of page.hreflangTags) {
      const url = target(tag, page.url);
      if (!url || url === page.url || checked.has(url)) continue;
      checked.add(url);
      if (opts.redirects?.has(url)) { problems.push({ kind: "bad_alternate", lang: tag.lang.trim(), href: url, reason: "redirect" }); continue; }
      const alternate = byUrl.get(url);
      if (!alternate) continue;
      const reason = alternate.statusCode !== 200 ? "broken"
        : !alternate.indexable ? "noindex"
        : alternate.canonical && alternate.canonical !== alternate.url ? "non_canonical"
        : null;
      if (reason) problems.push({ kind: "bad_alternate", lang: tag.lang.trim(), href: url, reason });
      else if (!alternate.hreflangTags.some(back => target(back, alternate.url) === page.url)) problems.push({ kind: "no_return", lang: tag.lang.trim(), href: url });
    }
    if (!xDefault && byCode.size >= 2) problems.push({ kind: "missing_x_default" });
    if (!problems.length) continue;
    problems.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    const more = problems.length - 1;
    out.push({
      url: page.url,
      type: "HREFLANG",
      severity: problems.some(p => p.kind !== "missing_x_default") ? "WARNING" : "INFO",
      message: hreflangMessage(problems[0]) + (more > 0 ? ` (+${more} more)` : ""),
      details: {
        kind: problems[0].kind,
        problems: problems.slice(0, 20),
        tags: page.hreflangTags.length,
        ...(opts.howToFix ? { howToFix: opts.howToFix } : {}),
      },
    });
  }
  return out;
}
