"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Download, Loader2, Plus, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n/shared";
import type { ClusterReview } from "@/lib/ai-workbench/tools/schema";
import { OutputLanguageOptions, useOutputLanguage } from "./output-language";
import { ToolPanel, useToolTasks, type ToolTasks } from "./tool-panel";
import { csvText, datedName, downloadText, type ToolJob } from "./tool-model";
import { CONTENT_PLAN_CHANGED } from "@/components/content-planner/model";
import k from "@/components/research/keyword-ai-panel.module.css";
import s from "./tool-panel.module.css";

function statusBadge(review: ClusterReview, t: Translator) {
  const [label, tone] =
    review.status === "GAP"
      ? [t("Gap: no page owns it", "缺口：没有页面承接"), s.warn]
      : review.status === "SPLIT"
        ? [t("Split across pages", "内耗：分散在多个页面"), s.bad]
        : [t("Covered", "已覆盖"), s.good];
  return <span className={`${s.badge} ${tone}`}>{label}</span>;
}

/** Groups the site's Search Console queries by search need and maps each group to a page; gaps and splits go into the content plan. */
export function QueryClusterPanel({ siteId, initialJobId }: { siteId: string; initialJobId?: string }) {
  const { t } = useI18n();
  const api = useToolTasks(siteId, "QUERY_CLUSTERS", initialJobId);
  const { language, choose } = useOutputLanguage(siteId);
  const [limit, setLimit] = useState<100 | 200>(200);
  const [instructions, setInstructions] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    await api.start({
      title: t(`Query clusters · top ${limit} queries`, `搜索词聚类 · 前 ${limit} 个搜索词`),
      language,
      instructions: instructions.trim(),
      queryClusters: { limit },
    });
  }
  const form = (
    <form onSubmit={submit}>
      <h3>{t("1. Group the queries", "1. 给搜索词分组")}</h3>
      <p className={k.muted}>
        {t(
          "Uses the queries with the most impressions in the last 28 days of Search Console and the pages each one reached.",
          "使用 Search Console 最近 28 天曝光最多的搜索词，以及每个搜索词落到的页面。",
        )}
      </p>
      <fieldset className={k.fields} disabled={api.busy}>
        <label className={k.field}>
          {t("Queries to group", "分组的搜索词数量")}
          <select value={limit} onChange={event => setLimit(event.target.value === "100" ? 100 : 200)}>
            <option value={200}>{t("Top 200", "前 200 个")}</option>
            <option value={100}>{t("Top 100", "前 100 个")}</option>
          </select>
        </label>
        <label className={k.field}>
          {t("Language of names and notes", "主题名和说明的语言")}
          <select value={language} onChange={event => choose(event.target.value)}>
            <OutputLanguageOptions />
          </select>
        </label>
        <label className={k.field}>
          {t("Requirements (optional)", "补充要求（选填）")}
          <textarea
            maxLength={6000}
            value={instructions}
            onChange={event => setInstructions(event.target.value)}
            placeholder={t("e.g. keep brand searches in their own group", "例如：品牌词单独成组")}
          />
        </label>
      </fieldset>
      <button type="submit" className={k.submit} disabled={!api.ready}>
        {api.busy ? <Loader2 size={17} className={k.spinner} /> : <Sparkles size={17} />}
        {t("Group with my ChatGPT allowance", "使用 ChatGPT 额度分组")}
      </button>
      <p className={`${k.muted} mt-3`}>
        {t(
          "Whether a group is a gap or split across pages is decided by the program from the observed impressions, not by the model.",
          "是缺口还是内耗由程序按实际曝光判断，不由模型决定。",
        )}
      </p>
    </form>
  );
  return (
    <ToolPanel
      siteId={siteId}
      api={api}
      kicker="CHATGPT · QUERY CLUSTERS"
      returnPage="content"
      label={t("Query clusters", "搜索词聚类")}
      title={t("Group search queries and map them to pages", "搜索词聚类，并对应到页面")}
      description={t(
        "A group no page owns is a content gap; a group whose impressions are split between pages is cannibalization. Chosen groups go into the content plan: a gap as a planned topic, a covered group as its existing article.",
        "没有页面承接的组是内容缺口，曝光分散在几个页面上的组是内耗。选中的组可以放进内容规划：缺口变成待写选题，已有页面承接的组记为对应的已发布文章。",
      )}
      form={form}
      result={job => <ClusterResult key={job.id} siteId={siteId} api={api} job={job} />}
    />
  );
}

type Pillar = { id: string; title: string };

