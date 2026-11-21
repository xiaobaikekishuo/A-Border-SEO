"use client";

import { useUiText, identityUiText, type UiTranslator } from "@/components/ui/ui-text";


import { useDeferredValue, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  MetricTable,
  useTableSort,
  sortRows,
  sortLabel,
  SearchField,
  type MetricHeader,
} from "@/components/ui/data-table";
import { formatDay } from "@/lib/format";
import { assessCoreWebVitals, type VitalsAssessment } from "@/lib/google/pagespeed-field";

const HEADERS: MetricHeader[] = [
  { label: "URL", sortKey: "url", defaultDir: "asc" },
  { label: "Score", align: "right", sortKey: "perfScore", defaultDir: "asc" },
  { label: "LCP (lab)", align: "right", sortKey: "lcp" },
  { label: "CLS (lab)", align: "right", sortKey: "cls" },
  { label: "TBT (lab)", align: "right", sortKey: "tbt" },
  { label: "TTFB", align: "right", sortKey: "ttfb" },
  { label: "Field p75: LCP · INP · CLS", align: "right", sortKey: "fieldInp" },
  { label: "Core Web Vitals", sortKey: "assessment" },
  { label: "When", sortKey: "date" },
];

const ASSESSMENT_ORDER: Record<VitalsAssessment["status"], number> = { FAIL: 0, INCOMPLETE: 1, NO_FIELD_DATA: 2, PASS: 3 };

export interface VitalsRowData {
  id: string;
  url: string;
  perfScore: number | null;
  lcp: number | null;
  cls: number | null;
  /** Lab INP: Lighthouse never measures it, so older reports show it empty. */
  inp: number | null;
  ttfb: number | null;
  /** Lab Total Blocking Time (ms). */
  tbt?: number | null;
  /** Chrome UX Report p75: URL (this page) or ORIGIN (the whole site). */
  fieldSource?: "URL" | "ORIGIN" | null;
  fieldLcp?: number | null;
  fieldInp?: number | null;
  fieldCls?: number | null;
  /** ISO string, serialized across the RSC boundary */
  date: string;
}

const STATUS_TEXT: Record<VitalsAssessment["status"], string> = {
  PASS: "Passed", FAIL: "Not passed", INCOMPLETE: "Not enough data", NO_FIELD_DATA: "No field data",
};

export function VitalsTable({ rows }: { rows: VitalsRowData[] }) {
  const ui = useUiText();
  const [search, setSearch] = useState("");
  const { sort, toggle } = useTableSort({ key: "date", dir: "desc" });

  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const filtered = useMemo(() => {
    const assessed = rows.map((r) => {
      const assessment = assessCoreWebVitals(r.fieldSource ? { source: r.fieldSource, lcp: r.fieldLcp ?? undefined, inp: r.fieldInp ?? undefined, cls: r.fieldCls ?? undefined } : null);
      return { ...r, assessmentResult: assessment, assessment: ASSESSMENT_ORDER[assessment.status] };
    });
    const out = deferredSearch
      ? assessed.filter((r) => r.url.toLowerCase().includes(deferredSearch))
      : assessed;
    return sortRows(out, sort);
  }, [rows, deferredSearch, sort, ui]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <SearchField value={search} onChange={setSearch} placeholder={ui("Filter by URL...")} />
      </div>

      {filtered.length === 0 ? (
        <div className="panel px-4 py-10 text-center">
          <p className="font-medium text-text-strong">{ui("No reports match")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{ui("Loosen the search.")}</p>
        </div>
      ) : (
        <MetricTable
          sort={sort}
          onSort={toggle}
          headers={HEADERS}
          footer={ui("Showing {0} of {1} reports · sorted by {2}", { "0": filtered.length, "1": rows.length, "2": sortLabel(HEADERS, sort, ui) })}
        >
          {filtered.map((r) => (
            <tr key={r.id} className="hover:bg-bg-soft">
              <td className="max-w-xs truncate px-4 py-2.5 font-medium" title={r.url}>
                {r.url}
              </td>
              <td className="px-4 py-2.5 text-right font-data">
                <span
                  className={cn(
                    (r.perfScore ?? 0) >= 90
                      ? "text-success"
                      : (r.perfScore ?? 0) >= 50
                        ? "text-warning"
                        : "text-danger"
                  )}
                >
                  {r.perfScore ?? ui("n/a")}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right font-data">
                {r.lcp != null ? `${r.lcp.toFixed(2)}s` : ui("n/a")}
              </td>
              <td className="px-4 py-2.5 text-right font-data">
                {r.cls != null ? r.cls.toFixed(3) : ui("n/a")}
              </td>
              <td className="px-4 py-2.5 text-right font-data">
                {r.tbt != null ? `${Math.round(r.tbt)}ms` : ui("n/a")}
              </td>
              <td className="px-4 py-2.5 text-right font-data">
                {r.ttfb != null ? `${r.ttfb.toFixed(2)}s` : ui("n/a")}
              </td>
              <td className="px-4 py-2.5 text-right font-data" title={r.fieldSource === "ORIGIN" ? ui("Whole-site data: this page has too few Chrome visits of its own") : undefined}>
                {r.fieldSource ? <>
                  {r.fieldLcp != null ? `${r.fieldLcp.toFixed(1)}s` : "–"} · {r.fieldInp != null ? `${Math.round(r.fieldInp)}ms` : "–"} · {r.fieldCls != null ? r.fieldCls.toFixed(2) : "–"}
                  {r.fieldSource === "ORIGIN" && <span className="ml-1 text-xs text-muted-foreground">{ui("(site)")}</span>}
                </> : ui("n/a")}
              </td>
              <td className="px-4 py-2.5 text-sm" title={r.assessmentResult.missing.length && r.assessmentResult.status !== "NO_FIELD_DATA" ? ui("No field data for: {0}", { "0": r.assessmentResult.missing.map((m) => m.toUpperCase()).join(", ") }) : undefined}>
                <span className={cn(
                  r.assessmentResult.status === "PASS" ? "text-success"
                    : r.assessmentResult.status === "FAIL" ? "text-danger"
                      : "text-muted-foreground"
                )}>{ui(STATUS_TEXT[r.assessmentResult.status])}</span>
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {formatDay(r.date, { locale: ui.locale, year: true, time: true })}
              </td>
            </tr>
          ))}
        </MetricTable>
      )}
    </div>
  );
}
