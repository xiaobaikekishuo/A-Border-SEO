import { getI18n } from "@/lib/i18n/server";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isSealed } from "@/lib/google/token-store";
import { API_KEY_PROVIDERS, apiKeyStatus } from "@/lib/api-keys";
import { PageHeader } from "@/components/ui/page-header";
import { Avatar } from "@/components/account/avatar";
import { DeleteAccountDialog, SignOutButton } from "@/components/account/account-actions";
import { ConnectionsSection } from "@/components/settings/connections-section";
import { ScheduleSection } from "@/components/settings/schedule-section";
import { McpSection } from "@/components/settings/mcp-section";
import { WebhookSection } from "@/components/settings/webhook-section";
import { EmailSection } from "@/components/settings/email-section";
import { emailStatus } from "@/lib/email/status";
import { instanceOrigin } from "@/lib/instance-origin";
import { mcpStatus } from "@/lib/mcp-settings";
import { getScheduleSettings, scheduleServerInfo } from "@/lib/user-settings";
import { webhookStatus } from "@/lib/webhooks/status";

/** Granted scopes from `User.googleTokens`, which keeps them in plain text next to the encrypted tokens. */
function grantedScopes(stored: unknown): string[] {
  const scope =
    stored && typeof stored === "object" && "scope" in stored ? (stored as { scope?: unknown }).scope : null;
  return typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [];
}

function hasToken(stored: unknown): boolean {
  if (!stored || typeof stored !== "object") return false;
  const t = stored as { accessToken?: unknown; refreshToken?: unknown };
  return typeof t.refreshToken === "string" || typeof t.accessToken === "string";
}

function SectionHeading({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <div className="mb-3">
      <h2 id={id} className="text-[15px] leading-5 font-semibold text-text-strong">
        {title}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

interface Props {
  searchParams: Promise<{ connect?: string | string[] }>;
}

export default async function SettingsPage({ searchParams }: Props) {
  const { t } = await getI18n();
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { email: true, name: true, image: true, googleTokens: true },
  });
  if (!user) redirect("/login");

  const connected = hasToken(user.googleTokens);
  const [keys, schedule, webhook, email, mcp] = await Promise.all([
    apiKeyStatus(db, session.user.id),
    getScheduleSettings(db, session.user.id),
    webhookStatus(db, session.user.id),
    emailStatus(db, session.user.id),
    mcpStatus(db, session.user.id),
  ]);
  const mcpEndpoint = `${await instanceOrigin()}/mcp`;
  const registrationClosed =
    process.env.DISABLE_REGISTRATION?.trim().toLowerCase() === "true";

  // ?connect=bing opens that row's form, for the "Connect Bing in Settings" links.
  const { connect } = await searchParams;
  const initialOpen = API_KEY_PROVIDERS.find((p) => p === connect) ?? null;

  return (
    <div>
      <PageHeader
        title={t("Settings", "设置")}
        description={t("Your profile, the services A-Border SEO connects to, the schedule, alert delivery, MCP access and your account.", "管理个人资料、服务连接、定时任务、告警通知、MCP 访问与账号。")}
      />

      <div className="space-y-10">
        <section aria-labelledby="profile-heading">
          <SectionHeading
            id="profile-heading"
            title={t("Profile", "个人资料")}
            description={t("From your Google account, updated each time you sign in.", "来自你的 Google 账号，每次登录时更新。")}
          />
          <div className="panel flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-4">
              <Avatar name={user.name} email={user.email} image={user.image} className="size-12 text-[13px]" />
              <dl className="min-w-0">
                <dt className="sr-only">{t("Name", "姓名")}</dt>
                <dd className="truncate text-[15px] leading-5 font-medium text-text-strong">
                  {user.name || <span className="font-normal text-muted-foreground">{t("No name from Google yet", "Google 尚未提供姓名")}</span>}
                </dd>
                <dt className="sr-only">{t("Email", "邮箱")}</dt>
                <dd className="mt-0.5 font-data text-[13px] leading-5 break-all text-muted-foreground">{user.email}</dd>
              </dl>
            </div>
            <SignOutButton />
          </div>
        </section>

        <section id="connections" aria-labelledby="connections-heading" className="scroll-mt-6">
          <SectionHeading
            id="connections-heading"
            title={t("Connections", "服务连接")}
            description={t("Each connection is stored once for your account and used by every site.", "每项连接按账号保存，所有站点共用。")}
          />
          <ConnectionsSection
            google={{
              connected,
              scopes: connected ? grantedScopes(user.googleTokens) : [],
              sealed: isSealed(user.googleTokens),
            }}
            initialStatus={keys}
            initialOpen={initialOpen}
          />
        </section>

        <section id="schedule" aria-labelledby="schedule-heading" className="scroll-mt-6">
          <SectionHeading
            id="schedule-heading"
            title={t("Schedule", "定时任务")}
            description={t("How often your sites are crawled and get a vitals check. GSC and Bing syncs run each day.", "设置站点抓取和核心指标检查频率。GSC 与 Bing 数据每天同步。")}
          />
          <ScheduleSection initial={{ ...schedule, server: scheduleServerInfo() }} />
        </section>

        <section id="webhook" aria-labelledby="webhook-heading" className="scroll-mt-6">
          <SectionHeading
            id="webhook-heading"
            title={t("Alert webhook", "告警 Webhook")}
            description={t("Send fired alerts to your own endpoint, such as n8n, Zapier or a script of yours.", "将已触发告警发送到你的接收端，例如 n8n、Zapier 或自有脚本。")}
          />
          <WebhookSection initial={webhook} />
        </section>

        <section id="email" aria-labelledby="email-heading" className="scroll-mt-6">
          <SectionHeading
            id="email-heading"
            title={t("Email alerts", "邮件告警")}
            description={t("Email fired alerts through the SMTP server this instance is set up with.", "通过此实例配置的 SMTP 服务器发送已触发的告警。")}
          />
          <EmailSection initial={email} />
        </section>

        <section id="mcp" aria-labelledby="mcp-heading" className="scroll-mt-6">
          <SectionHeading
            id="mcp-heading"
            title={t("MCP", "MCP")}
            description={t("Read-only access to your sites for AI agents such as Claude Code, with access keys you create here.", "在此创建访问密钥，让 Claude Code 等 AI 助手以只读方式访问站点数据。")}
          />
          <McpSection initial={mcp} endpoint={mcpEndpoint} />
        </section>

        <section aria-labelledby="danger-heading">
          <SectionHeading id="danger-heading" title={t("Danger zone", "危险操作")} description={t("This cannot be undone.", "此操作无法撤销。")} />
          <div className="panel flex flex-col gap-4 border-danger/30 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-[15px] leading-5 font-medium text-text-strong">{t("Delete account", "删除账号")}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("Deletes your account, every site and all its data on this instance, and revokes Google access.", "删除此实例上的账号、全部站点及其数据，并撤销 Google 授权。")}</p>
            </div>
            <DeleteAccountDialog email={user.email} registrationClosed={registrationClosed} />
          </div>
        </section>
      </div>
    </div>
  );
}
