import { siteUrl } from "@/lib/content-planner/schema";
import { hostOf, normalizeSourceUrl, sourceKey, verifiedPageMatcher } from "./source-url";
import type { LinkReviewEntry, WorkbenchResult } from "./schema";

/*
 * Links in a finished AI draft. A draft may link to the site's verified pages
 * (allowedInternalLinks), to the site's trusted sources, and to URLs already
 * in the text the owner supplied (an article being rewritten keeps its links).
 * Any other link is not invented away by failing the whole task:
 *   - in text the owner may publish (title, summary, article, meta fields,
 *     paragraph replacements, internal link anchors) the link is replaced by
 *     a visible marker, "〔待核实：host〕" or "[verify source: host]";
 *   - in notes (change notes, the verification checklist, evidence and
 *     verification steps, report actions, keyword ideas) it stays as plain
 *     text, since the interface never renders it as a link;
 *   - an internal link suggestion whose target is not a verified page is dropped;
 *   - inside code (fenced blocks and `inline code`) it stays, since a marker
 *     would break the code, and is listed as KEPT_IN_CODE.
 * Every such link is listed in linkReview for the owner to check, and can be
 * added to the trusted sources from there. A verified page also matches in
 * another spelling (http, "www.", a trailing slash); an internal link
 * suggestion then takes the verified spelling.
 */

