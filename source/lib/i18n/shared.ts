export type Locale = "zh" | "en";
export type TranslationValues = Record<string, string | number>;
export type Translator = (english: string, chinese: string, values?: TranslationValues) => string;

export const LOCALE_COOKIE = "aborder-locale";
export const DEFAULT_LOCALE: Locale = "zh";

export function normalizeLocale(value: unknown): Locale {
  return value === "en" ? "en" : DEFAULT_LOCALE;
}

export function createTranslator(locale: Locale): Translator {
  return (english, chinese, values) => {
    const message = locale === "zh" ? chinese : english;
    if (!values) return message;
    // A single pass keeps braces in user supplied content literal.
    return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key: string) =>
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
    );
  };
}

export function localeCookie(locale: Locale, secure = false): string {
  return `${LOCALE_COOKIE}=${normalizeLocale(locale)}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function htmlLanguage(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en";
}
