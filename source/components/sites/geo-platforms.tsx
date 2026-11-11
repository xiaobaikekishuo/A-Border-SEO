"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, ShieldCheck } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n/shared";
import type { DirectiveReason } from "@/lib/geo/directives";
import { geoPlatform, UNPROBED_CRAWLERS } from "@/lib/geo/platforms";
import type { AccessToken, LayerState, PlatformOverview, PlatformStatus } from "@/lib/geo/platform-overview";
import type { ProbeVerdict } from "@/lib/geo/probe-rules";
import { geoErrorMessage } from "./geo-errors";
import { onGeoUpdate } from "./geo-events";

type Props = { siteId: string };

const DOT: Record<LayerState, string> = {
  GOOD: "bg-success",
  WARN: "bg-warning",
  BAD: "bg-danger",
  UNKNOWN: "bg-text-faint",
  NA: "bg-transparent border border-border",
};

const number = (value: number) => value.toLocaleString();
const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

export function stateLabel(state: LayerState, t: Translator): string {
  return {
    GOOD: t("Good", "良好"),
    WARN: t("Check", "需关注"),
    BAD: t("Problem", "有问题"),
    UNKNOWN: t("No data", "无数据"),
    NA: t("Not applicable", "不适用"),
  }[state];
}

function reasonLabel(reason: DirectiveReason, t: Translator): string {
  return {
    NOINDEX: t("noindex", "noindex（不索引）"),
    NOSNIPPET: t("nosnippet", "nosnippet（不显示摘要）"),
    MAX_SNIPPET_ZERO: t("max-snippet:0", "max-snippet:0"),
    MAX_SNIPPET_SHORT: t("max-snippet under 50", "max-snippet 小于 50"),
    DATA_NOSNIPPET: t("data-nosnippet sections", "含 data-nosnippet 片段"),
    NOARCHIVE: t("noarchive", "noarchive（Copilot 不使用）"),
    NOCACHE: t("nocache (URL, title and snippet only)", "nocache（仅用网址、标题和摘要）"),
    AI_GROUNDING_DISALLOW: t("ai-grounding:disallow", "ai-grounding:disallow"),
    NOINDEX_UNDOCUMENTED: t("noindex (effect on this platform undocumented)", "noindex（对该平台的作用未公开说明）"),
  }[reason];
}

function verdictLabel(verdict: ProbeVerdict | null, t: Translator): string {
  if (!verdict) return t("Not checked", "未检查");
  return {
    OK: t("Served", "正常返回"),
    BLOCKED_FOR_BOT: t("Refused to this crawler", "拒绝该爬虫"),
    BLOCKED_FOR_ALL: t("Refused to this server too", "本服务器也被拒绝"),
    ERROR: t("No answer", "无响应"),
  }[verdict];
}

function robotsLabel(robots: AccessToken["robots"], t: Translator): string {
  if (!robots) return t("Not checked", "未检查");
  return {
    ALLOWED: t("Allowed", "允许"),
    BLOCKED: t("Blocked", "禁止"),
    UNKNOWN: t("robots.txt unreadable", "robots.txt 无法读取"),
    NOT_APPLICABLE: t("Not applicable", "不适用"),
    NO_PREFERENCE: t("No rule", "无规则"),
  }[robots];
}

function roleLabel(role: AccessToken["role"], t: Translator): string {
  return { INDEX: t("Search index", "搜索索引"), USER: t("User fetch", "用户请求抓取"), TRAINING: t("Training", "模型训练"), CONTROL: t("Control token", "控制标记") }[role];
}

function accessText(layer: PlatformStatus["access"], t: Translator): string {
  if (layer.state === "NA") return t("No documented crawler", "无公开的爬虫");
  if (layer.state === "UNKNOWN") return t("Run the access check", "运行访问检查");
  const serving = layer.tokens.filter(x => x.role !== "TRAINING");
  const blocked = serving.filter(x => x.robots === "BLOCKED").map(x => x.token);
  if (blocked.length) return t("robots.txt blocks {list}", "robots.txt 禁止 {list}", { list: blocked.join(", ") });
  const refused = serving.filter(x => x.live === "BLOCKED_FOR_BOT").map(x => x.token);
  if (refused.length) return t("Refused to {list}", "拒绝了 {list}", { list: refused.join(", ") });
  if (layer.state === "WARN") return t("Partly unclear", "部分无法确认");
  const training = layer.tokens.filter(x => x.role === "TRAINING" && x.robots === "BLOCKED");
  return training.length ? t("Allowed (training blocked)", "允许（已禁训练）") : t("Allowed", "允许");
}