export function ClusterResult({ siteId, api, job }: { siteId: string; api: ToolTasks; job: ToolJob }) {
  const { t } = useI18n();
  const clusters = job.result?.queryClusters ?? [];
  const reviews = job.result?.clusterReview ?? [];
  const [picked, setPicked] = useState<number[]>(() => reviews.flatMap((review, i) => (review.status !== "COVERED" ? [i] : [])));
  const [pillars, setPillars] = useState<Pillar[] | null>(null);
  const [pillarId, setPillarId] = useState("");
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch(`/api/sites/${encodeURIComponent(siteId)}/content`, { cache: "no-store" })
      .then(async response => {
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.pillars)) throw new Error();
        return body.pillars as Pillar[];
      })
      .then(list => {
        if (alive) {
          setPillars(list.map(({ id, title }) => ({ id, title })));
          setPillarId(list[0]?.id ?? "");
        }
      })
      .catch(() => {
        if (alive) setPillars([]);
      });
    return () => {
      alive = false;
    };
  }, [siteId]);
  const toggle = (index: number) =>
    setPicked(current => (current.includes(index) ? current.filter(item => item !== index) : [...current, index]));
  async function importChosen() {
    if (!pillarId || !picked.length || importing) return;
    setImporting(true);
    api.setError("");
    api.setNotice("");
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/assistant/cluster-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, pillarId, clusters: picked }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "import_failed");
      api.setNotice(
        t(
          `Added ${body.created} to the content plan; ${body.skipped} were already there or had no query.`,
          `已放进内容规划 ${body.created} 个；${body.skipped} 个已存在或没有搜索词，已跳过。`,
        ),
      );
      if (body.created > 0) window.dispatchEvent(new CustomEvent(CONTENT_PLAN_CHANGED, { detail: { siteId } }));
    } catch (cause) {
      api.setError(
        cause instanceof Error && cause.message !== "import_failed"
          ? cause.message
          : t("Could not add them to the content plan.", "未能放进内容规划。"),
      );
    } finally {
      setImporting(false);
    }
  }
  function exportCsv() {
    downloadText(
      datedName("query-clusters", "csv"),
      csvText([
        [
          "Cluster",
          "Status",
          "Intent",
          "Funnel",
          "Impressions",
          "Clicks",
          "Position",
          "Chosen page",
          "Page with most impressions",
          "Queries",
          "Note",
        ],
        ...clusters.map((cluster, i) => {
          const review = reviews[i];
          return [
            cluster.name,
            review?.status,
            cluster.intent,
            cluster.funnel,
            review?.impressions,
            review?.clicks,
            review?.position,
            review?.chosenUrl,
            review?.ownerUrl,
            review?.queries.map(q => q.query).join(" | "),
            cluster.note,
          ];
        }),
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
      <div className={s.toolbar}>
        <div>
          {pillars === null ? (
            <span className={k.muted}>{t("Loading the content plan…", "正在读取内容规划…")}</span>
          ) : pillars.length ? (
            <>
              <label className={k.muted} htmlFor={`pillar-${job.id}`}>
                {t("Add the chosen groups to", "把选中的组放进")}
              </label>
              <select id={`pillar-${job.id}`} className={s.badge} value={pillarId} onChange={event => setPillarId(event.target.value)}>
                {pillars.map(pillar => (
                  <option key={pillar.id} value={pillar.id}>
                    {pillar.title}
                  </option>
                ))}
              </select>
              <button type="button" className={k.secondary} disabled={!picked.length || importing} onClick={() => void importChosen()}>
                {importing ? <Loader2 size={15} className={k.spinner} /> : <Plus size={15} />}
                {t(`Add ${picked.length}`, `放进 ${picked.length} 个`)}
              </button>
            </>
          ) : (
            <span className={k.muted}>
              {t("Create a pillar in content planning first to add groups to it.", "先在内容规划里建一个主题支柱，才能把分组放进去。")}
            </span>
          )}
        </div>
      </div>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th />
              <th>{t("Group", "分组")}</th>
              <th>{t("Search data (28 days)", "搜索数据（28 天）")}</th>
              <th>{t("Pages", "页面")}</th>
              <th>{t("Note", "说明")}</th>
            </tr>
          </thead>
          <tbody>
            {clusters.map((cluster, i) => {
              const review = reviews[i];
              if (!review) return null;
              return (
                <tr key={i}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={t("Choose this group", "选择这个分组")}
                      checked={picked.includes(i)}
                      onChange={() => toggle(i)}
                    />
                  </td>
                  <td>
                    <strong>{cluster.name}</strong>
                    <div className={s.badges}>
                      {statusBadge(review, t)}
                      <span className={s.badge}>{cluster.funnel}</span>
                      <span className={s.badge}>{cluster.intent}</span>
                    </div>
                    <p className={`${s.url} mt-2`}>
                      {review.queries
                        .slice(0, 6)
                        .map(q => q.query)
                        .join(" · ")}
                      {review.queries.length > 6 && ` · +${review.queries.length - 6}`}
                    </p>
                  </td>
                  <td>
                    {t(
                      `${review.impressions.toLocaleString()} impressions · ${review.clicks.toLocaleString()} clicks`,
                      `曝光 ${review.impressions.toLocaleString()} · 点击 ${review.clicks.toLocaleString()}`,
                    )}
                    {review.position !== null && (
                      <>
                        <br />
                        {t(`position ${review.position}`, `平均名次 ${review.position}`)}
                      </>
                    )}
                  </td>
                  <td>
                    {review.chosenUrl ? (
                      <span className={s.url}>{review.chosenUrl}</span>
                    ) : (
                      <span className={s.url}>{t("No fitting page", "没有合适的页面")}</span>
                    )}
                    {review.mismatch && review.ownerUrl && (
                      <p className={`${s.url} mt-1`}>
                        {t("Google shows another page most: ", "Google 目前最常展示的是另一页：")}
                        {review.ownerUrl}
                      </p>
                    )}
                    {review.status === "SPLIT" && (
                      <ul className={s.list}>
                        {review.pages
                          .filter(page => page.share >= 0.2)
                          .map(page => (
                            <li key={page.url}>
                              {page.url} · {Math.round(page.share * 100)}%
                            </li>
                          ))}
                      </ul>
                    )}
                  </td>
                  <td>{cluster.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!!job.result?.factChecks.length && (
        <details className={`${k.checks} mt-4`}>
          <summary>{t("Check before acting", "处理前核对")}</summary>
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
