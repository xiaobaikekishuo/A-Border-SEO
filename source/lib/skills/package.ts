import { SKILLS, skillByName, skillMarkdown } from "./catalog";
import { zipFiles } from "./zip";

/*
 * The downloads of the skills package: every skill in one zip with a README
 * (for Claude Code and Codex, which read skill folders), or one skill per zip
 * (for apps that take an upload per skill).
 */

export const SKILLS_README = `# A-Border SEO 技能包

这些技能让 AI 助手按固定流程读取 A-Border SEO 的数据（通过只读 MCP），完成每周复盘、排名变化复盘、技术问题排序、关键词与内容机会、GEO 可见度复盘和新手讲解。技能只读数据，不会触发抓取、同步或付费查询。

## 先接好 MCP

在 A-Border SEO 的“AI 与 MCP”页面开启 MCP，并按页面说明把 A-Border SEO 的 MCP 服务器加入你的 AI 客户端。

## 安装

- Claude Code：把每个技能文件夹复制到 ~/.claude/skills/（Windows 为 %USERPROFILE%\\.claude\\skills\\），然后重启 Claude Code。
- Codex：把每个技能文件夹复制到 ~/.agents/skills/（Windows 为 %USERPROFILE%\\.agents\\skills\\），然后重启 Codex。
- Claude 桌面版或网页版：在设置中打开技能（Skills），逐个上传单个技能的 zip。单个技能的 zip 可以在 A-Border SEO 的“AI 与 MCP”页面下载。

## 使用

直接说需求即可，例如“做一下 example.com 这周的 SEO 周报”“为什么这几个词掉排名了”。也可以点名技能，例如在 Codex 中输入 $aborder-weekly-review。

## 技能

${SKILLS.map(s => `- ${s.name}：${s.title.zh}`).join("\n")}

---

A-Border SEO skills: workflows for AI assistants that read A-Border SEO through its read-only MCP server. Install by copying each skill folder to ~/.claude/skills/ (Claude Code) or ~/.agents/skills/ (Codex), or upload one skill zip at a time in the Claude apps.
`;

export function skillsDownload(name: string | null): { filename: string; bytes: Buffer } | null {
  if (name) {
    const skill = skillByName(name);
    if (!skill) return null;
    return { filename: `${skill.name}.zip`, bytes: zipFiles([{ path: `${skill.name}/SKILL.md`, data: Buffer.from(skillMarkdown(skill), "utf8") }]) };
  }
  return {
    filename: "a-border-seo-skills.zip",
    bytes: zipFiles([
      { path: "README.md", data: Buffer.from(SKILLS_README, "utf8") },
      ...SKILLS.map(skill => ({ path: `${skill.name}/SKILL.md`, data: Buffer.from(skillMarkdown(skill), "utf8") })),
    ]),
  };
}