function eligibilityText(layer: PlatformStatus["eligibility"], t: Translator): string {
  const s = layer.summary;
  if (!s || !s.pages) return t("Crawl the site", "先抓取网站");
  const parts = [t("{ok}/{pages} usable", "{ok}/{pages} 页可用", { ok: number(s.ok), pages: number(s.pages) })];
  if (s.excluded) parts.push(t("{n} excluded", "{n} 页被排除", { n: number(s.excluded) }));
  if (s.limited) parts.push(t("{n} limited", "{n} 页受限", { n: number(s.limited) }));
  return parts.join(" · ");
}

function indexText(layer: PlatformStatus["index"], t: Translator): string {
  if (layer.kind === null) return t("No public index data", "无公开的索引数据");
  if (layer.kind === "GOOGLE") {
    return layer.pages === null ? t("Connect Search Console", "连接 Search Console")
      : t("{n} pages with impressions (28 days)", "{n} 页有展示（近 28 天）", { n: number(layer.pages) });
  }
  return layer.pages === null ? t("Connect Bing Webmaster Tools", "连接 Bing 网站管理员工具")
    : t("{n} pages in the Bing index", "Bing 索引 {n} 页", { n: number(layer.pages) });
}

function reportText(layer: PlatformStatus["report"], t: Translator): string {
  if (!layer.kind) return t("The platform has no site report", "平台未提供站点报表");
  if (layer.total === null) return t("Import the report", "导入报表");
  const period = layer.start && layer.end ? ` · ${layer.start} – ${layer.end}` : "";
  return (layer.kind === "GSC_AI"
    ? t("{n} impressions", "{n} 次展示", { n: number(layer.total) })
    : t("{n} citations", "{n} 次引用", { n: number(layer.total) })) + period;
}

function answersText(layer: PlatformStatus["answers"], t: Translator): string {
  const v = layer.visibility;
  if (!v || !v.answers) {
    if (v?.failed) return t("{n} attempts failed; see prompt tracking", "{n} 次查询失败，见提示词跟踪", { n: v.failed });
    if (layer.source === "MANUAL") return t("Record answers by hand", "手动记录回答");
    return layer.tracked ? t("No answers yet", "尚无回答") : t("Not tracked", "未跟踪");
  }
  return t("Mentioned {m} · cited {c} ({n} answers)", "提及 {m} · 引用 {c}（{n} 个回答）", { m: percent(v.mentionRate), c: percent(v.citationRate), n: v.answers });
}

function trafficText(layer: PlatformStatus["traffic"], t: Translator): string {
  if (layer.state === "NA") return "—";
  if (layer.referrals === null && layer.crawlerRequests === null) return t("Import GA4 or access logs", "导入 GA4 或访问日志");
  const parts: string[] = [];
  if (layer.referrals !== null) parts.push(t("{n} sessions", "{n} 次会话", { n: number(layer.referrals) }));
  if (layer.crawlerRequests !== null) parts.push(t("{n} crawler requests", "{n} 次爬虫请求", { n: number(layer.crawlerRequests) }));
  return parts.join(" · ");
}

