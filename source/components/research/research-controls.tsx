"use client";
import { useEffect, useState } from "react";
import { useUiText } from "@/components/ui/ui-text";
import { confirmedResearchRequest } from "@/lib/dataforseo/paid-request";
import { RESEARCH_LANGUAGE_CODES, RESEARCH_LANGUAGES, RESEARCH_LOCATIONS, type ResearchMarket } from "@/lib/dataforseo/market";

export function useResearchControls(siteId: string, hasDataForSEO: boolean, mode: "keywords" | "domain" | "backlinks" = "keywords") {
  const ui = useUiText();
  const zh = ui.locale === "zh";
  const [paid, setPaid] = useState(false);
  const [market, setMarket] = useState<ResearchMarket | null>(null);
  const [draft, setDraft] = useState<ResearchMarket>({ language: "en", location: 2840 });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    setMarket(null); setPaid(false);
    fetch(`/api/sites/${siteId}/research-settings`).then(async res => {
      if (!res.ok) throw new Error("settings");
      const value = await res.json();
      if (alive) { setMarket(value); setDraft(value); }
    }).catch(() => { if (alive) setError(zh ? "读取目标市场失败，请刷新后重试。" : "Could not load the target market. Refresh to retry."); });
    return () => { alive = false; };
  }, [siteId]);
  const dirty = !market || draft.language !== market.language || draft.location !== market.location;
  async function save() {
    setSaving(true); setError("");
    try {
      const res = await fetch(`/api/sites/${siteId}/research-settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      if (!res.ok) throw new Error("save");
      setMarket(await res.json());
    } catch { setError(zh ? "保存失败，请重试。" : "Could not save. Please retry."); }
    finally { setSaving(false); }
  }
  async function request(url: string, operations: number, target: string, requiresPaid = false): Promise<Response | null> {
    if (requiresPaid && !paid) throw new Error(zh ? "竞争网站研究需选择 DataForSEO，并逐次确认费用。" : "Competitor research needs DataForSEO and confirmation for each request.");
    if (!paid) return fetch(url);
    if (!market || dirty || saving) throw new Error(zh ? "请先保存目标市场，再发起付费查询。" : "Save the target market before a paid request.");
    const country = RESEARCH_LOCATIONS.find(item => item.value === market.location);
    const language = RESEARCH_LANGUAGES.find(item => item.value === market.language);
    const marketLabel = `${country?.[zh ? "zh" : "en"]} / ${language?.[zh ? "zh" : "en"]}`;
    const message = zh
      ? `确认本次付费查询？\n服务：DataForSEO\n目标：${target}\n市场：${marketLabel}\n请求数：${operations} 次（本批次）。外链数据为全球范围。\n费用从你的 DataForSEO 账户扣除，实际金额以服务商定价为准。本工具无法预先保证金额。取消不会发起付费请求。`
      : `Confirm this paid query?\nProvider: DataForSEO\nTarget: ${target}\nMarket: ${marketLabel}\nRequests: ${operations} in this batch. Backlink data is global.\nYour DataForSEO account will be charged at provider rates; the exact amount is not guaranteed here. Cancel sends no paid request.`;
    return confirmedResearchRequest(url, market, operations, message, message => window.confirm(message));
  }
  function errorText(data: { code?: string; error?: string }, fallback: string) {
    if (data.code === "PAYMENT_CONFIRMATION_REQUIRED") return zh ? "需要确认本次 DataForSEO 付费查询。" : "Confirm this paid DataForSEO request first.";
    if (data.code === "MARKET_CHANGED") return zh ? "目标市场已改变，请刷新后重新确认。" : "The market changed. Refresh and confirm again.";
    if (data.code === "PAID_RESEARCH_FAILED") return zh ? "DataForSEO 查询未完成，请检查凭证、余额和服务状态。服务商可能已处理本次请求，重试需要再次确认。" : "DataForSEO did not complete the query. Check credentials, balance and service status. The provider may have processed requests; retry requires confirmation again.";
    return data.error || fallback;
  }
  const controls = <div className="panel space-y-3 p-4">
    <label className="flex flex-wrap items-center gap-3 text-sm">{zh ? "数据来源" : "Data source"}
      <select aria-label={zh ? "数据来源" : "Data source"} value={paid ? "paid" : "free"} onChange={e => setPaid(e.target.value === "paid")} className="rounded border border-border bg-background p-2">
        <option value="free">{mode === "domain" ? (zh ? "免费：已同步 GSC 数据" : "Free: saved GSC data") : mode === "backlinks" ? (zh ? "免费：抓取的出站链接" : "Free: crawled outgoing links") : (zh ? "免费：现有数据 / Google 联想词" : "Free: existing data / Google suggestions")}</option>
        <option value="paid" disabled={!hasDataForSEO}>{zh ? "DataForSEO（付费，逐次确认）" : "DataForSEO (paid, confirm each request)"}</option>
      </select>
    </label>
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <label>{zh ? "目标国家或地区" : "Target country or region"}<select aria-label={zh ? "目标国家或地区" : "Target country or region"} value={draft.location} onChange={e => { const location = Number(e.target.value); const supported = RESEARCH_LANGUAGE_CODES[location]; setDraft({ location, language: supported.includes(draft.language) ? draft.language : supported[0] }); }} className="ml-2 rounded border border-border bg-background p-2">{RESEARCH_LOCATIONS.map(l => <option key={l.value} value={l.value}>{l[zh ? "zh" : "en"]}</option>)}</select></label>
      <label>{zh ? "内容语言" : "Content language"}<select aria-label={zh ? "内容语言" : "Content language"} value={draft.language} onChange={e => setDraft({ ...draft, language: e.target.value })} className="ml-2 rounded border border-border bg-background p-2">{RESEARCH_LANGUAGES.filter(l => RESEARCH_LANGUAGE_CODES[draft.location]?.includes(l.value)).map(l => <option key={l.value} value={l.value}>{l[zh ? "zh" : "en"]}</option>)}</select></label>
      <button type="button" disabled={!dirty || saving || !market} onClick={save} className="rounded border border-border px-3 py-2 disabled:opacity-50">{saving ? (zh ? "保存中…" : "Saving…") : (zh ? "保存市场" : "Save market")}</button>
    </div>
    <p className="text-xs text-muted-foreground">{zh ? "语言选项随国家或地区更新；请确认后保存。设置按站点保存，仅影响 DataForSEO 关键词和域名排名研究。界面语言不会改变目标市场；GSC 保持现有范围，外链为全球数据。" : "Language choices update with the country or region; review before saving. Saved per site for DataForSEO keyword and domain ranking research. UI language does not change the market. GSC keeps its existing scope; backlinks are global."} {paid && <a className="text-link" href="https://dataforseo.com/pricing" target="_blank" rel="noreferrer">{zh ? "查看服务商价格" : "Provider pricing"}</a>}</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
  return { request, errorText, controls, paid };
}
