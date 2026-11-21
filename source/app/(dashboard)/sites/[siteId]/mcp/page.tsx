import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { instanceOrigin } from "@/lib/instance-origin";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { McpPageContent } from "@/components/mcp/mcp-page-content";
import Link from "next/link";
import { Download, Sparkles } from "lucide-react";
import { SKILLS } from "@/lib/skills/catalog";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function McpPage({ params }: Props) {
  const { t, locale } = await getI18n();
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
      <section className="panel mt-6 space-y-4 p-5" aria-labelledby="skills-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="skills-heading" className="flex items-center gap-2 text-[15px] leading-5 font-semibold text-text-strong">
              <Sparkles className="size-4" aria-hidden />
              {t("Skills package", "AI 技能包")}</h3>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("Ready-made workflows for AI assistants that read this app through MCP: a weekly review, rank changes, technical fixes, keyword opportunities, GEO and a coach for beginners. They use the read-only tools above, so they never start a crawl, a sync or a paid check.", "供通过 MCP 读取本应用的 AI 助手使用的现成流程：每周复盘、排名变化、技术问题、关键词机会、GEO 和新手讲解。它们只用上面的只读工具，不会启动抓取、同步或付费查询。")}</p>
          </div>
          <a href="/api/skills" className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90" download>
            <Download className="size-4" aria-hidden />{t("Download all skills", "下载全部技能")}</a>
        </div>
        <ul className="grid gap-2 md:grid-cols-2">
          {SKILLS.map((skill) => (
            <li key={skill.name} className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text-strong">{locale === "zh" ? skill.title.zh : skill.title.en}</span>
                <code className="font-data text-[12px] text-muted-foreground">{skill.name}</code>
              </span>
              <a href={`/api/skills?name=${skill.name}`} className="shrink-0 text-xs text-link" download>{t("Download", "下载")}</a>
            </li>
          ))}
        </ul>
        <div className="space-y-1 text-xs leading-6 text-muted-foreground">
          <p>{t("Claude Code: copy each skill folder into ~/.claude/skills/ and restart it.", "Claude Code：把每个技能文件夹复制到 ~/.claude/skills/，然后重启。")}</p>
          <p>{t("Codex: copy each skill folder into ~/.agents/skills/ and restart it.", "Codex：把每个技能文件夹复制到 ~/.agents/skills/，然后重启。")}</p>
          <p>{t("Claude desktop or web: turn on Skills in Settings and upload one skill zip at a time.", "Claude 桌面版或网页版：在设置中打开技能（Skills），逐个上传单个技能的 zip。")}</p>
          <p>{t("Then ask in plain words, for example: a weekly SEO review of example.com.", "之后直接用自然语言提问即可，例如：做一下 example.com 这周的 SEO 周报。")}</p>
        </div>
      </section>
    </div>
  );
}
