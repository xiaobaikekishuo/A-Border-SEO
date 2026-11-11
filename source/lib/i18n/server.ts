import { cookies } from "next/headers";
import { createTranslator, LOCALE_COOKIE, normalizeLocale } from "./shared";

export async function getI18n() {
  const locale = normalizeLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return { locale, t: createTranslator(locale) };
}
