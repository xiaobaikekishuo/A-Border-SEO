import type { Translator } from "@/lib/i18n/shared";
import type { FillerPreview, FillerStatus } from "@/lib/ai-workbench/pool/fill";
import type { AlertsScope, PoolItemView } from "@/lib/ai-workbench/pool/view";

/*
 * The words of the background task pool panel (pool-panel.tsx): what each
 * filler does, what it would find now, what it found at its last check, and
 * the state of each item.
 */

export const FILLERS = ["rankings", "alerts", "meta", "schema", "clusters", "briefs"] as const;
export type Filler = (typeof FILLERS)[number];
type When = (iso: string) => string;

/** The choices for each filler's daily limit. */
export const CAP_CHOICES: Record<Filler, number[]> = {
  rankings: [1, 2, 3, 5],
  alerts: [1, 2, 3, 5],
  meta: [1, 2, 3],
  schema: [5, 10, 20, 30],
  clusters: [1, 2],
  briefs: [3, 5, 10, 20],
};

export function fillerText(filler: Filler, t: Translator): [string, string] {
  return {
    rankings: [
      t("Ranking change review", "排名变化复盘"),
      t(
        "After a rank check with a drop of 3 or more, a keyword that left the checked depth, a new ranking page or a competitor moving up in the top 10.",
        "排名检查后，有词掉了 3 名以上、掉出检查深度、换了排名页面，或前 10 名里有竞品升上来时。",
      ),
    ],
    alerts: [
      t("Alert diagnosis", "提醒诊断"),
      t(
        "When an alert of this site fires: traffic and ranking drops only, or any alert.",
        "这个站点的提醒触发时：只看流量和排名下降，或任何提醒。",
      ),
    ],
    meta: [
      t("Titles and descriptions", "标题和描述"),
      t(
        "Checked once a day: low-CTR pages that are new or whose CTR fell by a fifth since the last check, up to 20 to a task. Pages rewritten in the last 28 days are left out.",
        "每天检查一次：新出现的低点击率页面，或点击率比上次又降了两成以上的，每项最多 20 页；近 28 天改写过的不算。",
      ),
    ],
    schema: [
      t("Structured data", "结构化数据"),
      t(
        "After each crawl, pages without structured data: pages new since the previous crawl first, then the most impressions, up to 10.",
        "每次抓取后，缺结构化数据的页面：先是比上次抓取新出现的页面，再按曝光，每次最多 10 个。",
      ),
    ],
    clusters: [
      t("Search query clusters", "搜索词聚类"),
      t(
        "Once a month when at least 10 search queries had impressions: the 200 with the most impressions, mapped to the content plan.",
        "每月一次，有曝光的搜索词不少于 10 个时，把曝光最多的 200 个分组，并对应到内容规划。",
      ),
    ],
    briefs: [
      t("Topic briefs", "选题简报"),
      t(
        "Planned topics of the content plan without a brief, keeping 5 waiting. The brief is written into the topic.",
        "内容规划里还没有简报的待写选题，保持 5 个在等待；简报会写进选题。",
      ),
    ],
  }[filler] as [string, string];
}

/** What a filler would find now (GET ?preview=1). */
export function previewText(filler: Filler, preview: FillerPreview, scope: AlertsScope, t: Translator, when: When): string {
  const unknown = t("Could not count this right now.", "暂时无法统计。");
  switch (filler) {
    case "rankings": {
      const p = preview.rankings;
      if (!p) return unknown;
      if (!p.runAt) return t("No finished rank check yet.", "还没有完成的排名检查。");
      return (
        t(
          `Latest check ${when(p.runAt)}: ${p.keywords} keywords with notable moves, ${p.competitors} competitors moving up.`,
          `最近一次检查 ${when(p.runAt)}：${p.keywords} 个词有明显变化，${p.competitors} 个竞品升上来。`,
        ) + (p.queued ? t(" It is in the pool already.", "这次检查已在任务池里。") : "")
      );
    }
    case "alerts": {
      const p = preview.alerts;
      if (!p) return unknown;
      return scope === "drops"
        ? t(
            `${p.set} traffic and ranking drop alerts are on; ${p.firedWeek} fired in the last 7 days.`,
            `已开启 ${p.set} 条流量和排名下降提醒，近 7 天有 ${p.firedWeek} 条触发过。`,
          )
        : t(
            `${p.set} alerts are on; ${p.firedWeek} fired in the last 7 days.`,
            `已开启 ${p.set} 条提醒，近 7 天有 ${p.firedWeek} 条触发过。`,
          );
    }
    case "meta": {
      const p = preview.meta;
      if (!p) return unknown;
      return t(
        `${p.pages} low-CTR pages can be rewritten now; ${p.changed} are new or worse since the last check.`,
        `现在有 ${p.pages} 个低点击率页面可改写，其中 ${p.changed} 个是新出现或变差的。`,
      );
    }
    case "schema": {
      const p = preview.schema;
      if (!p) return unknown;
      return t(
        `${p.pages} pages of the latest crawl have no structured data: ${p.newPages} new since the previous crawl, ${p.open} not queued yet.`,
        `最近一次抓取有 ${p.pages} 个页面缺结构化数据：${p.newPages} 个是新页面，${p.open} 个还没排过。`,
      );
    }
    case "clusters": {
      const p = preview.clusters;
      if (!p) return unknown;
      if (p.doneThisMonth) return t("Clustered this month already.", "本月已经聚类过。");
      return p.queries >= 10
        ? t(`${p.queries} search queries had impressions in the last 28 days.`, `近 28 天有 ${p.queries} 个有曝光的搜索词。`)
        : t(
            `Only ${p.queries} search queries had impressions in the last 28 days; at least 10 are needed.`,
            `近 28 天只有 ${p.queries} 个有曝光的搜索词，至少要 10 个。`,
          );
    }
    case "briefs": {
      const p = preview.briefs;
      if (!p) return unknown;
      return t(
        `${p.topics} planned topics have no brief; ${p.open} are not queued yet.`,
        `有 ${p.topics} 个待写选题没有简报，${p.open} 个还没排过。`,
      );
    }
  }
}

