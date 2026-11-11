import type { Translator } from "@/lib/i18n/shared";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { getI18n } from "@/lib/i18n/server";
import { signIn, auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { registrationClosedMessage, DEFAULT_REGISTRATION_CLOSED_MESSAGE } from "@/lib/registration";
import { Activity, Search, ShieldCheck } from "lucide-react";

// Auth.js sends a refused sign-in back here as ?error=AccessDenied, which only
// the signIn callback produces (DISABLE_REGISTRATION). Its copy can be set with
// REGISTRATION_CLOSED_MESSAGE. Any other code gets the generic line.
function errorMessage(error: string | string[] | undefined, t: Translator): string | null {
  if (!error) return null;
  if (error === "AccessDenied") {
    const message = registrationClosedMessage();
    return message === DEFAULT_REGISTRATION_CLOSED_MESSAGE ? t(message, "此实例不接受新账号，请联系所有者为你开通。") : message;
  }
  return t("Sign-in failed. Please try again.", "登录失败，请重试。");
}

// Set by the account actions (app/(dashboard)/settings/actions.ts) after they sign the user out.
function notices(t: Translator): Record<string, string> {
const unrevoked = t(" Google did not confirm the revoke: to be sure, remove this app at myaccount.google.com/permissions using the app name shown by Google.", " Google 尚未确认撤销。请前往 myaccount.google.com/permissions，按 Google 显示的应用名称移除本应用授权。");
return {
  disconnected: t("Google is disconnected and you are signed out. Sign in again to reconnect Search Console.", "Google 已断开连接，你已退出登录。重新登录即可连接 Search Console。"),
  "disconnected-unrevoked":
    t("You are signed out and the Google tokens were removed from this server.", "你已退出登录，此服务器上的 Google 令牌已移除。") + unrevoked,
  deleted: t("Your account and all its data were deleted.", "你的账号及全部数据已删除。"),
  "deleted-unrevoked": t("Your account and all its data were deleted.", "你的账号及全部数据已删除。") + unrevoked,
  "delete-failed": t("Your account could not be deleted. Sign in and try again.", "无法删除你的账号，请登录后重试。"),
};
}

function noticeMessage(notice: string | string[] | undefined, t: Translator): string | null {
  return typeof notice === "string" ? (notices(t)[notice] ?? null) : null;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { t } = await getI18n();
  const session = await auth();
  if (session) {
    redirect("/sites");
  }
  const params = await searchParams;
  const error = errorMessage(params.error, t);
  const notice = noticeMessage(params.notice, t);

  return (
    <div className="flex min-h-dvh items-center justify-center px-5 py-12 sm:px-8">
      <div className="w-full max-w-[440px]">
        <div className="mb-6 flex justify-end"><LanguageSwitcher /></div>
        <div className="mb-9 flex flex-col items-center gap-4 text-center">
          <h1 className="text-text-strong">
            <Logo className="h-14" />
          </h1>
          <p className="text-[13px] leading-6 text-muted-foreground">{t("Self-hosted search ops for founders", "自主部署的搜索优化工作台")}</p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-7 shadow-[var(--shadow-3)] sm:p-9">
          <h2 className="text-[24px] leading-8 font-semibold tracking-[-0.025em] text-text-strong">{t("Sign in", "登录")}</h2>
          <p className="mt-2.5 text-[13px] leading-6 text-muted-foreground">
            {t("Connect Google Search Console with read-only access.", "以只读权限连接 Google Search Console。")}</p>

          {notice && (
            <p role="status" className="mt-5 rounded-xl border border-border bg-bg-section px-4 py-3 text-[13px] leading-6 text-text">
              {notice}
            </p>
          )}

          {error && (
            <p role="alert" className="mt-5 rounded-xl border border-danger/25 bg-danger-bg px-4 py-3 text-[13px] leading-6 text-danger">
              {error}
            </p>
          )}

          <form
            className="mt-7"
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/sites" });
            }}
          >
            <Button type="submit" size="lg" className="h-12 w-full rounded-xl">
              {t("Continue with Google", "使用 Google 继续")}</Button>
          </form>

          <ul className="mt-7 space-y-3 border-t border-border pt-6 text-[12px] leading-5 text-muted-foreground">
            <li className="flex items-start gap-2.5"><Search className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />{t("Keywords, positions and CTR from GSC", "来自 GSC 的关键词、排名和点击率")}</li>
            <li className="flex items-start gap-2.5"><Activity className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />{t("Technical crawl and Core Web Vitals", "技术抓取与核心网页指标")}</li>
            <li className="flex items-start gap-2.5"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />{t("Data stays on your server", "数据保存在你的服务器上")}</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
