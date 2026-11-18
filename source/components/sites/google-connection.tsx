"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/client";
import { connectGoogleInBrowser, GoogleConnectionError } from "@/lib/google/connection-client";

type Connection = { configured: boolean; connected: boolean; reason: string | null; redirectUri: string | null };

export function GoogleConnection({ onConnected, disabled = false }: { onConnected?: () => void; disabled?: boolean }) {
  const { t } = useI18n();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(true);
  const [statusError, setStatusError] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const connectedBefore = useRef(false);
  const connectedCallback = useRef(onConnected);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    disabledRef.current = disabled;
    if (disabled) active.current?.abort();
  }, [disabled]);
  useEffect(() => { connectedCallback.current = onConnected; }, [onConnected]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (alive.current) setChecking(true);
    try {
      const response = await fetch("/api/google/connection", { cache: "no-store", signal });
      if (!response.ok) throw new Error("status_failed");
      const value = await response.json();
      if (alive.current && !signal?.aborted) {
        setConnection(value);
        setStatusError(false);
        if (value.connected && !connectedBefore.current && !disabledRef.current) connectedCallback.current?.();
        connectedBefore.current = Boolean(value.connected);
      }
    } catch (failure) {
      if (alive.current && !signal?.aborted) setStatusError(true);
      throw failure;
    } finally { if (alive.current) setChecking(false); }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh().catch(() => {});
    return () => { alive.current = false; active.current?.abort(); };
  }, [refresh]);

  async function connect() {
    if (active.current || disabled || !connection?.configured) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError("");
    try {
      await connectGoogleInBrowser(controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      connectedBefore.current = false;
      await refresh(controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted && alive.current) {
        const code = failure instanceof GoogleConnectionError ? failure.code : "GOOGLE_CONNECTION_FAILED";
        setError(code === "GOOGLE_CONNECTION_NOT_CONFIGURED"
          ? t("Google OAuth is not configured for this installation. Ask the administrator to enable it.", "当前安装未配置 Google OAuth，请联系管理员开通。")
          : code === "GOOGLE_CONNECTION_DECLINED"
            ? t("Google authorization was declined. You can still add a site manually.", "Google 授权已取消，你仍可手动添加网站。")
            : code === "GOOGLE_CONNECTION_SESSION_CHANGED"
              ? t("Your desktop sign-in changed. Sign in and connect again.", "客户端登录状态已变化，请登录后重新连接。")
              : code === "GOOGLE_CONNECTION_EXPIRED"
                ? t("The connection request expired. Start again.", "连接请求已过期，请重新发起。")
                : code === "GOOGLE_CONNECTION_POPUP_BLOCKED"
                  ? t("Allow the authorization tab to open, then try again.", "请允许打开授权页面后重试。")
                  : t("Google could not be connected. Check the network, OAuth configuration and granted Search Console access, then retry.", "Google 连接未完成，请检查网络、OAuth 配置及 Search Console 授权后重试。"));
      }
    } finally {
      active.current = null;
      if (alive.current) setPending(false);
    }
  }

  return <section className="space-y-3 rounded-xl border border-border bg-bg-section p-4" aria-label={t("Google connection", "Google 连接")}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-sm font-medium">{t("Google Search Console", "Google Search Console")}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{!connection
          ? (checking ? t("Checking connection…", "正在检查连接…") : t("Connection status is unavailable.", "暂时无法读取连接状态。"))
          : connection.connected ? t("Connected to your current account", "已关联当前账号")
            : connection.configured ? t("Not connected. Authorize Google to import your verified sites.", "尚未连接，授权 Google 后可导入你已验证的网站。")
              : t("Google is not configured for this installation. You can add a site manually and ask the administrator to enable this connection later.", "当前安装尚未配置 Google 连接。你可以先手动添加网站，稍后联系管理员开通。")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
      <Button type="button" variant="ghost" disabled={checking || pending || disabled} onClick={() => void refresh().catch(() => {})}>
        {checking ? t("Checking…", "检查中…") : t("Refresh connection", "刷新连接")}
      </Button>
      <Button type="button" variant="outline" disabled={disabled || pending || checking || !connection?.configured} onClick={() => void connect()}>
        {pending ? t("Waiting for Google…", "等待 Google 授权…") : connection?.connected ? t("Reconnect", "重新连接") : t("Connect Google", "连接 Google")}
      </Button>
      </div>
    </div>
    {pending && <div className="flex items-center justify-between gap-3">
      <p role="status" className="text-xs text-muted-foreground">{t("Complete authorization in your system browser, then return here. Your A-Border SEO account stays the same.", "请在系统浏览器完成授权后返回，A-Border SEO 登录账号保持不变。")}</p>
      <Button type="button" variant="ghost" size="sm" onClick={() => active.current?.abort()}>{t("Cancel", "取消")}</Button>
    </div>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {statusError && <p role="alert" className="text-xs text-danger">{t("Could not check the Google connection. Use Refresh connection to try again.", "未能检查 Google 连接，请点击“刷新连接”重试。")}</p>}
  </section>;
}
