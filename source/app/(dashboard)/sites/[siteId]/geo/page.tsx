import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getI18n } from "@/lib/i18n/server";
import { getReadiness } from "@/lib/geo/readiness";
import type { GeoCheckKey } from "@/lib/geo/readiness-rules";
import { PageHeader } from "@/components/ui/page-header";
import GeoObservations from "@/components/sites/geo-observations";
import GeoPlatforms from "@/components/sites/geo-platforms";
import GeoReports from "@/components/sites/geo-reports";
import GeoTracking from "@/components/sites/geo-tracking";

export default async function GeoPage({params}:{params:Promise<{siteId:string}>}) {
  const {siteId} = await params;
  const userId = (await auth())?.user?.id;
  if (!userId) redirect("/login");
  const site = await db.site.findFirst({where:{id:siteId,userId},select:{domain:true}});
  if (!site) redirect("/sites");
  const [{t}, readiness] = await Promise.all([getI18n(), getReadiness(db,siteId)]);
  const googleId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const oauthClientId = /^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(googleId) ? googleId : undefined;
  const labels: Record<GeoCheckKey, { name: string; help: string }> = {
    SNIPPET: { name: t("Title and description", "标题与描述"), help: t("Both a title and a meta description are set.", "同时设置了标题和描述。") },
    HEADING: { name: t("Main heading", "H1 主标题"), help: t("The page has an H1.", "页面有 H1。") },
    TEXT: { name: t("Substantive text", "足量正文"), help: t("At least 250 words of main text (each Chinese character counts as one).", "正文至少 250 个词（中文按字计）。") },
    SECTIONS: { name: t("Sectioned content", "分节结构"), help: t("The H1 plus at least two subheadings.", "除 H1 外至少还有两个小标题。") },
    QUESTIONS: { name: t("Question headings (articles)", "问题式小标题（文章）"), help: t("Article pages have at least one heading phrased as a question.", "文章页至少有一个以问题形式写的小标题。") },
    FACTS: { name: t("Concrete figures", "具体数据"), help: t("The main text has at least two figures with units, prices, percentages or years.", "正文至少有两处带单位、价格、百分比或年份的数据。") },
    SCHEMA: { name: t("Valid structured data", "有效结构化数据"), help: t("JSON-LD parses with no errors.", "JSON-LD 可解析且没有错误。") },
    AUTHORSHIP: { name: t("Author and date (articles)", "作者与日期（文章）"), help: t("Article markup names an author and a publication or update date.", "文章标记中写明了作者和发布或更新日期。") },
    LINKS: { name: t("Internal links", "站内链接"), help: t("The page links to other pages of the site.", "页面链接到站内其他页面。") },
  };
  return <main className="space-y-5">
    <PageHeader title={t("GEO monitoring","GEO 监测")} meta={site.domain}
      description={t("See how each AI platform can reach, use, answer with and send visitors from the site.","查看各 AI 平台能否访问和使用网站、回答中是否提及或引用网站，以及带来的访问。")}
      actions={<Link className="text-sm text-link" href={`/sites/${siteId}/ai-access`}>{t("Check crawler rules","检查爬虫规则")} →</Link>} />
    <GeoPlatforms key={`platforms-${siteId}`} siteId={siteId}/>
    <GeoTracking key={`tracking-${siteId}`} siteId={siteId} domain={site.domain}/>
    <GeoReports key={`reports-${siteId}`} siteId={siteId} domain={site.domain}/>
    <GeoObservations key={siteId} siteId={siteId} domain={site.domain} oauthClientId={oauthClientId}/>
    <section className="panel space-y-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{t("GEO technical readiness","GEO 技术准备度")} <span className="ml-1 rounded border border-border px-1.5 py-0.5 align-middle text-[11px] font-normal text-muted-foreground">v{readiness?.version ?? 2}</span></h2>
        <strong className="text-xl">{readiness?.score != null ? `${readiness.score}/100` : t("Awaiting evidence","待采集")}</strong>
      </div>
      <p className="text-sm text-muted-foreground">{t("A local checklist over crawled, indexable HTTP 200 pages from the latest completed crawl. Pages with the most Search Console impressions in the last 28 days come first (up to 200), then other pages by URL, up to 300. Checks that do not apply to a page, or that an older crawl cannot judge, are left out. The score is the share of applicable checks passed. It points to pages to improve; it does not predict AI citations or rankings.","本地自查，使用最近一次完成抓取中返回 HTTP 200 且允许索引的页面：先取近 28 天 GSC 曝光最高的页面（最多 200 页），再按网址补足，共最多 300 页。对某页不适用、或旧抓取无法判断的检查项不计入。分数是适用检查项的通过比例，用来找出值得改进的页面，不代表 AI 引用或排名。")}</p>
      {readiness?.sampled ? <><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{readiness.checks.map(check => <div key={check.key} className="rounded-lg border border-border p-3" title={labels[check.key].help}><div className="text-sm text-muted-foreground">{labels[check.key].name}</div><strong>{check.applicable ? `${check.passed} / ${check.applicable}` : t("Not judged", "未判断")}</strong><div className="mt-1 text-xs text-muted-foreground">{labels[check.key].help}</div></div>)}</div>
      <p className="text-xs text-muted-foreground">{readiness.date} · {t("Sample / eligible pages","样本 / 符合条件的页面")} {readiness.sampled} / {readiness.total} · {readiness.sampling === "GSC_IMPRESSIONS" ? t("{n} pages chosen by GSC impressions", "其中 {n} 页按 GSC 曝光选取", { n: readiness.rankedPages }) : t("No GSC data: ordered by URL", "无 GSC 数据：按网址排序")}</p>
      {readiness.checks.some(check => (check.key === "AUTHORSHIP" || check.key === "SECTIONS") && !check.applicable) && <p className="text-xs text-muted-foreground">{t("Some checks need evidence saved by newer crawls. Run a new crawl to fill them in.", "部分检查需要新版抓取保存的依据，重新抓取一次即可补全。")}</p>}</> :
      <Link href={`/sites/${siteId}/crawl`} className="text-sm text-link">{t("Review crawl coverage","查看抓取记录")} →</Link>}
    </section>
  </main>;
}
