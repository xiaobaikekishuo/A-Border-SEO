/*
 * Tag and attribute readers shared by the crawler's HTML checks
 * (lib/crawler/engine.ts, lib/crawler/mixed-content.ts). Moved out of
 * engine.ts unchanged so the checks can be tested without a database.
 */

/*
 * HTML5 allows three attribute value syntaxes: "double quoted", 'single
 * quoted', and unquoted. Minifiers drop the quotes whenever the value has no
 * spaces, so a real page can serve `<meta content="Some text" name=description>`
 * (`content` keeps its quotes because the value has spaces, `name` loses them).
 * A pattern that only knows the quoted form reports that tag as missing.
 *
 * One attribute: a name, optionally followed by a value in any of the three
 * syntaxes HTML5 allows: "double quoted", 'single quoted', or unquoted. An
 * unquoted value ends only at whitespace or `>`, so query strings survive
 * (`href=/search?q=shoes&page=2`).
 */
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

/** Strips the surrounding quotes from a raw attribute value, if any. */
function unquote(raw: string): string {
  const q = raw[0];
  return (q === '"' || q === "'") && raw.length > 1 && raw.endsWith(q)
    ? raw.slice(1, -1)
    : raw;
}

/**
 * Attributes of one tag, lower-cased names, first occurrence winning (browsers
 * ignore later duplicates).
 *
 * Parsed positionally in a single pass rather than searched for by name: a
 * name search matches text inside ANOTHER attribute's value, so
 * `<a onclick="go('href=/tracker')" href="/real">` would yield `/tracker`.
 * Accepts a whole tag or a bare attribute list.
 */
export function parseAttrs(tag: string): Map<string, string> {
  const body = tag.replace(/^<[^\s/>]*/, "").replace(/\/?>$/, "");
  const out = new Map<string, string>();
  for (const m of body.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] === undefined ? "" : unquote(m[2]));
  }
  return out;
}

/**
 * Every `<tag …>` in the document. The alternation lets a quoted value contain
 * `>`, which is legal (`<meta content="Before > After" …>`); a plain `[^>]*`
 * envelope would cut the tag in half there and lose the later attributes.
 */
export function tagsNamed(html: string, tag: string): string[] {
  return html.match(new RegExp(`<${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi")) ?? [];
}
