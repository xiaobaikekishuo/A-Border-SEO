import { useSyncExternalStore } from "react";
import { ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";

const noSubscribe = () => () => {};

export function Ga4SetupGuide({domain, oauthClientId}: {domain:string; oauthClientId?:string}) {
  const {t} = useI18n();
  // The origin this browser actually uses (the port can change with LOCAL_APP_PORT).
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => "http://localhost:3300");
  const project = oauthClientId?.split("-")[0];
  const cloud = (path:string) => "https://console.cloud.google.com/" + path + (project ? "?project=" + project : "");
  const link = "inline-flex items-center gap-1 text-link underline underline-offset-2";
  const code = "select-all break-all rounded bg-background px-1.5 py-0.5 text-sm";
  const step = "space-y-1.5 pl-1 marker:font-semibold";
  return <details className="rounded-xl border border-border p-4 text-sm">
    <summary className="cursor-pointer font-medium">
      {t("First sync guide · Find the ID and configure Google", "首次同步指南 · 查找媒体资源 ID，配置 Google 授权")}
    </summary>
    <ol className="mt-4 list-decimal space-y-5 pl-5 leading-6">
      <li className={step}>
        <strong>{t("Find the property for " + domain, "找到 " + domain + " 的媒体资源 ID")}</strong>
        <p>{t("In Google Analytics, click the property name at the top and choose the property that collects data for this website. If the name is ambiguous, open Admin → Data streams and check the website URL.", "打开 Google Analytics，点顶部的媒体资源名称，选择收集本站数据的资源。如果资源名称看不出域名，点左下角齿轮「管理」→「数据流」，核对网站网址。")}</p>
        <p>{t("Go to Admin → Property details. Copy the numeric Property ID into the field above. A code starting with G- is a stream measurement ID.", "点「管理」→「媒体资源详细信息」，把标为「媒体资源 ID」的一串纯数字复制到上方输入框。以 G- 开头的是数据流的衡量 ID。")}</p>
        <a className={link} href="https://analytics.google.com/analytics/web/" target="_blank" rel="noreferrer">{t("Open Google Analytics", "打开 Google Analytics")} <ExternalLink size={14} aria-hidden="true" /></a>
      </li>
      <li className={step}>
        <strong>{t("Enable the reporting API in the OAuth project", "在工作台登录所用的 Cloud 项目启用报表 API")}</strong>
        {project && <p>{t("The Google OAuth client configured for this workbench belongs to project number ", "当前工作台使用的 Google OAuth 客户端对应的项目编号为 ")}<code className={code}>{project}</code>{t(". The Cloud links below select this project.", "。下方 Cloud 链接会带上这个项目编号。")}</p>}
        <p>{t("Use a Google account that can manage that Cloud project. Open the API below, check the selected project at the top, then click Enable. If the button says Manage, continue to step 3.", "用有权管理该 Cloud 项目的账号打开下方 API 页面，核对顶部项目后，点击「启用」。如果显示「管理」，说明已经启用，可继续第 3 步。")}</p>
        <a className={link} href={cloud("apis/library/analyticsdata.googleapis.com")} target="_blank" rel="noreferrer">{t("Open Google Analytics Data API", "打开 Google Analytics Data API")} <ExternalLink size={14} aria-hidden="true" /></a>
      </li>
      <li className={step}>
        <strong>{t("Add Analytics read-only access and check test users", "添加 Analytics 只读权限，核对测试用户")}</strong>
        <p>{t("Under Google Auth Platform → Data Access, click Add or remove scopes. Search for analytics.readonly (or enter the full scope below), select it, then click Update and Save.", "进入 Google Auth Platform →「数据访问」→「添加或移除范围」。搜索 analytics.readonly（也可手动输入下方完整范围），选中后点「更新」并保存。")}</p>
        <code className={code}>https://www.googleapis.com/auth/analytics.readonly</code>
        <p>{t("For an external app with Publishing status set to Testing, go to Audience → Test users → Add users. Enter the Google email you will use to read the GA4 report, then save.", "如果应用为「外部」且发布状态为「测试」，进入「目标对象」（受众）→「测试用户」→「Add users／添加用户」，填入稍后用于读取 GA4 报表的 Google 邮箱并保存。")}</p>
        <div className="flex flex-wrap gap-x-4"><a className={link} href={cloud("auth/scopes")} target="_blank" rel="noreferrer">{t("Data Access", "打开数据访问")} <ExternalLink size={14} aria-hidden="true" /></a><a className={link} href={cloud("auth/audience")} target="_blank" rel="noreferrer">{t("Audience", "打开目标对象")} <ExternalLink size={14} aria-hidden="true" /></a></div>
      </li>
      <li className={step}>
        <strong>{t("Allow this local browser origin", "为已有的 Web 客户端添加本地来源")}</strong>
        <p>{t("Open Google Auth Platform → Clients. Open the Web application used to sign in to this workbench. Match its Client ID to the one shown below when available.", "进入 Google Auth Platform →「客户端」，打开用于登录本工作台的「Web 应用」客户端。有多个客户端时，按客户端 ID 核对。")}</p>
        {oauthClientId && <p><span>{t("Workbench client ID", "工作台客户端 ID")} </span><code className={code}>{oauthClientId}</code></p>}
        <p>{t("Under Authorized JavaScript origins, click Add URI for each missing entry below. Enter one origin per row, keep your existing entries, and save.", "找到「已获授权的 JavaScript 来源」。对尚未列出的地址分别点「添加 URI」，每行填一个，保留原有条目，然后点「保存」。")}</p>
        <div className="grid justify-items-start gap-1"><code className={code}>http://localhost</code><code className={code}>{origin}</code></div>
        <a className={link} href={cloud("auth/clients")} target="_blank" rel="noreferrer">{t("Open OAuth clients", "打开 OAuth 客户端")} <ExternalLink size={14} aria-hidden="true" /></a>
      </li>
      <li className={step}>
        <strong>{t("Return here and sync the first report", "回到这个页面，完成首次同步")}</strong>
        <p>{t("Check the numeric property ID and dates above. The default period is fine for a first sync. Click Prepare Google connection, then Authorize and sync report. Choose an account with Viewer access or higher on the selected GA4 property and grant read-only Analytics access.", "核对上方的纯数字媒体资源 ID，首次可沿用默认日期。点「准备 Google 连接」，再点「授权并同步报表」。在弹窗中选择对该 GA4 资源有「查看者」或更高权限的账号，允许读取 Analytics 数据。")}</p>
        <p>{t("After the report is saved, AI referrals shows the reporting period and the matching sessions for this site.", "出现「已保存当前站点的 GA4 报表」后，在「AI 引荐流量」查看时段和本站可识别的引荐会话。")}</p>
      </li>
    </ol>
    <details className="mt-4 border-t border-border pt-3">
      <summary className="cursor-pointer">{t("Which step should I check if it fails?", "出现错误时，该检查哪一步？")}</summary>
      <ul className="mt-2 list-disc space-y-2 pl-5 text-muted-foreground">
        <li>{t("GA4 says you lack permission: switch to the Google account that can view this website in Analytics, or ask the property administrator for Viewer access.", "GA4 提示「缺少权限」时，切换到能查看本站 Analytics 报表的 Google 账号，或请媒体资源管理员授予「查看者」权限。")}</li>
        <li>{t("Google says the app is in testing and returns 403 access_denied: check the project and exact test email in step 3.", "Google 提示应用正在测试并显示 403 access_denied 时，回到第 3 步，核对项目和测试用户邮箱。")}</li>
        <li>{t("For origin_mismatch, check the client and both local origins in step 4. For an API-disabled error, revisit step 2.", "看到 origin_mismatch 时，核对第 4 步的客户端和两条本地来源。提示 API 未启用时，检查第 2 步。")}</li>
      </ul>
    </details>
  </details>;
}
