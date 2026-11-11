"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Ga4SetupGuide } from "./ga4-setup-guide";

interface CodeResponse { code?: string; error?: string; }
type Identity = {
  initCodeClient(config: {
    client_id:string; scope:string; ux_mode:"popup"; include_granted_scopes:false;
    callback:(response:CodeResponse)=>void; error_callback:()=>void;
  }):{requestCode():void}
};

function identity():Identity | undefined {
  return (window as unknown as {google?:{accounts?:{oauth2?:Identity}}}).google?.accounts?.oauth2;
}
let loadingScript:Promise<void> | undefined;
function loadIdentityScript():Promise<void> {
  if (identity()) return Promise.resolve();
  if (loadingScript) return loadingScript;
  loadingScript = new Promise<void>((resolve,reject) => {
    const tag = document.createElement("script");
    const fail = () => { clearTimeout(timeout); tag.remove(); loadingScript = undefined; reject(new Error("GIS_LOAD")); };
    const timeout = window.setTimeout(fail,15_000);
    tag.src = "https://accounts.google.com/gsi/client";
    tag.async = true;
    tag.referrerPolicy = "no-referrer";
    tag.onload = () => { clearTimeout(timeout); if (identity()) resolve(); else fail(); };
    tag.onerror = fail;
    document.head.appendChild(tag);
  });
  return loadingScript;
}

type Props = { siteId:string; domain:string; oauthClientId?:string; expectedUpdatedAt:string|null; onSaved:()=>void; disabled?:boolean };
type Stage = "idle" | "preparing" | "ready" | "consent" | "sync";
function dayAgo(days:number) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0,10);
}

