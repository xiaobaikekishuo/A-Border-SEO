import type { Translator } from "@/lib/i18n/shared";

/**
 * A server or task error of a keyword or research analysis task as a
 * readable message (both panels use ChatGPT app connections and the same
 * task API). Anything not recognized is shown as it is.
 */
export function researchErrorText(message: string, t: Translator): string {
  const sampleRow = /Invalid backlink sample row (\d+)/i.exec(message);
  if (sampleRow) {
    return t(
      `Check backlink sample row ${sampleRow[1]}: use an external public HTTP(S) source URL, a target on this site's exact origin, and an optional anchor, separated by tabs. Do not include a header.`,
      `请检查反链样本第 ${sampleRow[1]} 行：来源需为其他公开网站的 HTTP(S) URL，目标需为本站同源 URL，可附锚文本；以制表符分隔，不含表头。`,
    );
  }
  if (/Research evidence is too large/i.test(message)) {
    return t(
      "The evidence sample is too large. Reduce the pasted backlink rows and try again.",
      "证据样本过大，请减少粘贴的反链行数后重试。",
    );
  }
  if (/usage.limit|quota|rate.limit|not_eligible/i.test(message)) {
    return t(
      "This account cannot generate right now. Check its plan eligibility and usage in ChatGPT, then start a new task when available.",
      "此账号暂时无法生成。请在 ChatGPT 检查套餐资格及用量，恢复后再手动新建任务。",
    );
  }
  if (/Canceled by user/i.test(message))
    return t("Canceled. Allowance already used is not refunded.", "已取消，已使用的账号额度不会退回。");
  if (/open the desktop app/i.test(message)) {
    return t(
      "Open this research page in the desktop app and sign in to ChatGPT on this device.",
      "请在桌面客户端打开此研究页面，并在本机登录 ChatGPT。",
    );
  }
  if (/worker|codex_executable_missing/i.test(message)) {
    return t(
      "The local content helper is unavailable. Start the local software and refresh the task history.",
      "本机内容助手暂不可用，请启动本地软件后刷新任务记录。",
    );
  }
  if (/chatgpt|connection|profile|model|plan permission|credit overage/i.test(message)) {
    return t(
      "Check the ChatGPT connection, model and plan permission above before starting another task.",
      "请检查上方 ChatGPT 连接、模型与套餐授权，再手动新建任务。",
    );
  }
  if (/already has an active/i.test(message)) {
    return t(
      "This site already has an active task. Refresh its status and wait for it to finish.",
      "此站点已有进行中的任务，请刷新状态并等待完成。",
    );
  }
  if (/timed out|timeout/i.test(message)) {
    return t(
      "The task timed out. No automatic retry was sent. Check the saved task before generating again.",
      "任务超时，系统没有自动重试。请检查已保存任务后再生成。",
    );
  }
  return message;
}

/** A focus prompt would make the instructions longer than allowed. */
export function focusTooLongText(t: Translator): string {
  return t(
    "The added prompt would exceed 6,000 characters. Shorten your text first; your input is unchanged.",
    "追加后会超过 6,000 字符，请先缩短文字；现有输入已保留。",
  );
}
