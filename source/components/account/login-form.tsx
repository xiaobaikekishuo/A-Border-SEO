"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { authorizeInBrowser, DesktopOAuthError, hasDesktopBridge } from "@/lib/desktop/client";
import { useI18n } from "@/lib/i18n/client";

const noSubscribe = () => () => {};

export function LoginForm({ webAction, label }: { webAction: () => Promise<void>; label: string }) {
  const desktop = useSyncExternalStore(noSubscribe, hasDesktopBridge, () => false);
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<AbortController | null>(null);
  useEffect(() => () => attempt.current?.abort(), []);

  async function start() {
    if (attempt.current) return;
    const controller = new AbortController();
    attempt.current = controller;
    setPending(true);
    setError("");
    try {
      await authorizeInBrowser({ action: "login" }, controller.signal);
      window.location.replace("/sites");
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof DesktopOAuthError && error.status === 410
          ? t("The sign-in request expired. Start again.", "登录请求已过期，请重新发起。")
          : t("Desktop sign-in could not finish. Check the local Google settings and try again.", "桌面登录未能完成，请检查本机 Google 设置后重试。"));
      }
    } finally {
      attempt.current = null;
      setPending(false);
    }
  }

  if (!desktop) {
    return (
      <form className="mt-7" action={webAction}>
        <Button type="submit" size="lg" className="h-12 w-full rounded-xl">{label}</Button>
      </form>
    );
  }
  return (
    <div className="mt-7 space-y-3">
      <Button type="button" size="lg" className="h-12 w-full rounded-xl" disabled={pending} onClick={() => void start()}>{label}</Button>
      {pending && <>
        <p role="status" className="text-sm text-muted-foreground">{t("Complete sign-in and confirm it in your system browser.", "请在系统浏览器中登录并确认。")}</p>
        <Button type="button" variant="outline" onClick={() => attempt.current?.abort()}>{t("Cancel", "取消")}</Button>
      </>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