function outcomeText(filler: Filler, status: FillerStatus, t: Translator): string {
  const { count, added } = status;
  switch (status.outcome) {
    case "added":
      return {
        rankings: t(`${count} notable moves, a review was queued.`, `${count} 处明显变化，已加入复盘。`),
        alerts: t(`${count} alerts fired, a diagnosis was queued.`, `${count} 条提醒触发，已加入诊断。`),
        meta: t(`${added} pages new or worse, queued for a rewrite.`, `${added} 个页面新出现或变差，已加入改写。`),
        schema: t(`${count} pages without structured data, ${added} queued.`, `${count} 个页面缺结构化数据，加入 ${added} 项。`),
        clusters: t(`${count} search queries, this month's clustering was queued.`, `${count} 个搜索词，已加入本月聚类。`),
        briefs: t(`${count} topics to queue, ${added} queued.`, `${count} 个选题待排，加入 ${added} 项。`),
      }[filler];
    case "merged":
      return t(`${added} pages new or worse, added to the rewrite already waiting.`, `${added} 个页面新出现或变差，并入等待中的改写。`);
    case "already_queued":
      return t("It is in the pool already.", "已经在任务池里。");
    case "not_notable":
      return t("No notable moves in the latest check.", "最近一次检查没有明显变化。");
    case "no_new_run":
      return t("No new rank check.", "没有新的排名检查。");
    case "no_run":
      return t("No finished rank check yet.", "还没有完成的排名检查。");
    case "none_fired":
      return t("No alert fired.", "没有新触发的提醒。");
    case "no_change":
      return filler === "meta"
        ? t(`${count} low-CTR pages, none new or worse.`, `${count} 个低点击率页面，没有新出现或变差的。`)
        : filler === "schema"
          ? t(
              `${count} pages without structured data, all queued before with the same content.`,
              `${count} 个页面缺结构化数据，内容没变，之前都排过。`,
            )
          : t(`${count} topics without a brief, all queued before.`, `${count} 个选题没有简报，之前都排过。`);
    case "no_candidates":
      return t("No low-CTR pages.", "没有低点击率页面。");
    case "no_new_crawl":
      return t("No new crawl.", "没有新的抓取。");
    case "no_crawl":
      return t("No finished crawl yet.", "还没有完成的抓取。");
    case "none_missing":
      return t("Every indexable page has structured data.", "所有可索引页面都有结构化数据。");
    case "pool_full":
      return t("Enough are waiting; more are added as these run.", "等待中的已经够多，跑完再加。");
    case "done_this_month":
      return t("Clustered this month already.", "本月已经聚类过。");
    case "not_enough_queries":
      return t(`Only ${count} search queries; at least 10 are needed.`, `只有 ${count} 个搜索词，至少要 10 个。`);
    case "none_waiting":
      return t("No planned topic without a brief.", "没有缺简报的待写选题。");
    case "check_failed":
      return t("The check failed; it is tried again next time.", "这次检查出错，下次再试。");
  }
}

/** What a filler found at its last check, and when it last queued anything. */
export function statusText(filler: Filler, status: FillerStatus | undefined, t: Translator, when: When): string {
  if (!status)
    return t(
      "Not checked yet: it is checked when you save, then about every 10 minutes while the worker is idle.",
      "还没检查过：保存后马上检查，之后在 worker 空闲时约每 10 分钟检查一次。",
    );
  const last =
    status.lastAddedAt && status.outcome !== "added" && status.outcome !== "merged"
      ? t(` Last added ${when(status.lastAddedAt)}.`, `上次加入是 ${when(status.lastAddedAt)}。`)
      : "";
  return `${t(`Checked ${when(status.checkedAt)}: `, `${when(status.checkedAt)} 检查：`)}${outcomeText(filler, status, t)}${last}`;
}