// A bare address ends at whitespace, quotes, brackets, CJK punctuation or CJK text: Chinese prose
// often follows a URL without a space ("见 https://example.org/a，其中"). Links inside markdown keep any characters.
// U+E000 and U+E001 delimit code held out of the scan (maskCode).
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>"'\]`}\u3000-\u303f\uff00-\uffef\ue000\ue001\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/giu;
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
// A link's label may hold an image: [![alt](picture)](page).
const MARKDOWN_LINK = /(!?)\[((?:!\[[^\]\n]*\]\([^)\n]*\)|[^\]\n])*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
const REFERENCE = /^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^>]+>|\S+)/gm;
const HTML_ATTRIBUTE = /\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const AUTOLINK = /<([a-z][a-z0-9+.-]*:[^>\s]+)>/gi;
const UNSAFE_SCHEME = /^(?:javascript|data|vbscript|file|blob):/i;
const TRAILING = /[),.;!?，。；！]+$/u;
const MAX_ENTRIES = 50;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CODE_FENCE_END = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// An inline code span: a run of backticks, then text without a blank line, then the same run.
const CODE_SPAN = /(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?[^`])\1(?!`)/g;
const HELD = /\ue000 (\d+) \ue001/g;

/**
 * Markdown with its code replaced by placeholders, so that links are found
 * only in prose: fenced blocks (``` or ~~~, to the closing fence or the end)
 * and inline code spans. Text that already holds the placeholder characters
 * is scanned whole.
 */
function maskCode(text: string): { masked: string; code: string[] } {
  if (!/`|~~~/.test(text) || /[\ue000\ue001]/.test(text)) return { masked: text, code: [] };
  const code: string[] = [];
  const hold = (value: string) => `\ue000 ${code.push(value) - 1} \ue001`;
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = CODE_FENCE.exec(lines[i]);
    // A backtick fence's info string cannot hold a backtick: "```a` b" is inline code.
    if (!open || (open[1][0] === "`" && open[2].includes("`"))) { out.push(lines[i]); continue; }
    let end = i + 1;
    for (; end < lines.length; end++) {
      const close = CODE_FENCE_END.exec(lines[end]);
      if (close && close[1][0] === open[1][0] && close[1].length >= open[1].length) break;
    }
    end = Math.min(end, lines.length - 1);
    out.push(hold(lines.slice(i, end + 1).join("\n")));
    i = end;
  }
  return { masked: out.join("\n").replace(CODE_SPAN, span => hold(span)), code };
}

type Verdict = { ok: true } | { ok: false; status: "UNVERIFIED" | "UNSAFE"; url: string };
type Mode = "replace" | "keep";

export type LinkReviewOptions = {
  domain: string;
  allowedInternalLinks: string[];
  trustedSources: string[];
  /** Text the owner supplied for the task; its URLs may be kept. */
  body: string;
  /** The draft language: Chinese drafts get Chinese markers. */
  language: string;
};

export function reviewLinks<T extends WorkbenchResult>(result: T, options: LinkReviewOptions): { result: T; review: LinkReviewEntry[] } {
  const verifiedPage = verifiedPageMatcher(options.allowedInternalLinks, options.domain);
  const keys = (urls: string[]) => new Set(urls.flatMap(url => { const normalized = normalizeSourceUrl(url); return normalized ? [sourceKey(normalized)] : []; }));
  const trusted = keys(options.trustedSources);
  const supplied = keys([...options.body.matchAll(BARE_URL)].map(match => match[0].replace(TRAILING, "")));
  const zh = options.language.toLowerCase().startsWith("zh");
  const review: LinkReviewEntry[] = [];
  const seen = new Set<string>();

  const internal = (value: string): string | null => { try { return siteUrl(value, options.domain); } catch { return null; } };
  const judge = (raw: string): Verdict => {
    const value = raw.trim().replace(/^<|>$/g, "");
    // An empty target or a link to a heading of the same text points nowhere else.
    if (!value || value.startsWith("#")) return { ok: true };
    if (UNSAFE_SCHEME.test(value.replace(/\s+/g, ""))) return { ok: false, status: "UNSAFE", url: value.slice(0, 200) };
    if (verifiedPage(value)) return { ok: true };
    const own = internal(value);
    const normalized = normalizeSourceUrl(value);
    if (normalized && (trusted.has(sourceKey(normalized)) || supplied.has(sourceKey(normalized)))) return { ok: true };
    return { ok: false, status: "UNVERIFIED", url: (normalized ?? own ?? value).slice(0, 2048) };
  };
  const record = (verdict: Extract<Verdict, { ok: false }>, field: string, action: LinkReviewEntry["action"], context: string) => {
    const key = `${field}\u0000${verdict.url}`;
    if (seen.has(key) || review.length >= MAX_ENTRIES) return;
    seen.add(key);
    review.push({ url: verdict.url, field, status: verdict.status, action, context: context.replace(/\s+/g, " ").trim().slice(0, 160) });
  };
  const marker = (verdict: Extract<Verdict, { ok: false }>) => {
    if (verdict.status === "UNSAFE") return zh ? "〔已移除不安全链接〕" : "[unsafe link removed]";
    // A mailto: or tel: link has no host: name its address instead.
    const host = hostOf(verdict.url) || verdict.url.replace(/^[a-z][a-z0-9+.-]*:(?:\/\/)?/i, "").split(/[?#]/)[0].slice(0, 80);
    return zh ? `〔待核实${host ? `：${host}` : ""}〕` : `[verify source${host ? `: ${host}` : ""}]`;
  };
  /** Replaces (or, for notes, only lists) every link of `text` that is not allowed. */
  const scan = (text: string, field: string, mode: Mode): string => {
    const action = mode === "replace" ? "REPLACED" : "KEPT_IN_NOTES";
    const swap = (match: string, verdict: Verdict, replacement: () => string) => {
      if (verdict.ok) return match;
      record(verdict, field, action, match);
      return mode === "replace" ? replacement() : match;
    };
    const { masked, code } = mode === "replace" ? maskCode(text) : { masked: text, code: [] as string[] };
    // Images first: a linked image's picture and page are judged apart.
    let out = masked.replace(MARKDOWN_IMAGE, (match, alt: string, target: string) => {
      const verdict = judge(target);
      return swap(match, verdict, () => `${alt}${marker(verdict as Extract<Verdict, { ok: false }>)}`);
    });
    out = out.replace(MARKDOWN_LINK, (match, bang: string, label: string, target: string) => {
      if (bang) return match;
      const verdict = judge(target);
      return swap(match, verdict, () => `${label}${marker(verdict as Extract<Verdict, { ok: false }>)}`);
    });
    out = out.replace(REFERENCE, (match, prefix: string, target: string) => {
      const verdict = judge(target);
      return swap(match, verdict, () => `${prefix}${marker(verdict as Extract<Verdict, { ok: false }>)}`);
    });
    out = out.replace(HTML_ATTRIBUTE, (match, name: string, double?: string, single?: string, bare?: string) => {
      const verdict = judge(double ?? single ?? bare ?? "");
      return swap(match, verdict, () => `${name}="#${zh ? "待核实" : "verify-source"}"`);
    });
    out = out.replace(AUTOLINK, (match, target: string) => {
      const verdict = judge(target);
      return swap(match, verdict, () => marker(verdict as Extract<Verdict, { ok: false }>));
    });
    out = out.replace(BARE_URL, match => {
      const url = match.replace(TRAILING, "");
      const verdict = judge(url);
      return swap(match, verdict, () => `${marker(verdict as Extract<Verdict, { ok: false }>)}${match.slice(url.length)}`);
    });
    if (!code.length) return out;
    // In the order the code appears in the text.
    for (const held of masked.matchAll(HELD)) {
      for (const match of (code[Number(held[1])] ?? "").matchAll(BARE_URL)) {
        const verdict = judge(match[0].replace(TRAILING, ""));
        if (!verdict.ok) record(verdict, field, "KEPT_IN_CODE", match[0]);
      }
    }
    return out.replace(HELD, (match, index: string) => code[Number(index)] ?? match);
  };
  const publish = (text: string, field: string) => scan(text, field, "replace");
  const note = (text: string, field: string) => scan(text, field, "keep");

  const internalLinks = result.internalLinks.flatMap(link => {
    const target = verifiedPage(link.target);
    if (target) return [{ ...link, target }];
    const verdict = judge(link.target);
    record(verdict.ok ? { ok: false, status: "UNVERIFIED", url: link.target.slice(0, 2048) } : verdict, "internalLinks", "DROPPED", link.anchor);
    return [];
  }).map(link => ({ ...link, anchor: publish(link.anchor, "internalLinks"), reason: note(link.reason, "internalLinks") }));

  const cleaned = {
    ...result,
    title: publish(result.title, "title"),
    summary: publish(result.summary, "summary"),
    contentMarkdown: publish(result.contentMarkdown, "contentMarkdown"),
    metaTitle: publish(result.metaTitle, "metaTitle"),
    metaDescription: publish(result.metaDescription, "metaDescription"),
    changeNotes: result.changeNotes.map(text => note(text, "changeNotes")),
    factChecks: result.factChecks.map(text => note(text, "factChecks")),
    internalLinks,
    ...(result.paragraphEdits ? { paragraphEdits: result.paragraphEdits.map(edit => ({ ...edit,
      replacementText: publish(edit.replacementText, "paragraphEdits"),
      reason: note(edit.reason, "paragraphEdits"), evidence: edit.evidence.map(text => note(text, "paragraphEdits")),
      verification: edit.verification.map(text => note(text, "paragraphEdits")) })) } : {}),
    ...(result.reportActions ? { reportActions: result.reportActions.map(action => ({ ...action,
      title: note(action.title, "reportActions"), reason: note(action.reason, "reportActions"),
      nextStep: note(action.nextStep, "reportActions"), verify: note(action.verify, "reportActions") })) } : {}),
    ...(result.keywordIdeas ? { keywordIdeas: result.keywordIdeas.map(idea => ({ ...idea,
      keyword: note(idea.keyword, "keywordIdeas"), cluster: note(idea.cluster, "keywordIdeas"),
      angle: note(idea.angle, "keywordIdeas"), rationale: note(idea.rationale, "keywordIdeas") })) } : {}),
  };
  return { result: cleaned, review };
}
