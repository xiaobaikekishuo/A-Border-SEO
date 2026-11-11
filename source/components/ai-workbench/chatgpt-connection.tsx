"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Link2, Loader2, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import s from "./workbench.module.css";

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
export type AccountExecution = { provider: "CHATGPT_APP" | "CODEX_LOCAL"; profileId?: string; model?: string; planOnlyConfirmed?: boolean; ready: boolean };
type Profile = { id: string; label: string; email?: string | null; connected: boolean; sharing: boolean };
type Connection = { connected: boolean; sharing: boolean; profileId: string | null; email?: string | null; profiles: Profile[]; models: { slug: string; displayName: string }[]; modelError?: string | null };

export function ChatGPTConnection({ siteId, disabled, onChange, returnPage = "assistant", appOnly = false }: { siteId: string; disabled: boolean; onChange: (execution: AccountExecution) => void; returnPage?: "assistant" | "keyword-research" | "domain-overview" | "backlinks"; appOnly?: boolean }) {
  const { t } = useI18n();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [provider, setProvider] = useState<AccountExecution["provider"]>(appOnly ? "CHATGPT_APP" : "CODEX_LOCAL");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creditsDisabled, setCreditsDisabled] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const initialized = useRef(false);
  const selectedProfile = useRef<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("chatgpt");
    if (result === "connected") setNotice(t("ChatGPT sign-in completed. Check the granted plan permission below before generating.", "ChatGPT 登录已完成。生成前，请检查下方是否已允许使用套餐。"));
    if (result === "error") setCallbackError(url.searchParams.get("chatgptError") || "connection_unavailable");
    if (result) { url.searchParams.delete("chatgpt"); url.searchParams.delete("chatgptError"); window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash); }
  }, [t]);

  function message(code: string) {
    if (/access_denied|denied|authorization_declined/i.test(code)) return t("ChatGPT authorization was declined. Use Continue with ChatGPT to try again.", "ChatGPT 授权未获同意。要重新授权，请点击 Continue with ChatGPT。");
    if (code === "chatgpt_connection_unavailable") return t("OpenAI's authorization service could not complete the request. Refresh the connection. If this persists, check whether the local server can reach auth.openai.com.", "OpenAI 授权服务暂未完成请求。请刷新连接。如果持续出现，请检查本地工作台能否访问 auth.openai.com。");
    if (code === "chatgpt_refresh_not_ready") return t("ChatGPT is not ready to renew this authorization yet. Wait a moment, then refresh the connection.", "ChatGPT 尚未允许续期。请稍等片刻，再点击刷新连接。");
    if (code === "chatgpt_state_invalid" || code === "chatgpt_state_expired" || code === "chatgpt_connection_changed") return t("This sign-in attempt is no longer current. Start again with Continue with ChatGPT.", "本次登录请求已失效。请点击 Continue with ChatGPT，重新发起授权。");
    if (code === "Unauthorized") return t("Sign back into the local A-Border SEO dashboard, then refresh the ChatGPT connection.", "请重新登录本地 A-Border SEO 工作台，再刷新 ChatGPT 连接。");
    if (/usage_limit|quota|rate.limit/i.test(code)) return t("This connection reached a usage limit. Review its app limit in ChatGPT, then start a new task when available.", "此连接已达到使用限制。请在 ChatGPT 查看应用上限，恢复后再手动新建任务。");
    if (/not_eligible/i.test(code)) return t("This ChatGPT account is not eligible for plan usage in this app.", "此 ChatGPT 账号当前不支持在此应用中使用套餐。");
    if (/permission|sharing|scope/i.test(code)) return t("Sign in again and allow this app to use your ChatGPT plan.", "请重新授权，并允许此应用使用你的 ChatGPT 套餐。");
    if (/expired|token|login|required|identity|session/i.test(code)) return t("The connection needs a new sign-in. Use Continue with ChatGPT for this saved account.", "连接需要重新登录，请为这个已保存账号点击 Continue with ChatGPT。");
    if (/model/i.test(code)) return t("The model list could not be loaded. Refresh this connection before generating.", "暂时无法读取模型列表，请刷新连接后再生成。");
    return t("The connection could not be updated. Refresh its status or try signing in again.", "未能更新连接。请刷新状态，或重新登录。");
  }

  const refresh = useCallback(async ({ signal, manual = false }: { signal?: AbortSignal; manual?: boolean } = {}) => {
    const sequence = ++requestId.current;
    setBusy("load"); setError(null);
    try {
      const response = await fetch("/api/chatgpt-connection?models=1", { cache: "no-store", signal });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.profiles) || !Array.isArray(result.models)) throw new Error(result.error || "connection_unavailable");
      if (signal?.aborted || sequence !== requestId.current) return;
      const incoming = result as Connection;
      const profileChanged = selectedProfile.current !== incoming.profileId;
      selectedProfile.current = incoming.profileId;
      setConnection(incoming);
      if (manual) setCallbackError(null);
      setModel(current => {
        if (!profileChanged && incoming.models.some(item => item.slug === current)) return current;
        return incoming.models[0]?.slug ?? "";
      });
      if (profileChanged) setCreditsDisabled(false);
      if (!initialized.current) { setProvider(appOnly || incoming.connected && incoming.sharing ? "CHATGPT_APP" : "CODEX_LOCAL"); initialized.current = true; }
    } catch (cause) {
      if (!signal?.aborted && sequence === requestId.current) { setError(cause instanceof Error ? cause.message : "connection_unavailable"); setConnection(null); }
    } finally { if (!signal?.aborted && sequence === requestId.current) setBusy(null); }
  }, [appOnly]);

  useEffect(() => {
    const controller = new AbortController(); void refresh({ signal: controller.signal });
    return () => { controller.abort(); requestId.current++; };
  }, [refresh]);

  const appReady = !!connection?.connected && connection.sharing && !!connection.profileId && connection.models.some(item => item.slug === model) && creditsDisabled;
  useEffect(() => {
    onChange({ provider, ...(provider === "CHATGPT_APP" ? { profileId: connection?.profileId ?? undefined, model, planOnlyConfirmed: creditsDisabled } : {}), ready: !busy && (provider === "CODEX_LOCAL" || appReady) });
  }, [provider, connection?.profileId, model, creditsDisabled, appReady, busy, onChange]);

  async function act(action: "connect" | "select" | "disconnect", profileId?: string, newProfile = false) {
    if (busy || disabled) return;
    setBusy(action); setError(null); setCallbackError(null); setNotice(null);
    try {
      const response = await fetch("/api/chatgpt-connection", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...(profileId ? { profileId } : {}), ...(action === "connect" ? { newProfile, returnPath: `/sites/${siteId}/${returnPage}` } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "connection_unavailable");
      if (action === "connect") {
        const url = new URL(result.url);
        if (url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize") throw new Error("unexpected_authorization_url");
        window.location.assign(url.toString());
        return;
      }
      if (action === "disconnect") {
        setCreditsDisabled(false); setDisconnecting(false);
        setNotice(result.remoteRevocationConfirmed === false ? t("Local credentials were cleared. Remote sign-out was not confirmed; disconnect A-Border SEO Local in ChatGPT settings.", "本机凭据已清除。未确认远程注销，请在 ChatGPT 设置中断开 A-Border SEO Local。") : t("Signed out. The saved registration is kept for reconnecting.", "已退出登录，保留注册记录供下次重新连接。"));
      }
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "connection_unavailable"); }
    finally { setBusy(null); }
  }

  const modelsUnavailable = connection?.sharing && connection.models.length === 0;
  let status = t("Independent app not connected", "独立应用尚未连接");
  if (connection?.connected) {
    if (modelsUnavailable) status = t("Authorization saved · model list unavailable", "授权已保存 · 模型列表暂不可用");
    else if (connection.sharing) status = t("Connected · ChatGPT plan enabled", "已连接 · 已允许使用 ChatGPT 套餐");
    else status = t("Connected · plan permission required", "已登录 · 尚未允许使用套餐");
  }
  return <section className={s.appConnection} aria-label={t("ChatGPT app connection", "ChatGPT 应用连接")}>
    <div className={s.appConnectionHeading}>
      <div className={s.appTitle}><span className={s.appIcon}><Link2 size={21} /></span><div><h2>A-Border SEO</h2><p>{t("ChatGPT connection · registered as A-Border SEO Local", "ChatGPT 连接 · 授权名称为 A-Border SEO Local")}</p></div></div>
      <a className={s.usageLink} href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">{t("Manage usage", "管理用量")}<ArrowUpRight size={15} /></a>
    </div>
    <div className={s.appConnectionBody}>
      <div className={s.appDetails}>
        <p className={s.appStatus}><span className={`${s.dot} ${connection?.connected && !modelsUnavailable ? s.online : ""}`} />{busy === "load" ? t("Checking connection…", "正在检查连接…") : status}</p>
        <p>{t("Authorize this app to make it appear in ChatGPT's app limits. It shares your existing plan allowance; it does not add a separate allowance.", "授权后，此应用会显示在 ChatGPT 的应用用量限制中。它与其他应用共享现有套餐额度，不会增加一份新额度。")}</p>
        {connection && connection.profiles.length > 0 && <label className={s.field}><span>{t("Saved ChatGPT connection", "已保存的 ChatGPT 连接")}</span><select value={connection.profileId ?? ""} disabled={disabled || !!busy} onChange={event => { setCreditsDisabled(false); void act("select", event.target.value); }}><option value="" disabled>{t("Choose a connection", "选择连接")}</option>{connection.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label || profile.email || profile.id}{profile.connected ? "" : t(" · signed out", " · 已退出")}</option>)}</select></label>}
        {connection?.email && <p className={s.appEmail}>{connection.email}</p>}
        <div className={s.appActions}>
          <button data-oai-siwc-button type="button" className={s.chatgptButton} disabled={disabled || !!busy} onClick={() => void act("connect", connection?.profileId ?? undefined)}>{busy === "connect" ? <Loader2 size={16} className={s.spinning} /> : <Link2 size={16} />}Continue with ChatGPT</button>
          {!!connection?.profiles.length && <button type="button" disabled={disabled || !!busy} onClick={() => void act("connect", undefined, true)}>{t("Add account", "添加账号")}</button>}
          {connection?.connected && <button type="button" disabled={disabled || !!busy} onClick={() => setDisconnecting(true)}>{t("Sign out", "退出连接")}</button>}
          <button type="button" aria-label={t("Refresh ChatGPT connection", "刷新 ChatGPT 连接")} disabled={disabled || !!busy} onClick={() => void refresh({ manual: true })}><RefreshCw size={15} className={busy === "load" ? s.spinning : ""} /></button>
        </div>
        {disconnecting && <div className={s.connectionConfirm}><p>{t("Sign out of this app connection? Existing drafts are kept. Requests stop until you reconnect or explicitly choose local Codex.", "退出这个应用连接？已有草稿会保留。重新连接或主动选择本机 Codex 后，才能继续生成。")}</p><div className={s.appActions}><button type="button" disabled={!!busy} onClick={() => void act("disconnect", connection?.profileId ?? undefined)}>{t("Confirm sign out", "确认退出")}</button><button type="button" onClick={() => setDisconnecting(false)}>{t("Keep connected", "保持连接")}</button></div></div>}
      </div>
      <div className={s.executionSettings}>
        <label className={s.field}><span>{t("Connection for new tasks", "新任务使用的连接")}</span><select value={provider} disabled={appOnly || disabled || !!busy} onChange={event => { initialized.current = true; setProvider(event.target.value as AccountExecution["provider"]); }}><option value="CHATGPT_APP">{t("A-Border SEO Local · independent app", "A-Border SEO Local · 独立应用")}</option>{!appOnly && <option value="CODEX_LOCAL">{t("Local Codex · existing login", "本机 Codex · 原有账号登录")}</option>}</select></label>
        {provider === "CHATGPT_APP" ? <>
          <label className={s.field}><span>{t("Model available to this connection", "此连接可用的模型")}</span><select value={model} disabled={disabled || !!busy || !connection?.sharing || !connection.models.length} onChange={event => setModel(event.target.value)}><option value="">{modelsUnavailable ? t("No models available", "暂时没有可选模型") : t("Choose a model", "选择模型")}</option>{connection?.models.map(item => <option key={item.slug} value={item.slug}>{item.displayName || item.slug}</option>)}</select></label>
          <label className={s.creditConfirmation}><input type="checkbox" checked={creditsDisabled} disabled={disabled || !!busy} onChange={event => setCreditsDisabled(event.target.checked)} /><span>{t("I have disabled use of credits after plan limits in ChatGPT usage settings.", "我已在 ChatGPT 用量设置中关闭达到套餐上限后的额度使用。")}</span></label>
          <p>{t("Credit permissions are managed in ChatGPT. This app cannot verify that switch. Recheck it if your settings change.", "超额额度权限由 ChatGPT 管理，本平台无法验证该开关。设置改变后请重新核对。")}</p>
          {!connection?.sharing && !busy && <p className={s.connectionWarning}>{t("Connect and allow ChatGPT plan usage before generating with this app.", "请先连接并允许使用 ChatGPT 套餐，再通过独立应用生成。")}</p>}
          {appReady && <p className={s.usingPlan}><Check size={14} />{t("Using ChatGPT plan", "使用 ChatGPT 套餐")}</p>}
        </> : <p>{t("Uses the dedicated Codex login already on this computer. This does not create a separate A-Border SEO app entry in ChatGPT settings.", "使用这台电脑上原有的专用 Codex 登录。此方式不会在 ChatGPT 设置中创建独立的 A-Border SEO 应用条目。")}</p>}
        <p>{t("A failed task never switches connections or falls back to a paid API key automatically.", "任务失败时不会自动切换连接，也不会转为 API Key 付费调用。")}</p>
      </div>
    </div>
    {(error || callbackError || connection?.modelError) && <p className={s.connectionError} role="alert">{message(error || callbackError || connection?.modelError || "connection_unavailable")} <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">{t("Manage usage", "管理用量")}</a></p>}
    {notice && <p className={s.connectionNotice} role="status">{notice}</p>}
  </section>;
}
