/*
 * robots.txt parsing and matching for the AI access check, per RFC 9309.
 *
 * - Groups: one or more User-agent lines followed by rules. A User-agent line
 *   after a rule (or another group member line) starts a new group. Groups
 *   that name the same product token are combined (RFC 9309 2.2.1).
 * - A crawler uses the groups that name its product token (case-insensitive),
 *   otherwise the "*" groups. Policy tokens such as "__usage_ai-training" are
 *   never matched by "*" (draft-kelley-aipref-training-preference-signal).
 * - Allow/Disallow: the longest matching pattern wins; an Allow wins a tie.
 *   "*" matches any characters and a trailing "$" anchors the end. No rule
 *   matching means allowed, and /robots.txt is always allowed (RFC 9309 2.2.2).
 * - Paths compare after percent-encoding normalization: non-ASCII is
 *   UTF-8 percent-encoded, escapes of unreserved characters are decoded and
 *   other escapes are upper-cased, in URLs and patterns alike.
 * - Content-Signal (Cloudflare's Content Signals Policy) and Content-Usage
 *   (IETF AIPREF attach draft) lines are kept as declared preferences. They
 *   do not change crawl access.
 *
 * Matching splits a pattern at "*" and finds the pieces left to right with
 * indexOf, so its cost is linear in the path for each rule. No regular
 * expression is built from file content.
 */

export const MAX_RULES = 20_000;
const MAX_PATTERN_CHARS = 4_096;
const MAX_PREFERENCES = 200;

export type RobotsRule = { allow: boolean; pattern: string; line: number; text: string };
export type ContentPreference = {
  kind: "CONTENT_SIGNAL" | "CONTENT_USAGE";
  /** The group's user agents ("*" included), or "FILE" for a line before any group. */
  scope: string[] | "FILE";
  /** Optional path pattern the preference is limited to. */
  path: string | null;
  values: Record<string, string>;
  line: number;
  text: string;
};
export type RobotsGroup = {
  /** Lower-case product tokens, "*" for the wildcard group. */
  agents: string[];
  rules: RobotsRule[];
  crawlDelay: number | null;
  preferences: ContentPreference[];
};
export type ParsedRobots = {
  groups: RobotsGroup[];
  /** Preferences written before the first User-agent line. */
  filePreferences: ContentPreference[];
  sitemaps: string[];
  ruleCount: number;
  /** Lines that are neither empty, comments nor a recognized field. */
  unrecognized: number;
  /** Recognized field lines (user-agent, allow, disallow, crawl-delay, sitemap, preferences). */
  recognized: number;
  tooComplex: boolean;
};

const UNRESERVED = /[A-Za-z0-9\-._~]/;
/** Printable ASCII that WHATWG URL parsing percent-encodes in paths; encoded in patterns too. */
const URL_ENCODED = new Set(['"', "<", ">", "`", "{", "}"]);
const HEX = "0123456789ABCDEF";

/** Percent-encoding normalization shared by URL paths and patterns. "*" and "$" are kept. */
export function normalizeRobotsPath(value: string): string {
  let out = "";
  const bytes = new TextEncoder();
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "%" && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      const decoded = String.fromCharCode(parseInt(value.slice(i + 1, i + 3), 16));
      out += UNRESERVED.test(decoded) ? decoded : "%" + value.slice(i + 1, i + 3).toUpperCase();
      i += 2;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code > 0x20 && code < 0x7f && !URL_ENCODED.has(char)) { out += char; continue; }
    // Non-ASCII (a full code point, surrogate pairs included), spaces and controls.
    const point = value.codePointAt(i)!;
    const text = String.fromCodePoint(point);
    if (point > 0xffff) i++;
    for (const byte of bytes.encode(text)) out += "%" + HEX[byte >> 4] + HEX[byte & 15];
  }
  return out;
}

/** The path and query of a URL as robots rules see it. */
export function robotsTarget(url: string): string {
  const parsed = new URL(url);
  return normalizeRobotsPath((parsed.pathname || "/") + parsed.search);
}

/** True when the normalized pattern matches the normalized path from its start. */
export function patternMatches(pattern: string, path: string): boolean {
  let body = pattern;
  const anchored = body.endsWith("$");
  if (anchored) body = body.slice(0, -1);
  const parts = body.split("*");
  if (!path.startsWith(parts[0])) return false;
  let position = parts[0].length;
  if (parts.length === 1) return anchored ? position === path.length : true;
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!part) continue;
    const at = path.indexOf(part, position);
    if (at < 0) return false;
    position = at + part.length;
  }
  const last = parts[parts.length - 1];
  if (!anchored) return last === "" || path.indexOf(last, position) >= 0;
  return path.length - last.length >= position && path.endsWith(last);
}

/** Lower-case product token of a User-agent value: "*" or the leading token characters. */
function agentToken(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("*")) return "*";
  const match = /^[A-Za-z0-9_-]+/.exec(trimmed);
  return match ? match[0].toLowerCase() : null;
}

