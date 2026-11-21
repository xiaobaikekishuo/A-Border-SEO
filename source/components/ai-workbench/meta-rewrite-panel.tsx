"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Copy, Download, Loader2, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n/shared";
import type { MetaCandidate } from "@/lib/ai-workbench/tools/meta-rewrite";
import type { MetaRewrite } from "@/lib/ai-workbench/tools/schema";
import { OutputLanguageOptions, useOutputLanguage } from "./output-language";
import { copyText, ToolPanel, useToolTasks, type ToolTasks } from "./tool-panel";
import { csvText, datedName, downloadText, type ToolJob } from "./tool-model";
import k from "@/components/research/keyword-ai-panel.module.css";
import s from "./tool-panel.module.css";

const LIMIT = 20;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

function warningText(code: NonNullable<MetaRewrite["warnings"]>[number], t: Translator) {
  return {
    SAME_AS_CURRENT: t("Same as the current title", "与当前标题相同"),
    DUPLICATE_TITLE: t("Same title as another page", "与其他页面标题重复"),
    UNSUPPORTED_NUMBER: t("Has a number the page does not show: verify it", "含有页面上没有的数字，请核实"),
    URL_REMOVED: t("A link was removed", "已去掉其中的网址"),
    NO_TARGET_QUERY: t("No supplied query targeted", "没有对应已有搜索词"),
  }[code];
}

