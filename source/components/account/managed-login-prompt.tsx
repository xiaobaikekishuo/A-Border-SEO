"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { desktopBridge, hasDesktopBridge } from "@/lib/desktop/client";
import { useI18n } from "@/lib/i18n/client";

const noSubscribe = () => () => {};

export function ManagedLoginPrompt() {
  const { t } = useI18n();
  const desktop = useSyncExternalStore(noSubscribe, hasDesktopBridge, () => false);
  return <div className="mt-6 space-y-4">
    <p className="text-sm leading-6 text-muted-foreground">{t(
      "Register or sign in to your A-Border SEO account in the desktop app. An administrator must approve new accounts before they can use the workspace.",
      "请在 A-Border SEO 客户端注册或登录。新账号经管理员批准后即可进入工作台。")}</p>
    {desktop && <Button className="w-full" onClick={() => void desktopBridge()?.showSettings?.()}>
      {t("Return to desktop sign-in", "返回客户端登录")}
    </Button>}
    <p className="text-xs leading-5 text-muted-foreground">{t(
      "Google is an optional connection for Search Console and analytics. It is not required for your A-Border SEO account.",
      "Google 用于按需连接 Search Console 和分析数据，不是注册或登录的前提。")}</p>
  </div>;
}
