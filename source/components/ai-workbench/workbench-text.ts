import { FilePenLine, Languages, Layers, PencilLine, Wrench } from "lucide-react";
import type { Translator } from "@/lib/i18n/shared";
import { isAccountLimitError, type TaskKind, type WorkbenchJob } from "./model";
import { toolErrorKind } from "./tool-model";
import { toolErrorText } from "./tool-panel";

/* The words of the Codex workbench: its task types, task states and error messages. */

/** The tasks the workbench offers, in the order of its task choices. */
export function workbenchTasks(t: Translator) {
  return [
    {
      kind: "WRITE_ARTICLE" as const,
      icon: FilePenLine,
      title: t("Write an article", "写文章全文"),
      description: t("Turn a topic or brief into a complete draft.", "从选题或简报出发，写成完整草稿。"),
    },
    {
      kind: "REWRITE_ARTICLE" as const,
      icon: PencilLine,
      title: t("Improve an article", "改写已有文章"),
      description: t("Use the original text to improve structure and clarity.", "结合原文，改进结构与内容表达。"),
    },
    {
      kind: "SEO_FIX_PLAN" as const,
      icon: Wrench,
      title: t("Plan SEO fixes", "生成修复方案"),
      description: t("Translate audit findings into concrete next steps.", "把审计问题变成可检查的修改建议。"),
    },
    {
      kind: "LOCALIZE_ARTICLE" as const,
      icon: Languages,
      title: t("Localize for a market", "本地化改写"),
      description: t(
        "Rewrite an article for another country and language, with local search terms.",
        "按目标国家和语言重写文章，换成当地人的搜索用词。",
      ),
    },
    {
      kind: "SCHEMA_MARKUP" as const,
      icon: Layers,
      title: t("Structured data code", "结构化数据代码"),
      description: t(
        "JSON-LD from a crawled page's own facts, checked by the program.",
        "按已抓取页面上的真实信息生成 JSON-LD，由程序检查。",
      ),
    },
  ];
}

export function workbenchKindName(kind: TaskKind, t: Translator) {
  return workbenchTasks(t).find(task => task.kind === kind)?.title ?? kind;
}

export function workbenchStatusName(job: WorkbenchJob, t: Translator) {
  return {
    QUEUED: t("Queued", "排队中"),
    RUNNING: t("Generating", "生成中"),
    SUCCEEDED: t("Draft ready", "草稿就绪"),
    FAILED: job.error?.startsWith("Canceled by user") ? t("Canceled", "已取消") : t("Failed", "未完成"),
  }[job.status];
}

/** A server or task error as a readable message; anything not recognized is shown as it is. */
export function workbenchErrorText(message: string, t: Translator): string {
  if (toolErrorKind(message) === "too_large" || /^Codex did not return/.test(message)) return toolErrorText(message, t);
  if (message === "report_evidence_changed")
    return t("The saved report changed. Refresh the evidence in the task.", "报表数据已有更新，请在任务里刷新依据。");
  if (message === "report_claim_too_large")
    return t(
      "The reviewed report and instructions exceed the local worker’s task limit. Shorten your instructions or open one source report and review its evidence before generating.",
      "这份报表和补充要求超过本机助手的任务长度上限。请缩短补充要求，或打开单项报表核对依据后再生成。",
    );
  if (message === "report_evidence_empty") return t("This report has no saved evidence yet.", "当前报表还没有可分析的数据。");
  if (/crawl changed|latest completed crawl|does not match the diagnosis|Choose a page from the saved evidence/i.test(message))
    return t(
      "Page evidence changed or no longer matches the selected source. Refresh the preview, select the page, and bring it into the task again. Your task text is preserved.",
      "页面依据已变化或与所选来源不一致。请刷新预览、选择页面并重新带入任务，任务输入仍保留。",
    );
  if (/Paragraph (source|edits)|Applying paragraph edits/i.test(message))
    return t(
      "The proposed paragraph changes could not be matched safely to the source. Review the saved task before trying again.",
      "建议的段落修改无法可靠对应原文，请检查已保存的任务后再重试。",
    );
  if (isAccountLimitError(message))
    return t(
      "This connection reached a usage limit. Check ChatGPT usage and app limits, then start a new task when available. No other connection or API key is used automatically.",
      "此连接已达到使用限制。请查看 ChatGPT 用量及应用上限，恢复后再新建任务。不会自动切换其他连接或 API Key。",
    );
  if (/chatgpt_app|chatgpt_connection|subscription_sharing|plan_permission/i.test(message))
    return t(
      "The ChatGPT app connection needs attention. Check its status above and reconnect or refresh its models before starting another task.",
      "ChatGPT 应用连接需要处理。请检查上方状态，重新授权或刷新模型后再手动新建任务。",
    );
  if (/chatgpt_login_required/i.test(message))
    return t(
      "Sign in to the dedicated local Codex account, restart the content helper, then refresh this page.",
      "请在本机完成专用 Codex 账号登录，重启内容助手后刷新页面。",
    );
  if (/Canceled by user/i.test(message))
    return t(
      "Canceled. The local helper stops at its next heartbeat, normally within 30 seconds. Already used account allowance is not refunded.",
      "已取消。本机助手将在下次心跳时停止，通常不超过 30 秒；已用账号额度不会退回。",
    );
  if (/timed out|generation_timeout/i.test(message))
    return t(
      "This task timed out. Review its state before starting another task; no automatic retry was sent.",
      "任务已超时。请核对状态后再新建任务，系统没有自动重试。",
    );
  if (/worker.*offline|helper.*offline|worker.*online/i.test(message))
    return t("Start the local content helper and refresh this page before generating.", "请先启动本机内容助手，刷新页面后再生成。");
  if (/changed|conflict|stale|updated/i.test(message))
    return t(
      "This draft changed elsewhere. Your unsaved text is still here. Copy it before reloading the latest version.",
      "此草稿已在其他地方更新。未保存的文字仍保留，请先复制，再重新加载最新版本。",
    );
  if (/codex_generation_failed|generation_failed|invalid_model_output/i.test(message))
    return t(
      "Codex did not return a usable draft. Your request is preserved; review it before starting a new task.",
      "Codex 没有返回可用草稿。任务要求仍保留，请检查后再手动生成。",
    );
  return message;
}
