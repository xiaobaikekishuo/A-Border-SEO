import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ensureDefaultAlerts } from "@/lib/alerts/evaluate";
import { PageHeader } from "@/components/ui/page-header";
import { EvaluateAlertsButton } from "@/components/sites/evaluate-alerts-button";
import { formatDay } from "@/lib/format";

/** Names for types whose enum name does not read well. */


interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function AlertsPage({ params }: Props) {
  const { t, locale } = await getI18n();
  const alertLabels: Record<string, string> = {
    NOINDEX_SITEWIDE: t("most pages are noindex", "大多数页面为 noindex"),
    TRAFFIC_DROP: t("traffic drop", "流量下降"),
    POSITION_CHANGE: t("position change", "排名变化"),
    NEW_404: t("new 404", "新增 404 页面"),
    CRAWL_ISSUES: t("crawl issues", "抓取问题"),
    VITALS_DEGRADED: t("vitals degraded", "核心网页指标退化"),
  };
  const session = await auth();
  const { siteId } = await params;

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true },
  });
  if (!site || site.userId !== session?.user?.id) redirect("/sites");

  await ensureDefaultAlerts(session!.user!.id, siteId);

  const alerts = await db.alert.findMany({
    where: { userId: session!.user!.id, siteId },
    orderBy: { type: "asc" },
  });

  return (
    <div>
      <PageHeader
        title={t("Alerts", "告警")}
        description={
          <>
            {t("Rules for traffic drops, position changes, crawl health, sites that are mostly noindex and vitals. They are checked after each GSC or Bing sync, after each crawl and when you click Evaluate now. Fired alerts show here and go to your", "监测流量下降、排名变化、抓取健康分、大范围 noindex 及核心指标。每次 GSC 或 Bing 同步、抓取结束及点击立即评估后检查规则。触发的告警显示在这里，并发送到已配置的")}{" "}
            <Link href="/settings#webhook" className="text-link">
              {t("alert webhook", "告警 Webhook")}</Link>{" "}
            {t("and", "和")}{" "}
            <Link href="/settings#email" className="text-link">
              {t("email", "邮箱")}</Link>{" "}
            {t("if you set them up.", "。") }
          </>
        }
        actions={<EvaluateAlertsButton />}
      />

      <div className="panel divide-y divide-border-soft">
        {alerts.map((a) => (
          <div
            key={a.id}
            className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p className="mono-label text-[12px] text-text-strong">
                {alertLabels[a.type] ?? a.type.replaceAll("_", " ")}
              </p>
              <p className="text-xs text-muted-foreground">
                {a.lastFired
                  ? t("Last fired {date}", "最近触发：{date}", {date: formatDay(a.lastFired, { year: true, time: true, locale })})
                  : t("Never fired", "尚未触发")}
              </p>
              <p className="mt-1 font-data text-[11px] text-muted-foreground">
                {JSON.stringify(a.config)}
              </p>
            </div>
            <span
              className={
                a.enabled
                  ? "mono-label rounded-md border border-success/30 bg-success-bg px-2 py-0.5 text-[11px] text-success"
                  : "mono-label rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
              }
            >
              {a.enabled ? t("Enabled", "已启用") : t("Off", "已关闭")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
