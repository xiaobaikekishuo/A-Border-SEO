import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));

const { MetaRewritePanel, MetaRewriteResult } = await import("./meta-rewrite-panel");
const { OutreachPanel, OutreachResult } = await import("./outreach-panel");
const { QueryClusterPanel, ClusterResult } = await import("./query-cluster-panel");
const { WeeklyReportToggle } = await import("./weekly-report-toggle");
const { LocalizationDetails, SchemaReviewList } = await import("./tool-results");
const { CodexWorkbench } = await import("./workbench");
import { I18nProvider } from "@/lib/i18n/client";
import type { ToolJob } from "./tool-model";
import type { ToolTasks } from "./tool-panel";

const api = { setNotice() {}, setError() {} } as unknown as ToolTasks;
const base = { title: "t", summary: "Short overview.", contentMarkdown: "c", metaTitle: "", metaDescription: "", changeNotes: [], factChecks: ["Verify against the live page"], internalLinks: [], paragraphEdits: [] };
const job = (kind: string, result: Record<string, unknown>): ToolJob => ({ id: `aw_${kind}`, kind, status: "SUCCEEDED", title: `${kind} task`, createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z", finishedAt: "2026-11-20T00:01:00.000Z", error: null, result: { ...base, ...result } as ToolJob["result"] });

describe("structured task panels", () => {
  it("render their forms before any data arrives", () => {
    const html = [<MetaRewritePanel key="m" siteId="site-1" />, <OutreachPanel key="o" siteId="site-1" />, <QueryClusterPanel key="q" siteId="site-1" />, <WeeklyReportToggle key="w" siteId="site-1" />]
      .map(element => renderToStaticMarkup(element)).join("\n");
    expect(html).toContain("Rewrite titles and descriptions in bulk");
    expect(html).toContain("Turn link prospects into outreach drafts");
    expect(html).toContain("Group search queries and map them to pages");
    expect(html).toContain("Weekly AI action list");
    expect(html).toContain("Drafts only: nothing is sent.");
    expect(html).not.toMatch(/[\u2014\u2015\u2191\u2193\u25b2\u25bc\u2713\u2715]/);
  });

  it("render in Chinese without dashes or text arrows", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh">
      <MetaRewritePanel siteId="site-1" /><OutreachPanel siteId="site-1" /><QueryClusterPanel siteId="site-1" /><WeeklyReportToggle siteId="site-1" />
      <CodexWorkbench siteId="site-1" domain="shop.test" initialData={{ site: { id: "site-1", domain: "shop.test" }, worker: { online: true, lastSeenAt: null }, activeTask: null, pages: [], clusters: [], jobs: [] }} />
    </I18nProvider>);
    expect(html).toContain("批量改写标题和描述");
    expect(html).toContain("本地化改写");
    expect(html).toContain("结构化数据代码");
    expect(html).not.toMatch(/[\u2014\u2015\u2191\u2193\u25b2\u25bc\u2713\u2715]/);
  });

  it("show title rewrites with lengths and warnings", () => {
    const html = renderToStaticMarkup(<MetaRewriteResult api={api} job={job("META_REWRITE", { metaRewrites: [{ pageId: "P1", url: "https://shop.test/cases", currentTitle: "Cases | Shop",
      currentDescription: "Old description", title: "Custom Phone Cases – 50% Off", description: "New description", targetQueries: ["custom phone case"], coveredQueries: [], reason: "CTR 0.2% vs 7%",
      titleUnits: 28, descriptionUnits: 15, titleStatus: "OK", descriptionStatus: "SHORT", warnings: ["UNSUPPORTED_NUMBER"] }] })} />);
    expect(html).toContain("Custom Phone Cases – 50% Off");
    expect(html).toContain("28/60");
    expect(html).toContain("15/160 short");
    expect(html).toContain("Has a number the page does not show");
    expect(html).toContain("Download CSV");
  });

  it("show outreach drafts with their warnings and placeholders", () => {
    const html = renderToStaticMarkup(<OutreachResult api={api} job={job("OUTREACH_EMAILS", { outreachEmails: [{ prospectId: "R1", domain: "blog.example", url: "https://blog.example/r",
      contactUrl: "https://blog.example/contact", subject: "A guide for your list", body: "Hi {{name}}, …", basis: ["pitchAngle: care"], followUp: "Checking in.",
      removedUrls: [], placeholders: ["{{name}}"], warnings: ["MENTIONS_PAYMENT"] }] })} />);
    expect(html).toContain("blog.example");
    expect(html).toContain("A guide for your list");
    expect(html).toContain("Fill in {{name}}");
    expect(html).toContain("Mentions payment");
  });

  it("show clusters with the program's status", () => {
    const review = (status: "GAP" | "SPLIT" | "COVERED", pages: { url: string; share: number }[]) => ({ status, mismatch: false, queries: [{ query: "leather case", clicks: 1, impressions: 100, position: 8 }],
      clicks: 1, impressions: 100, position: 8, pages: pages.map(page => ({ ...page, title: null, impressions: page.share * 100 })), chosenUrl: pages[0]?.url ?? null, ownerUrl: pages[0]?.url ?? null });
    const html = renderToStaticMarkup(<ClusterResult siteId="site-1" api={api} job={job("QUERY_CLUSTERS", {
      queryClusters: [{ name: "Leather cases", intent: "COMMERCIAL", funnel: "MOFU", queryIds: ["Q1"], pageId: "P1", note: "One page" },
        { name: "Care", intent: "INFORMATIONAL", funnel: "TOFU", queryIds: ["Q2"], pageId: null, note: "No page" }],
      clusterReview: [review("SPLIT", [{ url: "https://shop.test/a", share: 0.5 }, { url: "https://shop.test/b", share: 0.5 }]), review("GAP", [])] })} />);
    expect(html).toContain("Split across pages");
    expect(html).toContain("Gap: no page owns it");
    expect(html).toContain("https://shop.test/b · 50%");
    expect(html).toContain("Loading the content plan");
  });

  it("show localization terms and the program's hreflang tags, and checked structured data", () => {
    const local = renderToStaticMarkup(<LocalizationDetails siteId="site-1" onCopy={() => {}} result={{ localKeywords: [{ keyword: "Handyhülle", intent: "COMMERCIAL", use: "title", note: "n" }],
      hreflang: { code: "de-DE", sourceUrl: "https://shop.test/a", sourceCode: "en-US", sourceCodeGuessed: true, targetUrl: null,
        tags: [{ hreflang: "de-DE", href: "{localized-url}" }], html: '<link rel="alternate" hreflang="de-DE" href="{localized-url}" />', notes: ["SOURCE_CODE_GUESSED", "TARGET_URL_PLACEHOLDER"] } }} />);
    expect(local).toContain("Handyhülle");
    expect(local).toContain("hreflang=&quot;de-DE&quot;");
    expect(local).toContain("Replace {localized-url}");
    const schema = renderToStaticMarkup(<SchemaReviewList onCopy={() => {}} reviews={[
      { type: "Product", status: "NEEDS_INPUT", code: "{}", html: "<script type=\"application/ld+json\">{}</script>", removed: [{ path: "$.offers.price", reason: "NOT_ON_PAGE" }], needs: [{ property: "offers", reason: "PRODUCT_NEEDS_OFFER" }], error: null },
      { type: "BreadcrumbList", status: "REJECTED", code: "", html: "", removed: [], needs: [], error: "INVALID_JSON" },
    ]} />);
    expect(schema).toContain("Needs input");
    expect(schema).toContain("a product result needs a price, a review or a rating");
    expect(schema).toContain("The code is not valid JSON.");
  });

  it("give each panel an anchor, and open a task a link points at", () => {
    const html = renderToStaticMarkup(<><MetaRewritePanel siteId="site-1" initialJobId="aw_9" /><OutreachPanel siteId="site-1" /><QueryClusterPanel siteId="site-1" /></>);
    expect(html).toContain('id="ai-meta-rewrite"');
    expect(html).toContain('id="ai-outreach-emails"');
    expect(html).toContain('id="ai-query-clusters"');
    const task = (id: string, title: string) => ({ id, kind: "SCHEMA_MARKUP" as const, status: "SUCCEEDED" as const, title, createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z",
      startedAt: null, finishedAt: "2026-11-20T00:01:00.000Z", error: null, draftText: null, result: null });
    const data = { site: { id: "site-1", domain: "shop.test" }, worker: { online: true, lastSeenAt: null }, activeTask: null, pages: [], clusters: [],
      jobs: [task("aw_new", "Newest task"), task("aw_old", "Linked older task")] };
    const linked = renderToStaticMarkup(<CodexWorkbench siteId="site-1" domain="shop.test" initialData={data} initialJobId="aw_old" />);
    expect(linked).toContain('id="workbench-results"');
    expect(linked).toContain("<h3>Linked older task</h3>");
    expect(linked).not.toContain("<h3>Newest task</h3>");
  });

  it("offers localization and structured data in the workbench", () => {
    const html = renderToStaticMarkup(<CodexWorkbench siteId="site-1" domain="shop.test" initialData={{ site: { id: "site-1", domain: "shop.test" }, worker: { online: true, lastSeenAt: null },
      activeTask: null, pages: [], clusters: [], jobs: [] }} />);
    expect(html).toContain("Localize for a market");
    expect(html).toContain("Structured data code");
  });
});