function Cell({ state, text, t }: { state: LayerState; text: string; t: Translator }) {
  return <td className="px-3 py-2 align-top">
    <div className="flex items-start gap-2" title={stateLabel(state, t)}>
      <span className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${DOT[state]}`} aria-hidden />
      <span className={state === "NA" || state === "UNKNOWN" ? "text-muted-foreground" : ""}>{text}</span>
      <span className="sr-only">{stateLabel(state, t)}</span>
    </div>
  </td>;
}

function Details({ status, t, locale }: { status: PlatformStatus; t: Translator; locale: string }) {
  const platform = geoPlatform(status.id);
  const eligibility = status.eligibility.summary;
  const visibility = status.answers.visibility;
  return <div className="space-y-4 px-3 pb-4 pt-1 text-sm">
    {platform && <p className="text-muted-foreground">{locale === "zh" ? platform.note.zh : platform.note.en}</p>}
    {status.access.tokens.length > 0 && <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-xs">
        <thead className="text-muted-foreground"><tr>
          <th className="py-1 pr-3 font-medium">{t("Token", "标识")}</th>
          <th className="py-1 pr-3 font-medium">{t("Role", "用途")}</th>
          <th className="py-1 pr-3 font-medium">robots.txt</th>
          <th className="py-1 pr-3 font-medium">{t("Live request", "实测请求")}</th>
        </tr></thead>
        <tbody>{status.access.tokens.map(token => <tr key={token.token} className="border-t border-border">
          <td className="py-1 pr-3 font-mono">{token.token}</td>
          <td className="py-1 pr-3">{roleLabel(token.role, t)}</td>
          <td className="py-1 pr-3">{robotsLabel(token.robots, t)}{token.rule ? <span className="ml-1 font-mono text-muted-foreground">{token.rule}</span> : null}</td>
          <td className="py-1 pr-3">{token.role === "CONTROL" ? "—" : UNPROBED_CRAWLERS.includes(token.token) ? t("Not imitated (see Search Console or Bing)", "不模拟（以 Search Console 或 Bing 为准）") : verdictLabel(token.live, t)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {eligibility && eligibility.pages > 0 && (eligibility.excluded > 0 || eligibility.limited > 0) && <div>
      <div className="font-medium">{t("Page directives", "页面指令")}</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">{(Object.entries(eligibility.reasons) as [DirectiveReason, number][]).map(([reason, count]) =>
        <li key={reason}>{reasonLabel(reason, t)}: {number(count)}</li>)}</ul>
      {eligibility.examples.length > 0 && <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">{eligibility.examples.map(example =>
        <li key={example.url} className="truncate"><span className="font-mono">{example.url}</span> · {example.reasons.map(r => reasonLabel(r, t)).join(", ")}</li>)}</ul>}
    </div>}
    {eligibility && !eligibility.complete && <p className="text-xs text-muted-foreground">{t("Some pages come from a crawl that did not record every directive. Run a new crawl for a full check.", "部分页面来自未记录全部指令的旧抓取，重新抓取一次可完整检查。")}</p>}
    {visibility && visibility.answers > 0 && <div className="grid gap-3 md:grid-cols-2">
      <div>
        <div className="font-medium">{t("Brands named", "被提及的品牌")}</div>
        <ul className="mt-1 space-y-0.5">{visibility.competitors.slice(0, 6).map(c => <li key={c.name}>{c.name}: {t("named in {m}, cited in {c}", "提及 {m} 个，引用 {c} 个", { m: c.mentioned, c: c.cited })}</li>)}
          {!visibility.competitors.length && <li className="text-muted-foreground">{t("No competitor named", "未提及竞品")}</li>}</ul>
      </div>
      <div>
        <div className="font-medium">{t("Most cited domains", "被引用最多的域名")}</div>
        <ul className="mt-1 space-y-0.5">{visibility.topDomains.slice(0, 6).map(d => <li key={d.domain} className={d.own ? "font-medium" : ""}>{d.domain} · {d.count}</li>)}</ul>
      </div>
    </div>}
  </div>;
}

export default function GeoPlatforms({ siteId }: Props) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<PlatformOverview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"load" | "probe" | null>("load");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy("load");
    setError("");
    try {
      const res = await fetch(`/api/sites/${siteId}/geo/platforms`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((typeof body?.error === "string" ? geoErrorMessage(body.error, t) : t("Could not load the platform overview.", "无法加载平台概览。")));
      setData(body as PlatformOverview);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [siteId, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => onGeoUpdate(() => void load()), [load]);

  async function probe() {
    setBusy("probe");
    setError("");
    try {
      const res = await fetch(`/api/sites/${siteId}/geo/probe`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((typeof body?.error === "string" ? geoErrorMessage(body.error, t) : t("The access check failed.", "访问检查失败。")));
      setData(body as PlatformOverview);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return <section className="panel space-y-4 p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-semibold">{t("AI platforms", "各 AI 平台 GEO 情况")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("Each platform on six layers: can its crawlers reach the site, do page directives let it use the pages, is the site in the index it answers from, the platform's own AI report, how often its answers name or cite the site, and the visits and crawler requests it brings.", "按六层查看每个平台：爬虫能否访问、页面指令是否允许使用、网站是否在其依赖的索引中、平台自己的 AI 报表、回答中提及或引用网站的比例，以及带来的访问和爬虫请求。")}</p>
      </div>
      <div className="flex gap-2">
        <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50" onClick={() => void load()} disabled={busy !== null}>
          <RefreshCw size={14} className={busy === "load" ? "animate-spin" : ""} />{t("Refresh", "刷新")}
        </button>
        <button type="button" className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50" onClick={() => void probe()} disabled={busy !== null}>
          <ShieldCheck size={14} className={busy === "probe" ? "animate-pulse" : ""} />{busy === "probe" ? t("Checking…", "检查中…") : t("Run access check", "运行访问检查")}
        </button>
      </div>
    </div>
    {error && <p className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
    {data && <>
      <p className="text-xs text-muted-foreground">
        {data.probe
          ? t("Access check {at}{cdn}. It requests {n} page(s) with each AI crawler's user agent from this server; CDNs that verify crawlers by IP address can treat real crawlers differently, so a refusal here is a lead, not proof. Googlebot and Bingbot are not imitated: firewalls block or ban fake ones, and Search Console and Bing report on the real ones.", "访问检查于 {at}{cdn}。从本服务器以各 AI 爬虫的 UA 请求 {n} 个页面；按 IP 验证爬虫的 CDN 对真实爬虫的处理可能不同，所以这里的拒绝只是线索，不是定论。不模拟 Googlebot 和 Bingbot：防火墙会拦截甚至暂时封禁冒充者，真实情况以 Search Console 和 Bing 为准。", { at: new Date(data.probe.checkedAt).toLocaleString(), cdn: data.probe.cdn ? ` · CDN: ${data.probe.cdn}` : "", n: data.probe.urls.length })
          : t("The access check has not run yet. It requests the home page and one top page as each AI crawler would (about 20 requests), and reads robots.txt.", "尚未运行访问检查。它会以各 AI 爬虫的身份请求首页和一个热门页面（约 20 个请求），并读取 robots.txt。")}
        {data.crawl ? " " + t("Directives from the crawl of {at} ({n} pages).", "页面指令来自 {at} 的抓取（{n} 页）。", { at: data.crawl.finishedAt ? new Date(data.crawl.finishedAt).toLocaleDateString() : "—", n: data.crawl.pages }) : ""}
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground"><tr>
            <th className="px-3 py-2 font-medium">{t("Platform", "平台")}</th>
            <th className="px-3 py-2 font-medium">{t("Access", "访问")}</th>
            <th className="px-3 py-2 font-medium">{t("Page directives", "页面指令")}</th>
            <th className="px-3 py-2 font-medium">{t("Index", "索引")}</th>
            <th className="px-3 py-2 font-medium">{t("AI report", "AI 报表")}</th>
            <th className="px-3 py-2 font-medium">{t("Answers", "回答")}</th>
            <th className="px-3 py-2 font-medium">{t("Traffic", "流量")}</th>
          </tr></thead>
          <tbody>{data.platforms.map(status => {
            const platform = geoPlatform(status.id);
            const expanded = open === status.id;
            return <Fragment key={status.id}>
              <tr className="cursor-pointer border-t border-border hover:bg-muted/30" onClick={() => setOpen(expanded ? null : status.id)}>
                <td className="px-3 py-2 align-top">
                  <button type="button" className="flex items-center gap-1 text-left font-medium" aria-expanded={expanded}>
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {platform ? (locale === "zh" ? platform.nameZh : platform.name) : status.id}
                  </button>
                  <div className="pl-5 text-xs text-muted-foreground">{platform?.vendor}</div>
                </td>
                <Cell state={status.access.state} text={accessText(status.access, t)} t={t} />
                <Cell state={status.eligibility.state} text={eligibilityText(status.eligibility, t)} t={t} />
                <Cell state={status.index.state} text={indexText(status.index, t)} t={t} />
                <Cell state={status.report.state} text={reportText(status.report, t)} t={t} />
                <Cell state={status.answers.state} text={answersText(status.answers, t)} t={t} />
                <Cell state={status.traffic.state} text={trafficText(status.traffic, t)} t={t} />
              </tr>
              {expanded && <tr className="bg-muted/20"><td colSpan={7}><Details status={status} t={t} locale={locale} /></td></tr>}
            </Fragment>;
          })}</tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {(["GOOD", "WARN", "BAD", "UNKNOWN", "NA"] as LayerState[]).map(state => <span key={state} className="inline-flex items-center gap-1.5"><span className={`inline-block size-2 rounded-full ${DOT[state]}`} />{stateLabel(state, t)}</span>)}
      </div>
    </>}
    {!data && busy === "load" && <p className="text-sm text-muted-foreground">{t("Loading…", "加载中…")}</p>}
  </section>;
}
