/*
 * Text measures that work for Chinese, Japanese and Korean as well as for
 * languages that put spaces between words.
 *
 * Splitting on whitespace counts a whole paragraph of Chinese as one "word",
 * so a 2,000-character article read as thin content. Here every CJK
 * character counts as one unit (the way Chinese word counts are usually
 * given: 字数), and other text counts by words.
 *
 * For lengths that a search result truncates by width (titles,
 * descriptions), a CJK or other full-width character takes about the room of
 * two Latin letters, so it counts two.
 */

/** Han (with extension A and the compatibility block), Hiragana, Katakana, Hangul syllables, and Han extensions B and later. */
const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯\u{20000}-\u{3134f}]/gu;

/** CJK characters, counted one each. */
export function cjkCount(text: string): number {
  return text.match(CJK)?.length ?? 0;
}

/**
 * Words plus CJK characters. A "word" is a whitespace-separated run with at
 * least one letter or digit, so stray punctuation does not count.
 */
export function contentUnits(text: string): number {
  if (!text) return 0;
  const cjk = cjkCount(text);
  const words = text.replace(CJK, " ").split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
  return cjk + words;
}

/** East Asian Wide and Fullwidth ranges (UAX #11), plus the common emoji blocks, which also render two columns wide. */
const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];
/** Combining marks and zero-width characters take no room of their own. */
const ZERO: readonly [number, number][] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
];

function inRanges(code: number, ranges: readonly [number, number][]): boolean {
  for (const [from, to] of ranges) {
    if (code < from) return false;
    if (code <= to) return true;
  }
  return false;
}

/**
 * Approximate display width: 2 for each wide or full-width character, 0 for
 * combining and zero-width marks, 1 for everything else. A 30-character
 * Chinese title measures 60, about the same room as a 60-letter English one.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (inRanges(code, ZERO)) continue;
    width += inRanges(code, WIDE) ? 2 : 1;
  }
  return width;
}

/** Title and description lengths the content score and the remediation text use, in display width. */
export const SNIPPET_WIDTH = {
  title: { min: 15, max: 65 },
  description: { min: 50, max: 160 },
} as const;

export function withinWidth(text: string | null | undefined, range: { min: number; max: number }): boolean {
  if (!text) return false;
  const width = displayWidth(text);
  return width >= range.min && width <= range.max;
}