/** "search=yes, ai-train=no" or "/blog/ train-ai=n, search=y" into a path and key/value pairs. */
function parsePreference(value: string): { path: string | null; values: Record<string, string> } | null {
  let rest = value.trim();
  let path: string | null = null;
  const first = /^(\S+)\s+(.*)$/.exec(rest);
  if (first && (first[1].startsWith("/") || first[1].startsWith("*")) && !first[1].includes("=")) {
    path = normalizeRobotsPath(first[1]);
    rest = first[2];
  }
  const values: Record<string, string> = {};
  for (const item of rest.split(",")) {
    const pair = /^\s*([A-Za-z][A-Za-z0-9_-]{0,40})\s*=\s*([A-Za-z0-9_-]{1,40})\s*$/.exec(item);
    if (!pair) continue;
    values[pair[1].toLowerCase()] = pair[2].toLowerCase();
  }
  return Object.keys(values).length ? { path, values } : null;
}

export function parseRobots(source: string): ParsedRobots {
  const result: ParsedRobots = { groups: [], filePreferences: [], sitemaps: [], ruleCount: 0, unrecognized: 0, recognized: 0, tooComplex: false };
  const lines = source.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  let group: RobotsGroup | null = null;
  // True once the current group has a member line: the next User-agent starts a new group.
  let groupHasMembers = false;
  let preferenceCount = 0;
  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const content = raw.replace(/#.*$/, "").trim();
    if (!content) return;
    const colon = content.indexOf(":");
    if (colon <= 0) { result.unrecognized++; return; }
    const key = content.slice(0, colon).trim().toLowerCase();
    const value = content.slice(colon + 1).trim();
    switch (key) {
      case "user-agent": {
        result.recognized++;
        const token = agentToken(value);
        if (!group || groupHasMembers) {
          group = { agents: [], rules: [], crawlDelay: null, preferences: [] };
          result.groups.push(group);
          groupHasMembers = false;
        }
        if (token && !group.agents.includes(token)) group.agents.push(token);
        return;
      }
      case "allow":
      case "disallow": {
        result.recognized++;
        if (!group) { result.unrecognized++; return; }
        groupHasMembers = true;
        // An empty value is no rule ("Disallow:" allows everything).
        if (!value) return;
        if (value.length > MAX_PATTERN_CHARS || ++result.ruleCount > MAX_RULES) { result.tooComplex = true; return; }
        group.rules.push({ allow: key === "allow", pattern: normalizeRobotsPath(value), line: lineNumber, text: raw.trim().slice(0, 1200) });
        return;
      }
      case "crawl-delay": {
        result.recognized++;
        if (!group) return;
        groupHasMembers = true;
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0 && group.crawlDelay === null) group.crawlDelay = seconds;
        return;
      }
      case "sitemap": {
        result.recognized++;
        if (result.sitemaps.length < 50 && /^https?:\/\//i.test(value)) result.sitemaps.push(value.slice(0, 2048));
        return;
      }
      case "content-signal":
      case "content-usage": {
        result.recognized++;
        if (++preferenceCount > MAX_PREFERENCES) return;
        const parsed = parsePreference(value);
        if (!parsed) return;
        const preference: ContentPreference = {
          kind: key === "content-signal" ? "CONTENT_SIGNAL" : "CONTENT_USAGE",
          scope: group ? group.agents : "FILE",
          path: parsed.path,
          values: parsed.values,
          line: lineNumber,
          text: raw.trim().slice(0, 600),
        };
        if (group) { groupHasMembers = true; group.preferences.push(preference); }
        else result.filePreferences.push(preference);
        return;
      }
      default:
        // Other fields (host, clean-param, noindex, request-rate…) are not RFC 9309 rules.
        // They do not end a group, and they never change access here.
        if (/^[a-z][a-z0-9-]*$/.test(key)) result.recognized++;
        else result.unrecognized++;
    }
  });
  return result;
}

export type SelectedGroups = { groups: RobotsGroup[]; matched: string | null };

/**
 * The groups that apply to a product token: those that name it, else the "*"
 * groups. A policy token ("__usage_…") never falls back to "*".
 */
export function selectGroups(parsed: ParsedRobots, token: string): SelectedGroups {
  const wanted = token.toLowerCase();
  const named = parsed.groups.filter(group => group.agents.includes(wanted));
  if (named.length) return { groups: named, matched: wanted };
  if (wanted.startsWith("__")) return { groups: [], matched: null };
  const wildcard = parsed.groups.filter(group => group.agents.includes("*"));
  return wildcard.length ? { groups: wildcard, matched: "*" } : { groups: [], matched: null };
}

export type PathDecision = { allowed: boolean; rule: RobotsRule | null };

/** The longest matching rule across the groups decides; Allow wins a tie; nothing matching allows. */
export function decidePath(groups: RobotsGroup[], target: string): PathDecision {
  if (target === "/robots.txt") return { allowed: true, rule: null };
  let best: RobotsRule | null = null;
  for (const group of groups) {
    for (const rule of group.rules) {
      if (!patternMatches(rule.pattern, target)) continue;
      if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)) best = rule;
    }
  }
  return { allowed: best ? best.allow : true, rule: best };
}

/** Crawl-delay of the first selected group that sets one. */
export function crawlDelayOf(groups: RobotsGroup[]): number | null {
  for (const group of groups) if (group.crawlDelay !== null) return group.crawlDelay;
  return null;
}

/** File-level and selected-group preferences whose optional path matches the target. */
export function preferencesFor(parsed: ParsedRobots, groups: RobotsGroup[], target: string): ContentPreference[] {
  const all = [...parsed.filePreferences, ...groups.flatMap(group => group.preferences)];
  return all.filter(preference => preference.path === null || patternMatches(preference.path, target));
}
