"use client";

import { useUiText } from "@/components/ui/ui-text";


import { useResearchControls } from "./research-controls";
import { useEffect, useState } from "react";
import { KeywordAiPanel } from "./keyword-ai-panel";
import { ManusKeywordPanel } from "./manus-keyword-panel";
import { useI18n } from "@/lib/i18n/client";
import {
  Search,
  Loader2,
  Bookmark,
  Check,
  AlertTriangle,
  Sparkles,
  Telescope,
} from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

type KeywordResult = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: number | null;
  trend: number[] | null;
};

export function KeywordResearchClient({
  siteId,
  hasDataForSEO,
}: {
  siteId: string;
  hasDataForSEO: boolean;
}) {
  const ui = useUiText();
  const { t } = useI18n();
  const [mode, setMode] = useState<"sources" | "chatgpt" | "manus">("sources");
  const [openedAi, setOpenedAi] = useState(false);
  const [openedManus, setOpenedManus] = useState(false);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("mode") === "chatgpt" || query.has("chatgpt")) { setMode("chatgpt"); setOpenedAi(true); }
    if (query.get("mode") === "manus") { setMode("manus"); setOpenedManus(true); }
  }, []);
  return <div className="space-y-6">
    <div className="flex flex-wrap gap-3" role="group" aria-label={ui.locale === "zh" ? "关键词研究方式" : "Keyword research mode"}>
      <button type="button" aria-pressed={mode === "sources"} onClick={() => setMode("sources")} className={buttonVariants({ variant: mode === "sources" ? "default" : "outline" })}><Search size={16} />{ui.locale === "zh" ? "现有数据与联想词" : "Search data and suggestions"}</button>
      <button type="button" aria-pressed={mode === "chatgpt"} onClick={() => { setMode("chatgpt"); setOpenedAi(true); }} className={buttonVariants({ variant: mode === "chatgpt" ? "default" : "outline" })}><Sparkles size={16} />{ui.locale === "zh" ? "ChatGPT 关键词建议" : "ChatGPT keyword ideas"}</button>
      <button type="button" aria-pressed={mode === "manus"} onClick={() => { setMode("manus"); setOpenedManus(true); }} className={buttonVariants({ variant: mode === "manus" ? "default" : "outline" })}><Telescope size={16} />{t("Manus deep research", "Manus 深度研究")}</button>
    </div>
    <div hidden={mode !== "sources"}><KeywordDataResearch siteId={siteId} hasDataForSEO={hasDataForSEO} /></div>
    {openedAi && <div hidden={mode !== "chatgpt"}><KeywordAiPanel key={siteId} siteId={siteId} /></div>}
    {openedManus && <div hidden={mode !== "manus"}><ManusKeywordPanel key={siteId} siteId={siteId} /></div>}
  </div>;
}

