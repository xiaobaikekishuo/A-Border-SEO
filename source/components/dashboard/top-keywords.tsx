import { getI18n } from "@/lib/i18n/server";
import Link from "next/link";
import { getTopKeywords } from "@/lib/seo-metrics";
import { getOverviewKeywords } from "@/lib/seo-opportunities";
import { ArrowRight } from "lucide-react";
import { PositionBadge, CtrCell, NumCell } from "@/components/ui/data-table";

interface TopKeywordsProps {
  siteId: string;
  days?: number;
  limit?: number;
}

const th = "mono-label px-4 py-2.5 text-[12px] text-muted-foreground";

export async function TopKeywords({ siteId, days = 28, limit = 10 }: TopKeywordsProps) {
  const { t } = await getI18n();
  const topKeywords = days === 28 && limit <= 10
    ? (await getOverviewKeywords(siteId)).slice(0, limit)
    : await getTopKeywords(siteId, days, limit);

  const maxClicks = Math.max(1, ...topKeywords.map((keyword) => keyword.clicks));

  return (
    <section className="panel overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div>
          <h2 className="text-[14px] leading-5 font-semibold">{t("Top queries", "热门搜索查询")}</h2>
          <p className="text-[12.5px] leading-5 text-muted-foreground">{t("By clicks, last {days} days", "按点击量排序，近 {days} 天", { days })}</p>
        </div>
        <Link href={`/sites/${siteId}/keywords`} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-700 hover:text-brand-800">
          {t("All keywords", "全部关键词")}<ArrowRight className="size-3.5" aria-hidden /></Link>
      </div>

      {topKeywords.length === 0 ? (
        <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
          {t("No keyword data yet. Run a GSC sync.", "暂无关键词数据，请先同步 GSC。")}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-[13px]">
            <thead>
              <tr className="border-b border-border">
                <th className={`${th} text-left`}>{t("Query", "搜索查询")}</th>
                <th className={`${th} text-right`}>{t("Clicks", "点击量")}</th>
                <th className={`${th} text-right`}>{t("Impr.", "曝光量")}</th>
                <th className={`${th} text-right`}>{t("CTR", "点击率")}</th>
                <th className={`${th} text-right`}>{t("Pos.", "排名")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-soft">
              {topKeywords.map((keyword) => (
                <tr key={keyword.query} className="transition-colors hover:bg-bg-section/60">
                  <td className="px-4 py-[11px] text-text-strong">{keyword.query}</td>
                  <td className="px-4 py-[11px] text-right">
                    {/* The bar shows each query's clicks against the top query's. */}
                    <span className="inline-flex items-center justify-end gap-2.5">
                      <span aria-hidden className="hidden h-1 w-14 overflow-hidden rounded-full bg-border sm:block">
                        <span className="block h-full rounded-full bg-chart-1" style={{ width: `${Math.max(2, Math.round((keyword.clicks / maxClicks) * 100))}%` }} />
                      </span>
                      <NumCell value={keyword.clicks} />
                    </span>
                  </td>
                  <td className="px-4 py-[11px] text-right">
                    <NumCell value={keyword.impressions} />
                  </td>
                  <td className="px-4 py-[11px] text-right">
                    <CtrCell ctr={keyword.ctr} />
                  </td>
                  <td className="px-4 py-[11px] text-right">
                    <PositionBadge position={keyword.position} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
