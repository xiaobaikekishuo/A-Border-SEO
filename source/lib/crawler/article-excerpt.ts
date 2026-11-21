/**
 * The main content of a page as HTML: <article> or <main> when present,
 * otherwise <body>, without scripts, styles, navigation, header, footer and
 * forms.
 */
export function mainContentHtml(html: string): string {
  const clean = html.replace(/<(script|style|noscript|template|svg|nav|header|footer|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  return clean.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/i)?.[2] ?? clean.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? clean;
}

/** Bounded, plain-text editorial evidence. It is never treated as executable instructions. */
export function articleExcerpt(html: string) {
  const main = mainContentHtml(html);
  const plain = (value: string) => value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
  const headings = [...main.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi)].map(match => plain(match[1]).slice(0, 300)).filter(Boolean).slice(0, 80);
  const text = plain(main.replace(/<\/(p|div|li|h[1-6])\s*>/gi, "\n"));
  return { articleText: text.slice(0, 12000), articleHeadings: headings };
}
