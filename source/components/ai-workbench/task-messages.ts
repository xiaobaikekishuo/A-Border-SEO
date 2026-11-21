import type { Translator } from "@/lib/i18n/shared";
import type { AccountExecution } from "./chatgpt-connection";

/*
 * Messages the AI task panels share (the Codex workbench, the structured tool
 * panels, keyword ideas and research analysis), each defined once.
 */
export const taskText = {
  loadFailed: (t: Translator) =>
    t("Could not load the tasks. Your input is kept. Refresh before generating.", "无法读取任务记录，输入已保留。请刷新成功后再生成。"),
  createFailed: (t: Translator) => t("Could not create the task.", "未能创建任务。"),
  interrupted: (t: Translator) =>
    t(
      "The response was interrupted and a task may already exist. Refresh task history before submitting again. No automatic retry was sent.",
      "响应中断，任务可能已经创建。请先刷新任务记录再决定是否提交，系统没有自动重试。",
    ),
  canceled: (t: Translator) => t("Canceled. Allowance already used is not refunded.", "已取消任务，已使用的账号额度不会退回。"),
  cancelUnconfirmed: (t: Translator) =>
    t("Cancellation could not be confirmed. Refresh task history to check its state.", "未能确认取消结果，请刷新任务记录查看状态。"),
  backgroundRunning: (t: Translator) =>
    t(
      "A background task is running for this site. Starting a task stops it, and it waits in the pool again.",
      "此站点有后台任务在运行。你开始新任务时它会让位，之后重新排队。",
    ),
  helperOffline: (t: Translator) =>
    t(
      "The local content helper is offline. Open the desktop app or start the local software, then refresh.",
      "本机内容助手离线。请打开桌面客户端或启动本地软件后刷新。",
    ),
  /** What is missing before a panel that may use a ChatGPT app connection can generate. */
  connectionNeeded: (provider: AccountExecution["provider"], t: Translator) =>
    provider === "CODEX_LOCAL"
      ? t("Sign in to ChatGPT on this device and start the local worker above.", "请在上方登录本机 ChatGPT 并启动本机 Worker。")
      : t(
          "Connect an account, choose a model and confirm credit overage is disabled above.",
          "请在上方连接账号、选择模型，并确认已关闭超额额度使用。",
        ),
};
