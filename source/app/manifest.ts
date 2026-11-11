import type { MetadataRoute } from "next";
import { getI18n } from "@/lib/i18n/server";
import { htmlLanguage } from "@/lib/i18n/shared";

// Published A-Border artwork is bundled locally, including installed-app icons.
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { locale, t } = await getI18n();
  return {
    name: "A-Border SEO",
    short_name: "A-Border",
    description: t("Self-hosted SEO monitoring: GSC, crawl health, Core Web Vitals", "本地 SEO 监测：搜索表现、抓取健康和网页核心指标"),
    lang: htmlLanguage(locale),
    start_url: "/sites",
    display: "standalone",
    theme_color: "#080e1c",
    background_color: "#080e1c",
    icons: [
      { src: "/brand/a-border-symbol.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/brand/a-border-symbol-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/a-border-symbol-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