export default function GeoGaConnection({siteId,domain,oauthClientId,expectedUpdatedAt,onSaved,disabled}:Props) {
  const { t } = useI18n();
  const [stage,setStage] = useState<Stage>("idle");
  const [property,setProperty] = useState("");
  const [start,setStart] = useState(() => dayAgo(28));
  const [end,setEnd] = useState(() => dayAgo(1));
  const [status,setStatus] = useState("");
  const [clientId,setClientId] = useState("");
  const attempt = useRef(0);
  const locked = useRef(false);
  const endpoint = "/api/sites/" + encodeURIComponent(siteId) + "/geo/ga4";
  useEffect(() => () => { attempt.current++; },[siteId]);
  const busy = stage === "preparing" || stage === "consent" || stage === "sync";
  const btn = "rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50";
  const field = "mt-1 block w-full rounded-lg border border-border bg-background p-2 text-sm";
  const days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  const valid = /^[1-9][0-9]{0,19}$/.test(property.trim()) && days >= 1 && days <= 93;
  function message(code:string) {
    switch (code) {
      case "GA_AUTH": case "GA_SCOPE": return t("Google authorization expired or Analytics permission was declined. Authorize the report again.", "Google 授权已失效或未授予 Analytics 只读权限，请重新授权本次报表。");
      case "GA_CONFIG": return t("Set up Google OAuth for this local installation.", "请先完成本机的 Google OAuth 配置。");
      case "GA_API_DISABLED": return t("The Analytics Data API is disabled in the calling project. Enable it in the Cloud project shown in the first sync guide, wait for activation and sync again.", "Google 提示调用项目尚未启用 Analytics Data API。请打开「首次同步指南」，在对应 Cloud 项目启用该 API，待生效后同步。");
      case "GA_SCOPE_INSUFFICIENT": return t("Google reported insufficient OAuth scope. Add analytics.readonly to the OAuth project's Data Access settings and grant Analytics access in the consent window.", "Google 提示 OAuth 授权范围不足。请在 OAuth 项目的「数据访问」添加 analytics.readonly，并在授权窗口允许读取 Analytics 数据。");
      case "GA_PROPERTY_ACCESS": return t("Google denied access to this property. Check the numeric property ID and select an account with Viewer access in GA4 Property access management.", "Google 提示当前授权账号无权读取此媒体资源。请核对数字 ID，并在 GA4「媒体资源访问权限管理」确认该账号具备查看者权限。");
      case "GA_PROPERTY_NOT_FOUND": return t("Google returned 404 for this property. Confirm the numeric property ID in GA4 and choose an account that can open its reports.", "Google 未找到可读取的媒体资源（404）。请在 GA4 确认数字媒体资源 ID，再选择能打开其报表的 Google 账号。");
      case "GA_ACCESS": return t("Google denied the report request (403) without a recognized reason. Check the selected account's property access and the calling project's Analytics Data API settings.", "Google 拒绝了报表请求（403），具体原因待确认。请核对授权账号的媒体资源权限和调用项目的 Analytics Data API 状态。");
      case "GA_INPUT": case "GA_LIMIT": return t("Check the numeric property ID and shorten the reporting period (maximum 93 days and 3,000 rows).", "请核对数字媒体资源 ID 并缩短日期范围，每次最多 93 天、3,000 行。");
      case "GA_REPORT": return t("Google could not run this report for this property. Check the property ID and dates.", "Google 无法为该媒体资源运行报表，请核对 ID 和日期。");
      case "GA_NO_HOST_DATA": return t("GA4 returned no sessions for this hostname in the selected dates. Check the property, hostname and date range.", "GA4 在所选日期内没有返回该主机名的会话，请核对资源、域名和日期。");
      case "GA_QUOTA": return t("The request limit was reached. Sync again later.", "已达到请求次数限制，请稍后同步。");
      case "GA_STALE": return t("This snapshot changed. Review the refreshed snapshot before syncing again.", "最新快照已变动，请核对刷新后的数据再同步。");
      case "GA_SESSION": return t("Sign in to this site again, then reopen the report.", "请重新登录当前站点，再打开报表。");
      default: return t("Could not confirm the sync. Refresh the snapshot and check the Google connection before trying again.", "同步状态待确认，请刷新快照并检查 Google 连接后再试。");
    }
  }
  async function prepare() {
    if (locked.current || disabled) return;
    const id = ++attempt.current;
    locked.current = true; setStage("preparing"); setStatus("");
    try {
      const config = await fetch(endpoint,{cache:"no-store"});
      if (!config.ok) throw new Error(config.status === 401 ? "GA_SESSION" : "GA_CONFIG");
      const {clientId:client} = await config.json();
      if (typeof client !== "string" || !client) throw new Error("GA_CONFIG");
      await loadIdentityScript();
      if (attempt.current === id) { setClientId(client); setStage("ready"); }
    } catch (err) {
      if (attempt.current === id) {
        setStage("idle");
        setStatus(err instanceof Error && err.message === "GIS_LOAD" ? t("Google sign-in could not load. Check your browser's connection to accounts.google.com.", "无法加载 Google 授权窗口，请检查浏览器到 accounts.google.com 的连接。") : message(err instanceof Error ? err.message : ""));
      }
    } finally { if (attempt.current === id) locked.current = false; }
  }
  function authorize() {
    if (!valid || stage !== "ready" || locked.current || disabled) return;
    if (expectedUpdatedAt && !window.confirm(t("Replace the current GA4 snapshot for " + domain + " with this reporting period?", "用本次报表替换 " + domain + " 当前保存的 GA4 快照？"))) return;
    const id = ++attempt.current;
    const attemptedProperty = property.trim();
    const oauth = identity();
    if (!oauth) { setStage("idle"); return; }
    const reset = (info:string) => {
      if (id !== attempt.current) return;
      locked.current = false;
      setStatus(t("GA4 property ", "GA4 媒体资源 ") + attemptedProperty + " · " + info);
      setStage("ready");
    };
    locked.current = true; setStage("consent"); setStatus("");
    try {
      oauth.initCodeClient({
        client_id:clientId,scope:"https://www.googleapis.com/auth/analytics.readonly",include_granted_scopes:false,ux_mode:"popup",
        error_callback:() => reset(t("The Google window closed or was blocked. Allow popups and authorize again.", "Google 授权窗口已关闭或被拦截，请允许弹窗后重新授权。")),
        callback: async (grant) => {
          if (attempt.current !== id) return;
          if (grant.error || !grant.code) { reset(message("GA_AUTH")); return; }
          setStage("sync");
          try {
            const response = await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"XmlHttpRequest"},
              body:JSON.stringify({code:grant.code,propertyId:attemptedProperty,start,end,expectedUpdatedAt})});
            if (attempt.current !== id) return;
            if (response.status === 409) { onSaved(); reset(message("GA_STALE")); return; }
            if (!response.ok) {
              const detail = await response.json().catch(() => ({}));
              reset(message(response.status === 401 ? "GA_SESSION" : detail.error)); return;
            }
            onSaved();
            reset(t("GA4 report saved for this site.", "已保存当前站点的 GA4 报表。"));
          } catch { reset(message("GA_NETWORK")); }
        }
      }).requestCode();
    } catch { reset(message("GA_AUTH")); }
  }

  return <details className="rounded-xl border border-border bg-card p-4">
    <summary className="cursor-pointer font-medium">{t("Sync from Google Analytics 4", "从 Google Analytics 4 同步")}</summary>
    <div className="mt-4 grid gap-4">
      <p className="text-sm text-muted-foreground">{t("Read sessions for the exact hostname " + domain + " and recognized AI sources. Each sync saves one date range.", "读取主机名 " + domain + " 下可识别 AI 来源的会话数，每次同步保存一个日期范围。")}</p>
      <fieldset disabled={busy || disabled} onChangeCapture={() => setStatus("")} className="grid gap-3 sm:grid-cols-3">
        <label>{t("GA4 property ID", "GA4 媒体资源 ID")}<input className={field} inputMode="numeric" maxLength={20} autoComplete="off" value={property} onChange={e => setProperty(e.target.value)} placeholder={t("Numeric ID", "纯数字 ID")} /></label>
        <label>{t("Start date", "开始日期")}<input className={field} type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
        <label>{t("End date", "结束日期")}<input className={field} type="date" value={end} min={start} onChange={e => setEnd(e.target.value)} /></label>
      </fieldset>
      <p className="text-xs text-muted-foreground">{t("In GA4, open Admin → Property details to copy the numeric ID. Choose a period of up to 93 days.", "在 GA4「管理 → 媒体资源详情」复制数字 ID，选择最多 93 天。")}</p>
      <Ga4SetupGuide domain={domain} oauthClientId={oauthClientId}/>
      <div className="flex flex-wrap gap-2">
        {stage === "idle" || stage === "preparing" ? <button type="button" disabled={busy || disabled} className={btn} onClick={() => void prepare()}>{stage === "preparing" ? t("Loading Google sign-in…", "正在加载 Google 授权…") : t("Prepare Google connection", "准备 Google 连接")}</button> :
        <button type="button" className={btn} disabled={!valid || busy || disabled} onClick={authorize}>{stage === "consent" ? t("Waiting for Google…", "等待 Google 授权…") : stage === "sync" ? t("Reading report…", "正在读取报表…") : t("Authorize and sync report", "授权并同步报表")}</button>}
        {stage === "consent" && <button type="button" className={btn} onClick={() => {attempt.current++; locked.current = false; setStage("ready");}}>{t("Cancel", "取消")}</button>}
      </div>
      {status && <p role="status" className="text-sm">{status}</p>}
    </div>
  </details>;
}
