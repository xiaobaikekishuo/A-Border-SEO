import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { auth, signIn } from "@/lib/auth";
import { completeDesktopLogin, desktopLoginPath, loginAttemptIsPending, oauthValue, requireDesktopOrigin } from "@/lib/desktop/oauth";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false, follow: false } };

async function localBrowserOnly() {
  try {
    requireDesktopOrigin(await headers());
  } catch {
    notFound();
  }
}

export default async function DesktopLogin({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; completed?: string }>;
}) {
  await localBrowserOnly();
  const params = await searchParams;
  const parsed = oauthValue.safeParse(params.id);
  const id = parsed.success ? parsed.data : null;
  const pending = id && await loginAttemptIsPending(id);
  const session = pending ? await auth() : null;
  const { t } = await getI18n();
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-6 px-6">
      <Logo className="h-12" />
      <h1 className="text-2xl font-semibold">{t("Sign in to the desktop app", "登录桌面版")}</h1>
      {pending && id ? (
        <form action={async () => {
          "use server";
          await localBrowserOnly();
          if (!await loginAttemptIsPending(id)) redirect(desktopLoginPath(id));
          const browserUser = (await auth())?.user;
          if (!browserUser?.id) {
            await signIn("google", { redirectTo: desktopLoginPath(id) });
            return;
          }
          const completed = await completeDesktopLogin(id, browserUser.id);
          redirect(completed ? "/desktop/oauth/login?completed=1" : desktopLoginPath(id));
        }}>
          <p className="mb-4 text-muted-foreground">
            {session?.user?.email
              ? t("Continue to the desktop app with this account", "使用此账号继续登录桌面版") + " · " + session.user.email
              : t("Sign in with Google, then return to this browser tab to confirm the desktop sign-in.", "使用 Google 登录后，在此浏览器标签页确认登录桌面版。")}
          </p>
          <Button type="submit">{session?.user?.id ? t("Confirm desktop sign-in", "确认登录桌面版") : t("Continue with Google", "使用 Google 继续")}</Button>
        </form>
      ) : (
        <p role="status">
          {params.completed === "1"
            ? t("Sign-in approved. Return to A-Border SEO.", "已确认登录，请返回 A-Border SEO。")
            : t("This sign-in request has expired. Return to the desktop app and try again.", "本次登录请求已失效，请返回桌面版重试。")}
        </p>
      )}
    </main>
  );
}