/** Rewrites titles and descriptions of pages that many see but few click, with the owner's ChatGPT allowance. */
export function MetaRewritePanel({ siteId, initialJobId }: { siteId: string; initialJobId?: string }) {
  const { t } = useI18n();
  const api = useToolTasks(siteId, "META_REWRITE", initialJobId);
  const { language, choose } = useOutputLanguage(siteId);
  const [instructions, setInstructions] = useState("");
  const [candidates, setCandidates] = useState<MetaCandidate[] | null>(null);
  const [period, setPeriod] = useState<{ start: string; end: string } | null>(null);
  const [candidateError, setCandidateError] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    fetch(`/api/sites/${encodeURIComponent(siteId)}/assistant/meta-candidates`, { cache: "no-store" })
      .then(async response => {
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.pages)) throw new Error(body.error || "load_failed");
        if (!alive) return;
        setCandidates(body.pages);
        setPeriod(body.period ?? null);
        setPicked(body.pages.slice(0, 10).map((page: MetaCandidate) => page.url));
      })
      .catch(() => {
        if (alive) setCandidateError(t("Could not load the pages. Refresh the page to try again.", "无法读取候选页面，请刷新页面重试。"));
      });
    return () => {
      alive = false;
    };
  }, [siteId, t]);
  const toggle = (url: string) =>
    setPicked(current =>
      current.includes(url) ? current.filter(item => item !== url) : current.length >= LIMIT ? current : [...current, url],
    );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!picked.length) return;
    await api.start({
      title: t(`Titles and descriptions · ${picked.length} pages`, `标题和描述 · ${picked.length} 个页面`),
      language,
      instructions: instructions.trim(),
      metaRewrite: { urls: picked },
    });
  }
  const form = (
    <form onSubmit={submit}>
      <h3>{t("1. Choose pages", "1. 选择页面")}</h3>
      <p className={k.muted}>
        {t(
          "Pages ranked in the top 20 with at least 100 impressions in 28 days and a CTR below the usual one for their position, most missed clicks first.",
          "最近 28 天曝光至少 100、排在前 20 名、点击率低于同名次常见水平的页面，按少拿的点击从多到少排列。",
        )}
        {period && ` ${period.start} ~ ${period.end}`}
      </p>
      {candidateError && <p className={`${k.error} mt-3`}>{candidateError}</p>}
      {!candidates && !candidateError && (
        <p className={`${k.muted} mt-3`}>
          <Loader2 size={14} className={`${k.spinner} inline`} /> {t("Loading pages…", "正在读取页面…")}
        </p>
      )}
      {candidates && !candidates.length && (
        <p className={`${k.notice} mt-3`}>
          {t(
            "No page qualifies yet. Sync Search Console first, or come back when more searches show the site.",
            "暂时没有符合条件的页面。请先同步 Search Console，或等网站获得更多曝光后再来。",
          )}
        </p>
      )}
      {!!candidates?.length && (
        <div className={`${s.picker} mt-4`}>
          {candidates.map(page => (
            <label key={page.url} className={s.check}>
              <input
                type="checkbox"
                checked={picked.includes(page.url)}
                disabled={!picked.includes(page.url) && picked.length >= LIMIT}
                onChange={() => toggle(page.url)}
              />
              <span>
                <strong>{page.title || page.url}</strong>
                <br />
                <span className={s.url}>{page.url}</span>
                <br />
                <span className={s.url}>
                  {t(
                    `${page.impressions.toLocaleString()} impressions · CTR ${percent(page.ctr)} (usual ${percent(page.expectedCtr)}) · position ${page.position.toFixed(1)} · about ${page.missedClicks} clicks missed`,
                    `曝光 ${page.impressions.toLocaleString()} · 点击率 ${percent(page.ctr)}（常见 ${percent(page.expectedCtr)}）· 平均名次 ${page.position.toFixed(1)} · 约少拿 ${page.missedClicks} 次点击`,
                  )}
                  {!page.inCrawl && ` · ${t("not in the latest crawl", "最近抓取里没有")}`}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      <p className={`${k.muted} mt-2`}>
        {t(`${picked.length} of up to ${LIMIT} pages chosen.`, `已选 ${picked.length} 个，最多 ${LIMIT} 个。`)}
      </p>
      <fieldset className={k.fields} disabled={api.busy}>
        <label className={k.field}>
          {t("Language of notes", "说明语言")}
          <select value={language} onChange={event => choose(event.target.value)}>
            <OutputLanguageOptions />
          </select>
        </label>
        <p className={k.muted}>{t("Titles and descriptions stay in each page's own language.", "新标题和描述沿用每个页面自己的语言。")}</p>
        <label className={k.field}>
          {t("Requirements (optional)", "补充要求（选填）")}
          <textarea
            maxLength={6000}
            value={instructions}
            onChange={event => setInstructions(event.target.value)}
            placeholder={t(
              "e.g. keep the brand at the end; mention free returns only where the page says so",
              "例如：品牌名放在最后；只有页面写了包退换才提",
            )}
          />
        </label>
      </fieldset>
      <button type="submit" className={k.submit} disabled={!api.ready || !picked.length}>
        {api.busy ? <Loader2 size={17} className={k.spinner} /> : <Sparkles size={17} />}
        {t("Rewrite with my ChatGPT allowance", "使用 ChatGPT 额度改写")}
      </button>
    </form>
  );
  return (
    <ToolPanel
      siteId={siteId}
      api={api}
      kicker="CHATGPT · TITLES"
      returnPage="opportunities"
      label={t("Rewrite titles and descriptions", "批量改写标题和描述")}
      title={t("Rewrite titles and descriptions in bulk", "批量改写标题和描述")}
      description={t(
        "For pages that many searchers see but few click, Codex writes new titles and descriptions around the queries each page already gets. The program measures their length and flags numbers the page does not show. Nothing is published.",
        "针对曝光多、点击少的页面，Codex 按每个页面已经带来流量的搜索词重写标题和描述。程序检查长度，并标出页面上没有的数字。不会发布到网站。",
      )}
      form={form}
      result={job => <MetaRewriteResult key={job.id} api={api} job={job} />}
    />
  );
}

export function MetaRewriteResult({ api, job }: { api: ToolTasks; job: ToolJob }) {
  const { t } = useI18n();
  const items = job.result?.metaRewrites ?? [];
  const status = (value: MetaRewrite["titleStatus"], units: number | undefined, max: number) => (
    <span className={`${s.badge} ${value === "OK" ? s.good : s.warn}`}>
      {units ?? 0}/{max} {value === "LONG" ? t("too long", "过长") : value === "SHORT" ? t("short", "偏短") : ""}
    </span>
  );
  function exportCsv() {
    downloadText(
      datedName("titles-descriptions", "csv"),
      csvText([
        [
          "URL",
          "Current title",
          "New title",
          "Title units",
          "Current description",
          "New description",
          "Description units",
          "Target queries",
          "Warnings",
          "Reason",
        ],
        ...items.map(item => [
          item.url,
          item.currentTitle,
          item.title,
          item.titleUnits,
          item.currentDescription,
          item.description,
          item.descriptionUnits,
          item.targetQueries.join(" | "),
          (item.warnings ?? []).join(" | "),
          item.reason,
        ]),
      ]),
      "text/csv;charset=utf-8",
    );
  }
  return (
    <>
      <div className={s.toolbar}>
        <div>
          <h3>{job.title}</h3>
        </div>
        <div>
          <button type="button" className={k.secondary} onClick={exportCsv}>
            <Download size={15} />
            {t("Download CSV", "下载 CSV")}
          </button>
        </div>
      </div>
      <p className={`${k.muted} mb-3`}>{job.result?.summary}</p>
      <p className={`${k.muted} mb-3`}>
        {t(
          "Length counts a Chinese or other wide character as 2 units: titles up to 60, descriptions up to 160. Compare clicks for the same queries 2 to 4 weeks after you change a page.",
          "长度按中文等全角字符记 2、其他字符记 1：标题最多 60，描述最多 160。改完后 2 到 4 周，对比同一批搜索词的点击。",
        )}
      </p>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>{t("Page", "页面")}</th>
              <th>{t("Current", "当前")}</th>
              <th>{t("Proposed", "建议")}</th>
              <th>{t("Why", "原因")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.pageId}>
                <td>
                  <span className={s.url}>{item.url}</span>
                  <div className={s.badges}>
                    {item.targetQueries.map(query => (
                      <span key={query} className={`${s.badge} ${item.coveredQueries?.includes(query) ? s.good : ""}`}>
                        {query}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <strong>{item.currentTitle ?? t("Not in the crawl", "抓取中没有")}</strong>
                  <p className={s.url}>{item.currentDescription}</p>
                </td>
                <td>
                  <strong>{item.title}</strong>{" "}
                  <button
                    type="button"
                    className={s.copy}
                    onClick={() => void copyText(api, item.title, t)}
                    aria-label={t("Copy title", "复制标题")}
                  >
                    <Copy size={12} />
                  </button>
                  <div className={s.badges}>{status(item.titleStatus, item.titleUnits, 60)}</div>
                  <p className="mt-2">
                    {item.description}{" "}
                    <button
                      type="button"
                      className={s.copy}
                      onClick={() => void copyText(api, item.description, t)}
                      aria-label={t("Copy description", "复制描述")}
                    >
                      <Copy size={12} />
                    </button>
                  </p>
                  <div className={s.badges}>
                    {status(item.descriptionStatus, item.descriptionUnits, 160)}
                    {(item.warnings ?? []).map(code => (
                      <span key={code} className={`${s.badge} ${s.warn}`}>
                        {warningText(code, t)}
                      </span>
                    ))}
                  </div>
                </td>
                <td>{item.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!!job.result?.factChecks.length && (
        <details className={`${k.checks} mt-4`}>
          <summary>{t("Check before publishing", "发布前核对")}</summary>
          <ul>
            {job.result.factChecks.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
