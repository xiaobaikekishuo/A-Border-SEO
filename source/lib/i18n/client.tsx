"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTranslator, htmlLanguage, localeCookie, type Locale, type Translator } from "./shared";

type I18nContextValue = { locale: Locale; t: Translator; setLocale: (locale: Locale) => void; pending: boolean };

// Standalone components keep their original English fallback. The application
// always supplies the request locale, which defaults to Chinese.
const I18nContext = createContext<I18nContextValue>({
  locale: "en", t: createTranslator("en"), setLocale: () => {}, pending: false,
});

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: React.ReactNode }) {
  const router = useRouter();
  const [locale, setCurrentLocale] = useState(initialLocale);
  const [pending, startTransition] = useTransition();
  useEffect(() => { setCurrentLocale(initialLocale); }, [initialLocale]);
  useEffect(() => { document.documentElement.lang = htmlLanguage(locale); }, [locale]);
  const setLocale = useCallback((nextLocale: Locale) => {
    document.cookie = localeCookie(nextLocale, window.location.protocol === "https:");
    setCurrentLocale(nextLocale);
    // Refresh server-rendered pages as well as client controls. URL and data stay intact.
    startTransition(() => { router.refresh(); });
  }, [router]);
  const value = useMemo(() => ({ locale, t: createTranslator(locale), setLocale, pending }), [locale, setLocale, pending]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() { return useContext(I18nContext); }