function KeywordDataResearch({ siteId, hasDataForSEO }: { siteId: string; hasDataForSEO: boolean }) {
  const ui = useUiText();
  const research = useResearchControls(siteId, hasDataForSEO);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<KeywordResult[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [savedSet, setSavedSet] = useState<Set<string>>(new Set());
  const [savingSet, setSavingSet] = useState<Set<string>>(new Set());

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || loading) return;

    setError(null);
    setLoading(true);
    setResults([]);
    setSource(null);

    try {
      const res = await research.request(
        `/api/sites/${siteId}/keyword-research?q=${encodeURIComponent(query.trim())}`, 1, query.trim()
      );
      if (!res) return;
      const data = await res.json();
      if (!res.ok) throw new Error(research.errorText(data, ui("Keyword research failed")));
      setResults(data.keywords ?? []);
      setSource(data.source ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : ui("Keyword research failed"));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(keyword: string) {
    setSavingSet((prev) => new Set(prev).add(keyword));

    try {
      const res = await fetch(`/api/sites/${siteId}/saved-keywords`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: keyword }),
      });
      if (res.ok) {
        setSavedSet((prev) => new Set(prev).add(keyword));
      }
    } catch {
      // ignore
    } finally {
      setSavingSet((prev) => {
        const next = new Set(prev);
        next.delete(keyword);
        return next;
      });
    }
  }

  return (
    <div className="space-y-4">
      {research.controls}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {/* Autocomplete fallback banner */}
      {!hasDataForSEO && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning-bg p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="text-sm">
            <p className="font-medium text-text-strong">
              {ui("Limited data: Google Autocomplete only")}</p>
            <p className="mt-0.5 text-muted-foreground">
              {ui("Add a DataForSEO API key in")}{" "}
              <Link
                href="/settings?connect=dataforseo#connections"
                className="text-link"
              >
                {ui("Settings")}</Link>{" "}
              {ui("for search volume, difficulty, and CPC data.")}</p>
          </div>
        </div>
      )}

      {/* Search input */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={ui("Enter a seed keyword...")}
            className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand-500 focus:bg-bg focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={!query.trim() || loading}
          className={buttonVariants()}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Search className="size-4" />
          )}
          {ui("Research")}</button>
      </form>

      {/* Results */}
      {results.length > 0 && (
        <div className="panel overflow-hidden">
          {source === "autocomplete" && (
            <div className="border-b border-border bg-bg-soft px-4 py-2 text-xs text-muted-foreground">
              {ui("Showing Google Autocomplete suggestions: volume and difficulty data requires DataForSEO")}</div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    {ui("Keyword")}</th>
                  {source === "dataforseo" && (
                    <>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                        {ui("Volume")}</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                        {ui("Difficulty")}</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                        CPC
                      </th>
                    </>
                  )}
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    {ui("Action")}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => {
                  const isSaved = savedSet.has(result.keyword);
                  const isSaving = savingSet.has(result.keyword);

                  return (
                    <tr
                      key={result.keyword}
                      className="border-b border-border transition-colors hover:bg-bg-soft"
                    >
                      <td className="max-w-md px-4 py-3">
                        <span className="font-medium text-text-strong">
                          {result.keyword}
                        </span>
                      </td>
                      {source === "dataforseo" && (
                        <>
                          <td className="px-4 py-3 text-right font-data text-foreground">
                            {result.volume?.toLocaleString() ?? ui("n/a")}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <DifficultyBadge value={result.difficulty} />
                          </td>
                          <td className="px-4 py-3 text-right font-data text-foreground">
                            {result.cpc != null ? `$${result.cpc.toFixed(2)}` : ui("n/a")}
                          </td>
                        </>
                      )}
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleSave(result.keyword)}
                          disabled={isSaved || isSaving}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                          {isSaved ? (
                            <>
                              <Check className="size-3 text-success" />
                              {ui("Saved")}</>
                          ) : isSaving ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <>
                              <Bookmark className="size-3" />
                              {ui("Save")}</>
                          )}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border bg-bg-soft px-4 py-2 text-xs text-muted-foreground">
            {results.length}{ui(" keyword")}{ui.locale !== "zh" && results.length !== 1 ? "s" : ""}{ui(" found")}{source === "dataforseo" ? ui(" via DataForSEO") : ui(" via Google Autocomplete")}
          </div>
        </div>
      )}

      {/* Empty state after search */}
      {!loading && results.length === 0 && source !== null && (
        <div className="panel flex flex-col items-center py-12 text-center">
          <Search className="size-10 text-text-faint" />
          <p className="mt-3 font-medium text-text-strong">{ui("No results found")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {ui("Try a different seed keyword")}</p>
        </div>
      )}
    </div>
  );
}

function DifficultyBadge({ value }: { value: number | null }) {
  const ui = useUiText();
  if (value == null) return <span className="font-data text-muted-foreground">{ui("n/a")}</span>;

  let color = "text-success";
  if (value >= 70) color = "text-danger";
  else if (value >= 40) color = "text-warning";

  return (
    <span className={`font-data font-medium ${color}`}>{value}</span>
  );
}
