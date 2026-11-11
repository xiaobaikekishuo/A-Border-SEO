"use client";

import { useUiText, identityUiText, type UiTranslator } from "@/components/ui/ui-text";


import { useDeferredValue, useMemo, useState } from "react";
import { DeleteKeywordButton } from "@/components/sites/saved-keyword-actions";
import {
  PositionBadge,
  MetricTable,
  CtrCell,
  NumCell,
  useTableSort,
  sortRows,
  sortLabel,
  SearchField,
  type MetricHeader,
} from "@/components/ui/data-table";

const HEADERS: MetricHeader[] = [
  { label: "Keyword", sortKey: "query", defaultDir: "asc" },
  { label: "Notes" },
  { label: "Position", align: "right", sortKey: "position", defaultDir: "asc" },
  { label: "Clicks", align: "right", sortKey: "clicks" },
  { label: "Impr.", align: "right", sortKey: "impressions" },
  { label: "CTR", align: "right", sortKey: "ctr" },
  { label: "Actions", align: "right" },
];

export interface SavedKeywordRowData {
  id: string;
  query: string;
  notes: string | null;
  position: number | null;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
}

export function SavedKeywordsTable({
  rows,
  siteId,
}: {
  rows: SavedKeywordRowData[];
  siteId: string;
}) {
  const ui = useUiText();
  const [search, setSearch] = useState("");
  const { sort, toggle } = useTableSort({ key: "clicks", dir: "desc" });

  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const filtered = useMemo(() => {
    const out = deferredSearch
      ? rows.filter(
          (r) =>
            r.query.toLowerCase().includes(deferredSearch) ||
            (r.notes ?? "").toLowerCase().includes(deferredSearch)
        )
      : rows;
    return sortRows(out, sort);
  }, [rows, deferredSearch, sort, ui]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder={ui("Filter by keyword or note...")}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="panel px-4 py-10 text-center">
          <p className="font-medium text-text-strong">{ui("No saved keywords match")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{ui("Loosen the search.")}</p>
        </div>
      ) : (
        <MetricTable
          sort={sort}
          onSort={toggle}
          headers={HEADERS}
          footer={ui("Showing {0} of {1} saved keywords · last 28 days aggregated · sorted by {2}", { "0": filtered.length, "1": rows.length, "2": sortLabel(HEADERS, sort, ui) })}
        >
          {filtered.map((kw) => (
            <tr key={kw.id} className="transition-colors hover:bg-bg-soft">
              <td className="px-4 py-3 font-medium text-text-strong">{kw.query}</td>
              <td className="max-w-xs truncate px-4 py-3 text-muted-foreground">
                {kw.notes || ui("n/a")}
              </td>
              <td className="px-4 py-3 text-right">
                {kw.position != null ? <PositionBadge position={kw.position} /> : ui("n/a")}
              </td>
              <td className="px-4 py-3 text-right">
                {kw.clicks != null ? <NumCell value={kw.clicks} /> : ui("n/a")}
              </td>
              <td className="px-4 py-3 text-right">
                {kw.impressions != null ? <NumCell value={kw.impressions} /> : ui("n/a")}
              </td>
              <td className="px-4 py-3 text-right">
                {kw.ctr != null ? <CtrCell ctr={kw.ctr} /> : ui("n/a")}
              </td>
              <td className="px-4 py-3 text-right">
                <DeleteKeywordButton siteId={siteId} query={kw.query} />
              </td>
            </tr>
          ))}
        </MetricTable>
      )}
    </div>
  );
}