export function sourceLabel(source: string, t: Translator) {
  return (
    (
      {
        RANKINGS: t("Ranking review", "排名复盘"),
        ALERTS: t("Alert diagnosis", "提醒诊断"),
        META: t("Title rewrite", "标题改写"),
        SCHEMA: t("Structured data", "结构化数据"),
        CLUSTERS: t("Query clusters", "搜索词聚类"),
        BRIEF: t("Topic brief", "选题简报"),
        BATCH: t("Queued by you", "手动加入"),
      } as Record<string, string>
    )[source] ?? source
  );
}

export function reasonText(reason: string | null, t: Translator) {
  if (!reason) return "";
  return (
    (
      {
        superseded: t("a newer one replaced it", "被更新的一项替代"),
        expired: t("waited two weeks", "已等待两周"),
        yielded: t("gave way to a task you started", "给你发起的任务让位"),
        no_data: t("no data for it yet", "还没有可用数据"),
        no_search_data: t("no Search Console data", "没有 Search Console 数据"),
        not_enough_queries: t("fewer than 10 search queries", "搜索词不到 10 个"),
        page_gone: t("the page is not in the latest crawl", "页面不在最近一次抓取里"),
        has_schema: t("the page has structured data now", "页面已有结构化数据"),
        no_body: t("the page has no body text", "页面没有正文"),
        topic_gone: t("the topic was deleted", "选题已删除"),
        has_brief: t("the topic has a brief now", "选题已有简报"),
        too_large: t("too much data for one task", "数据太多，一个任务放不下"),
        prepare_failed: t("could not be prepared", "无法准备"),
        canceled: t("canceled", "已取消"),
        prospects_changed: t("the link prospects changed or the Manus task is gone", "外链机会已变化，或 Manus 任务已不在"),
      } as Record<string, string>
    )[reason] ?? reason
  );
}

export function itemStatus(item: PoolItemView, t: Translator): { text: string; tone: "" | "warn" | "good" | "bad" } {
  if (item.status === "PENDING") return { text: t("Waiting", "等待中"), tone: "" };
  if (item.status === "CANCELED") return { text: t("Canceled", "已取消"), tone: "" };
  if (item.status === "SKIPPED") return { text: `${t("Skipped", "已跳过")}：${reasonText(item.reason, t)}`, tone: "warn" };
  if (item.jobStatus === "QUEUED" || item.jobStatus === "RUNNING") return { text: t("Running", "运行中"), tone: "good" };
  if (item.jobStatus === "SUCCEEDED")
    return item.reviewedAt ? { text: t("Reviewed", "已看过"), tone: "" } : { text: t("Waiting for review", "待审阅"), tone: "good" };
  if (item.jobStatus === "FAILED") return { text: t("Not finished", "未完成"), tone: "bad" };
  return { text: t("Ended", "已结束"), tone: "" };
}

/** The notice after work was queued by hand. */
export function queuedText(action: string, body: Record<string, unknown>, t: Translator): string {
  const n = (key: string) => (typeof body[key] === "number" ? (body[key] as number) : 0);
  const off =
    body.enabled === false ? t(" The pool is off: turn it on under Settings to run them.", "任务池没开，在设置里打开后才会运行。") : "";
  if (action === "fillNow") return t(`Checked: ${n("added")} added to the pool.`, `检查完成：加入任务池 ${n("added")} 项。`) + off;
  if (action === "reviewLatestRun")
    return (
      (n("queued")
        ? t("The review of the latest rank check is in the pool.", "最近一次排名检查的复盘已排进任务池。")
        : t("That check is in the pool already or was reviewed.", "这次检查已在任务池里，或已经复盘过。")) + (n("queued") ? off : "")
    );
  if (action === "batchMeta" && !n("pages"))
    return t(
      "No low-CTR page to rewrite: every one was rewritten in the last 28 days, is waiting already, or there is no Search Console data.",
      "没有可改写的低点击率页面：都在近 28 天改写过、已在等待，或没有 Search Console 数据。",
    );
  const parts = [t(`Added ${n("queued")} to the pool.`, `已加入任务池 ${n("queued")} 项。`)];
  if (n("existing")) parts.push(t(` ${n("existing")} were there already or done.`, `${n("existing")} 项已在任务池里或已完成。`));
  if (n("remaining")) parts.push(t(` ${n("remaining")} more next time.`, `还有 ${n("remaining")} 个，下次再排。`));
  if (n("unusable")) parts.push(t(` ${n("unusable")} had no body text.`, `${n("unusable")} 个页面没有正文。`));
  return parts.join("") + (n("queued") ? off : "");
}
