import type { Metadata, Viewport } from "next";
import "./fonts";
import "./globals.css";
import { getI18n } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/client";
import { htmlLanguage } from "@/lib/i18n/shared";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return {
    title: {
      default: "A-Border SEO",
      template: "%s · A-Border SEO",
    },
    description: t("Self-hosted SEO monitoring: GSC, crawl health, Core Web Vitals", "本地 SEO 监测：搜索表现、抓取健康和网页核心指标"),
    applicationName: "A-Border SEO",
    icons: {
      icon: { url: "/brand/a-border-symbol.svg", type: "image/svg+xml", sizes: "any" },
      shortcut: "/favicon.ico?v=a-border-symbol",
    },
  };
}

// Match the navy workspace, including browser chrome and native form controls.
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#080e1c",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { locale } = await getI18n();
  return (
    <html lang={htmlLanguage(locale)} className="dark h-full">
      <body className="h-full font-sans">
        <I18nProvider initialLocale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
