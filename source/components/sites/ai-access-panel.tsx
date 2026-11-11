"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, ExternalLink, FileSearch, Info, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { PageHeader } from "@/components/ui/page-header";
import type { AiAccessReport } from "@/lib/seo/ai-access-types";
import type { Translator } from "@/lib/i18n/shared";
import s from "./ai-access-panel.module.css";

export function AiAccessPanel({ siteId, domain, initialUrl }: { siteId: string; domain: string; initialUrl: string }) {
  const { t } = useI18n();
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<AiAccessReport | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function inspect(event: FormEvent) {
    event.preventDefault();
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller; setBusy(true); setError(null); setReport(null);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/ai-access`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }), signal: controller.signal, cache: "no-store",
      });
      if (!response.ok) {
        if (response.status === 401) throw new Error(t("Sign in to A-Border SEO again.", "请重新登录 A-Border SEO。"));
        if (response.status === 403 || response.status === 404) throw new Error(t("This site is not available to this session. Refresh the page and check the selected site.", "当前登录无法访问此站点，请刷新页面并检查所选站点。"));
        if (response.status === 400 || response.status === 422) throw new Error(t("Enter a full public HTTP or HTTPS URL belonging to this site.", "请填写属于当前站点的完整、公开 HTTP 或 HTTPS 网址。"));
        if (response.status === 429) throw new Error(t("A check is already running or the request limit was reached. Try again shortly.", "检查仍在运行或已达到请求限制，请稍后再试。"));
        throw new Error(t("The check could not finish. Try again after checking the local service and network.", "检查未完成，请检查本机服务及网络后重试。"));
      }
      const value = await response.json() as AiAccessReport;
      if (value.siteId !== siteId || !Array.isArray(value.bots)) throw new Error(t("The result does not match the selected site. Reload and retry.", "结果与所选站点不匹配，请刷新后重试。"));
      if (!controller.signal.aborted) setReport(value);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("Check failed.", "检查失败。"));
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <div>
    <PageHeader title={t("AI crawler access", "AI 爬虫访问")} meta={domain}
      description={t("Understand your declared crawling rules for AI search, training and user-requested visits, read per RFC 9309.", "按 RFC 9309 规则，分别检查 AI 搜索、训练与用户即时访问所对应的抓取规则。")} />
    <section className={`panel ${s.panel}`}>
      <div className={s.heading}><FileSearch size={22} /><div><h2>{t("Check one page's access rules", "检查一个页面的访问规则")}</h2><p>{t("The check reads this site's public robots.txt. Page signals come from your saved crawl.", "检查会读取本站公开的 robots.txt；页面状态与索引指令使用本地已保存的抓取记录。")}</p></div></div>
      <form className={s.form} onSubmit={inspect}>
        <label><span>{t("Page URL", "页面网址")}</span><input type="url" required maxLength={2048} value={url} onChange={event => setUrl(event.target.value)} disabled={busy} autoComplete="off" /></label>
        <button type="submit" disabled={busy || !url.trim()}><RefreshCw size={16} className={busy ? "animate-spin" : undefined} />{busy ? t("Checking…", "检查中…") : t("Check access rules", "检查访问规则")}</button>
      </form>
      <p className={s.note}><Info size={16} />{t("This does not use model allowance or change your website. An allowed rule does not prove that an AI service can fetch, index or cite the page.", "本检查不消耗模型额度，也不会修改网站。规则允许，不代表 AI 服务一定能抓取、收录或引用该页面。")}</p>
      {error && <p role="alert" className={s.error}>{error}</p>}
      {busy && <p role="status" className={s.note}>{t("Reading public rules and saved evidence…", "正在读取公开规则和已保存依据…")}</p>}
    </section>
    {report ? <AiAccessResults report={report} /> : !busy && <div className={`panel ${s.empty}`}><Bot size={38} /><h2>{t("Search, training and user visits are different", "搜索、训练、用户访问各有用途")}</h2><p>{t("Run a check to see the declared rule for each bot. You can allow search discovery while making a separate decision about training access.", "点击检查，查看各爬虫对应的规则。搜索发现和训练用途可以分别决策，不能只用一个“AI 已放行”概括。")}</p></div>}
    <section className={`panel ${s.panel}`}><h2>{t("Official bot references", "官方爬虫说明")}</h2><p className={s.note}>{t("Use provider documentation before editing robots.txt. Firewall and CDN rules need separate verification.", "修改 robots.txt 前请参考服务商说明；防火墙和 CDN 放行情况需要另外核实。")}</p><div className={s.links}>
      <a href="https://developers.openai.com/api/docs/bots" target="_blank" rel="noopener noreferrer">OpenAI <ExternalLink size={14} /></a>
      <a href="https://privacy.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler" target="_blank" rel="noopener noreferrer">Anthropic <ExternalLink size={14} /></a>
      <a href="https://docs.perplexity.ai/docs/resources/perplexity-crawlers" target="_blank" rel="noopener noreferrer">Perplexity <ExternalLink size={14} /></a>
      <a href="https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers" target="_blank" rel="noopener noreferrer">Google <ExternalLink size={14} /></a>
    </div></section>
  </div>;
}

export function AiAccessResults({ report }: { report: AiAccessReport }) {
  const { t, locale } = useI18n();
  const date = (value: string) => new Date(value).toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
  const unknown = t("Unknown", "未知");
  const purpose = { SEARCH: t("Search discovery", "搜索发现"), TRAINING: t("Model training", "模型训练"), USER_REQUEST: t("User-requested visit", "用户即时访问") };
  const status = {
    ALLOWED: t("Rules allow", "规则允许"), BLOCKED: t("Rules disallow", "规则禁止"), UNKNOWN: t("Undetermined", "无法判断"),
    NOT_APPLICABLE: t("Robots is not an access guarantee", "不能用 robots 判断"), NO_PREFERENCE: t("No preference declared", "未声明"),
  };
  const training = { ALLOWED: t("Training not refused for this path", "此路径未声明拒绝训练"), BLOCKED: t("Training refused for this path", "此路径已声明拒绝训练"), NO_PREFERENCE: t("No shared training preference", "未声明共享训练偏好"), UNKNOWN: t("Undetermined", "无法判断"), NOT_APPLICABLE: t("Undetermined", "无法判断") };
  const outcome = {
    RULES: t("Read", "已读取"), UNAVAILABLE: t("Unavailable: all allowed", "不可用：视为全部允许"),
    UNREACHABLE: t("Unreachable: all disallowed", "无法访问：视为全部禁止"), UNKNOWN: unknown,
  };
  const groupLabel = (group: string | null) => group === "*" ? t("Group: User-agent *", "使用分组：User-agent *") : group ? t("Group: its own User-agent", "使用分组：自己的 User-agent") : null;
  const tone = (value: AiAccessReport["bots"][number]["robots"]) => value === "BLOCKED" ? s.blocked : value === "ALLOWED" ? s.allowed : s.unknown;
  return <section className={`panel ${s.panel}`} aria-labelledby="ai-access-result-title">
    <div className={s.heading}><Bot size={22} /><div><h2 id="ai-access-result-title">{t("Declared access rules", "规则检查结果")}</h2><p>{date(report.checkedAt)} · {t("Live robots.txt + saved page evidence", "实时 robots.txt + 已保存页面依据")}</p></div></div>
    <p className={s.url}>{report.url}</p>
    <div className={s.facts}>
      <div><span>robots.txt HTTP</span><strong>{report.robots.status ?? unknown}</strong></div>
      <div><span>{t("Rule evidence", "规则依据")}</span><strong>{outcome[report.robots.outcome]}</strong></div>
      <div><span>{t("Saved page HTTP", "已保存页面 HTTP")}</span><strong>{report.page?.statusCode ?? unknown}</strong></div>
    </div>
    <div className={s.tableWrap}><table><caption>{t("Declared rules are not live tests of the provider's crawler.", "以下是声明的规则，不是服务商真实爬虫的连通性测试。")}</caption><thead><tr><th>{t("Bot", "爬虫")}</th><th>{t("Purpose", "用途")}</th><th>{t("Declared policy", "规则判定")}</th><th>{t("Evidence", "依据")}</th></tr></thead><tbody>
      {report.bots.map(bot => <tr key={bot.agent}>
        <td><code>{bot.agent}</code><small>{bot.provider === "Shared" ? t("Shared AI training preference", "共享 AI 训练偏好") : bot.provider}{bot.kind === "CONTROL_TOKEN" && " · " + t("control token, no crawler of its own", "控制标记，没有独立爬虫")}</small></td>
        <td>{purpose[bot.purpose]}</td>
        <td><span className={tone(bot.robots)}>{bot.kind === "POLICY_TOKEN" ? training[bot.robots] : status[bot.robots]}</span></td>
        <td>
          {bot.robots === "NOT_APPLICABLE" && <small>{t("Provider says these user-triggered visits may not follow robots.txt.", "服务商说明：此类用户触发的访问可能不遵循 robots.txt。")}{bot.declared && " " + (bot.declared === "BLOCKED" ? t("The file disallows it.", "文件中的规则为禁止。") : t("The file allows it.", "文件中的规则为允许。"))}</small>}
          {bot.robots === "NO_PREFERENCE" ? <small>{t("No group names this token; \"User-agent: *\" does not apply to it.", "文件中没有以此标记命名的分组；User-agent * 不适用于它。")}</small> : report.robots.outcome !== "RULES" ? <small>{accessNote(report.robots.reason ?? "UNKNOWN", t)}</small> : <>
            {bot.rule ? <code>{bot.rule}</code> : <small>{t("No rule matches this path, so it is allowed.", "没有规则匹配此路径，因此允许。")}</small>}
            {bot.matchedLine !== null && <small>{t("Line {line}", "第 {line} 行", { line: bot.matchedLine })}</small>}
            {groupLabel(bot.group) && <small>{groupLabel(bot.group)}</small>}
            {bot.crawlDelay !== null && <small>Crawl-delay: {bot.crawlDelay}s · {t("Support varies by provider", "是否遵循取决于服务商")}</small>}
          </>}
        </td>
      </tr>)}
    </tbody></table></div>
    {report.robots.reason && <p className={s.note}>{t("Rule check note", "规则检查说明")}：{accessNote(report.robots.reason, t)}</p>}
    <p className={s.note}>{report.robots.finalUrl && report.robots.finalUrl !== report.robots.url ? `${report.robots.url} → ${report.robots.finalUrl}` : report.robots.url} · {report.robots.contentType || t("Content type not recorded", "未记录内容类型")}</p>
    {report.preferences.length > 0 && <div className={s.saved}><h3>{t("Declared content-use preferences", "声明的内容使用偏好")}</h3>
      <p className={s.note}>{accessNote("PREFERENCES_ARE_REQUESTS", t)}</p>
      <dl>{report.preferences.map(preference => <PreferenceRow key={preference.line} preference={preference} />)}</dl>
    </div>}
    <div className={s.saved}><h3>{t("Saved page signals", "已保存页面信号")}</h3>{report.page ? <>
      <p className={s.note}>{t("Captured", "抓取时间")}：{report.page.capturedAt ? date(report.page.capturedAt) : unknown}</p>
      <p>{report.page.indexable === false ? t("The saved crawl observed noindex for general/Google indexing. This does not decide every AI provider's behavior.", "保存的抓取发现面向通用／Google 索引的 noindex，不能据此推断所有 AI 服务的行为。") : report.page.indexable === true ? t("No applicable noindex was observed in the saved crawl. Current indexing is unconfirmed.", "保存的抓取未发现适用的 noindex，当前是否收录仍未确认。") : t("No index-directive evidence is available.", "暂无索引指令依据。")}</p>
      <dl><dt>Meta robots</dt><dd>{report.page.robotsMeta || t("Not recorded", "未记录")}</dd><dt>X-Robots-Tag</dt><dd>{report.page.xRobotsTag || t("Not recorded", "未记录")}</dd></dl>
    </> : <p className={s.note}>{t("This URL has no saved page evidence in the latest completed crawl. Run a crawl if page-level evidence is needed.", "最近完成的抓取没有保存此网址的页面依据，需要页面级信息时请先抓取。")}</p>}</div>
    {report.warnings.length > 0 && <details className={s.details}><summary>{t("Scope and limitations", "检查范围与限制")}</summary><ul>{report.warnings.map((warning, index) => <li key={index}>{accessNote(warning, t)}</li>)}</ul></details>}
    <p className={s.note}>{t("Only this URL's robots policy is evaluated. No provider IP request, firewall test, search index check or citation lookup was performed. No health score is assigned.", "仅判断此网址对应的 robots 规则，未模拟服务商 IP、测试防火墙、查询搜索索引或检索 AI 引用，不据此生成健康分。")}</p>
  </section>;
}

function PreferenceRow({ preference }: { preference: AiAccessReport["preferences"][number] }) {
  const { t } = useI18n();
  const scope = preference.scope === "FILE" ? t("whole file", "整个文件") : preference.scope.join(", ") || "-";
  return <>
    <dt>{preference.kind === "CONTENT_SIGNAL" ? "Content-Signal" : "Content-Usage"}</dt>
    <dd><code>{preference.text}</code>{" "}<small>{t("Line {line} · applies to {scope}", "第 {line} 行 · 适用于 {scope}", { line: preference.line, scope })}{preference.path ? " · " + preference.path : ""}</small></dd>
  </>;
}

function accessNote(code: string, t: Translator): string {
  const notes: Record<string, string> = {
    ROBOTS_NOT_FOUND: t("robots.txt returned 404 or 410. Under RFC 9309 crawlers may fetch everything; this does not prove live crawler access.", "robots.txt 返回 404 或 410。按 RFC 9309，爬虫可以抓取全部内容；这不代表已验证爬虫实际可访问。"),
    ROBOTS_ACCESS_DENIED: t("robots.txt returned 401 or 403. Under RFC 9309 this means no rules, but a firewall or CDN that refuses this check may refuse AI crawlers too.", "robots.txt 返回 401 或 403。按 RFC 9309 视为没有规则，但拒绝本次检查的防火墙或 CDN 也可能拒绝 AI 爬虫。"),
    ROBOTS_CLIENT_ERROR: t("robots.txt returned another 4xx status. Under RFC 9309 crawlers may fetch everything.", "robots.txt 返回其他 4xx 状态。按 RFC 9309，爬虫可以抓取全部内容。"),
    ROBOTS_TOO_MANY_REDIRECTS: t("robots.txt redirected more than five times. Crawlers treat that as no rules.", "robots.txt 跳转超过 5 次，爬虫会视为没有规则。"),
    ROBOTS_RATE_LIMITED: t("robots.txt returned 429. Under RFC 9309 crawlers must assume everything is disallowed until it can be read.", "robots.txt 返回 429。按 RFC 9309，在能读取之前爬虫必须视为全部禁止。"),
    ROBOTS_SERVER_ERROR: t("robots.txt returned a 5xx error. Under RFC 9309 crawlers must assume everything is disallowed. Fix the server error first.", "robots.txt 返回 5xx 错误。按 RFC 9309，爬虫必须视为全部禁止，请优先修复服务器错误。"),
    UNEXPECTED_STATUS: t("The robots request returned an unexpected HTTP status. The declared rules remain unknown.", "robots 请求返回了意外的 HTTP 状态，无法确定其规则。"),
    HTML_RESPONSE: t("The response looks like an HTML page instead of robots.txt (often a soft 404 or a bot challenge). No allowance is inferred.", "响应看起来是 HTML 页面而非 robots.txt（常见于软 404 或机器人验证页），不能据此判断已放行。"),
    ROBOTS_TOO_COMPLEX: t("robots.txt has more rules than this check evaluates, so the result is unknown.", "robots.txt 的规则数量超过本次检查上限，结果标记为未知。"),
    UNRECOGNIZED_CONTENT: t("The response could not be recognized as robots rules.", "响应无法识别为 robots 规则。"),
    FETCH_FAILED: t("The public rules could not be fetched. Check the site's connectivity and try again.", "未能读取公开规则，请检查站点连通性后重试。"),
    TIMEOUT: t("The robots request timed out. No access conclusion was made.", "读取 robots 超时，尚不能判断访问规则。"),
    ROBOTS_NOT_PROOF_OF_ACCESS: t("A robots rule does not verify firewall/CDN access, indexing or citations.", "robots 规则不能验证防火墙／CDN 放行、收录或引用。"),
    USER_AGENTS_NOT_IMPERSONATED: t("Requests use the local checker's identity, not a provider's bot identity or IP.", "请求使用本机检查器的身份，不冒充服务商爬虫或使用其 IP。"),
    TRAINING_NOT_SEARCH: t("Training and search crawlers have different purposes; evaluate their rules separately.", "训练和搜索爬虫用途不同，应分别判断规则。"),
    USER_REQUEST_ROBOTS_NOT_RELIABLE: t("Some providers' user-triggered visits do not generally use robots.txt as the access control.", "部分服务商的用户即时访问通常不以 robots.txt 作为访问控制。"),
    TRAINING_SIGNAL_ROLLOUT: t("The shared \"__usage_ai-training\" token is a preference, not a crawl block, and providers adopt it on their own schedules (announced October 2026). A group that names a provider's own token, such as ClaudeBot or Google-Extended, takes precedence for that provider.", "共享的 __usage_ai-training 标记表达的是使用偏好，不阻止抓取；各服务商按各自时间表支持（2026 年 10 月公布）。对某服务商而言，直接点名其标记的分组（如 ClaudeBot、Google-Extended）优先。"),
    PREFERENCES_ARE_REQUESTS: t("Content-Signal and Content-Usage lines state how content may be used. They do not block crawling, and support differs by provider.", "Content-Signal 与 Content-Usage 表达的是内容用途偏好，不会阻止抓取，各服务商的支持情况不同。"),
    OTHER_PREFERENCES_NOT_EVALUATED: t("Page-level meta tags, HTTP headers, TDMRep and licensing files are outside this check.", "页面级 meta 标签、HTTP 头、TDMRep 及许可文件不在本次检查范围内。"),
    SAVED_PAGE_NOT_LIVE: t("Page HTTP and index directives are historical crawl evidence, not a fresh page request.", "页面 HTTP 和索引指令来自历史抓取，本次没有重新请求页面正文。"),
    ROBOTS_TRUNCATED: t("robots.txt is larger than 500 KiB; only the complete lines before the limit were read, as crawlers do.", "robots.txt 超过 500 KiB，与爬虫一样只读取了上限之前的完整行。"),
    UNEXPECTED_CONTENT_TYPE: t("robots.txt was not served as text/plain. The rules were still read; check that the server sends the file itself.", "robots.txt 不是以 text/plain 返回的。规则已照常读取，请确认服务器返回的是文件本身。"),
    INVALID_UTF8: t("robots.txt is not valid UTF-8; unreadable characters were replaced before reading the rules.", "robots.txt 不是有效的 UTF-8，读取规则前已替换无法识别的字符。"),
    WAF_MAY_BLOCK: t("A firewall, CDN or bot challenge may stop crawlers before they read any rule. Verify the provider's access in your CDN logs.", "防火墙、CDN 或机器人验证可能在爬虫读取规则前就拦截了它，请在 CDN 日志中核实服务商的访问情况。"),
    ROBOTS_REDIRECTED: t("robots.txt redirected; the rules come from the final address.", "robots.txt 发生了跳转，规则来自最终地址。"),
  };
  return notes[code] ?? t("Additional verification is needed.", "此项还需要进一步核实。");
}
