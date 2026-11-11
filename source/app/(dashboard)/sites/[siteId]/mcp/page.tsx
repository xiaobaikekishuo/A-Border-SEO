import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { instanceOrigin } from "@/lib/instance-origin";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { McpPageContent } from "@/components/mcp/mcp-page-content";
import Link from "next/link";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function McpPage({ params }: Props) {
  const { t } = await getI18n();
  const session = await auth();
  const { siteId } = await params;

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true },
  });
  if (!site || site.userId !== session?.user?.id) redirect("/sites");

  const settings = await db.userSettings.findUnique({ where: { userId: site.userId }, select: { mcpEnabled: true } });
  const origin = await instanceOrigin();

  return (
    <div>
      <PageHeader
        title={t("AI & MCP", "AI 与 MCP")}
        description={t("Let your AI agent read your SEO data through the Model Context Protocol. Read-only.", "让 AI 助手通过模型上下文协议（MCP）读取 SEO 数据，仅限只读操作。")}
      />
      <div className="mb-6 rounded-xl border border-primary/30 bg-primary/10 px-5 py-4 text-sm">
        <Link href={`/sites/${siteId}/assistant`} className="font-medium text-primary hover:underline">
          {t("Write articles and prepare fix plans in the Codex workbench", "在 Codex 工作台写文章和生成修复方案")} →
        </Link>
        <p className="mt-1.5 text-xs leading-6 text-muted-foreground">{t("Uses your signed-in local Codex account and saves reviewable drafts. The MCP connection below remains read-only.", "使用本机已登录的 Codex 账号，生成可审阅的草稿。下方 MCP 连接仍用于只读查询。")}</p>
      </div>
      <McpPageContent endpoint={`${origin}/mcp`} origin={origin} enabled={settings?.mcpEnabled ?? false} />
    </div>
  );
}
