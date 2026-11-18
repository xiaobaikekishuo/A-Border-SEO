const labels = {
  hostedServices: ["Server workspace and this device", "服务器工作台与本机任务"],
  workspaceServer: ["Workspace server", "工作台服务器"],
  hostedHelp: ["Workspace data and scheduled tasks run on the server. Content generation runs on this device with its own ChatGPT login.", "工作台数据和定时任务在服务器运行。内容生成由本机使用自己的 ChatGPT 登录执行。"],
  hostedStart: ["Run the local Codex worker when I open the app", "打开应用时运行本机 Codex Worker"],
  hostedTray: ["Closing the window keeps this device's worker running. Exiting the app stops local tasks. Server tasks continue independently.", "关闭窗口后本机 Worker 继续运行。退出应用会停止本机任务，服务器任务独立运行。"],
  hosted_workspace_unavailable: ["The workspace server is temporarily unavailable. Check your connection and retry.", "工作台服务器暂时不可用，请检查网络后重试。"],
  hosted_action_unavailable: ["Manage the server from its administrator console.", "请在服务器管理员后台管理服务。"],
  workspace_logout_unconfirmed: ["Signed out on this computer. Server session revocation could not be confirmed. Reconnect and sign in again to rotate the device credential.", "本机已退出。暂未确认服务器会话撤销；恢复网络后请重新登录，以更新设备凭据。"],
  waiting_login: ["Waiting for ChatGPT sign-in", "等待 ChatGPT 登录"],
  signing_in: ["Signing in through the browser", "正在浏览器中登录"],
  stopping: ["Stopping", "正在停止"],
  chatgpt_login_required: ["Sign in to ChatGPT for local content tasks.", "请登录 ChatGPT 以执行本机内容任务。"],
  worker_token_invalid: ["Device authorization changed. Sign in again.", "设备授权已变更，请重新登录。"],
  worker_failed: ["Local content worker stopped. Check its connection and restart.", "本机内容 Worker 已停止，请检查连接后重新启动。"],
  codex_executable_missing: ["Install a supported Codex CLI for local content tasks.", "请安装可用的 Codex CLI 以执行本机内容任务。"],
  panel: ["Your SEO workspace", "你的 SEO 工作台"],
  settings: ["Settings", "设置"],
  backHome: ["Back to workspace", "返回工作台"],
  welcomeTitle: ["Welcome to A-Border SEO", "欢迎使用 A-Border SEO"],
  welcomeHelp: ["Sign in to your account to open your workspace.", "登录账号，即可进入你的工作台。"],
  loginTitle: ["Sign in to A-Border SEO", "登录 A-Border SEO"],
  registerTitle: ["Create your account", "注册 A-Border SEO"],
  registerHelp: ["Create an account to request access to your workspace.", "创建账号，申请开通你的工作台。"],
  signedInHelp: ["Open your workspace or manage this device's settings.", "进入你的工作台，或管理此设备的设置。"],
  brandDescription: ["Your cross-border SEO data and site management tools, together in one workspace. Turn search insights into your next step.", "专业的跨境 SEO 数据与站点管理工具，助你高效提升网站的搜索表现。"],
  featureMonitor: ["Site monitoring", "站点监控"],
  featureMonitorHelp: ["Traffic & rankings", "流量与排名洞察"],
  featureKeywords: ["Keywords", "关键词管理"],
  featureKeywordsHelp: ["Discover & track", "挖掘与跟踪"],
  featureSync: ["Data sync", "数据同步"],
  featureSyncHelp: ["Connect GSC & Bing", "连接 GSC 与 Bing"],
  usernamePlaceholder: ["Enter your username", "请输入用户名"],
  passwordPlaceholder: ["Enter your password", "请输入密码"],
  confirmPasswordPlaceholder: ["Enter your password again", "请再次输入密码"],
  showPassword: ["Show password", "显示密码"],
  hidePassword: ["Hide password", "隐藏密码"],
  secureLogin: ["Stay signed in on this device", "在此设备保持登录"],
  forgotPassword: ["Forgot password?", "忘记密码？"],
  passwordHelp: ["Contact your A-Border SEO administrator for help recovering your account. Self-service password reset is not available yet.", "请联系 A-Border SEO 管理员协助找回账号。当前暂不支持自助重置密码。"],
  noAccount: ["New to A-Border SEO?", "还没有账号？"],
  hasAccount: ["Already have an account?", "已经有账号？"],
  registerNow: ["Create an account", "立即注册"],
  backToLogin: ["Sign in", "返回登录"],
  signingIn: ["Signing in…", "正在登录…"],
  registering: ["Submitting…", "正在提交…"],
  signIn: ["Sign in", "登录"],
  register: ["Create account", "注册账号"],
  signOut: ["Sign out", "退出登录"],
  username: ["Username", "用户名"],
  password: ["Password", "密码"],
  confirmPassword: ["Confirm password", "确认密码"],
  registrationHelp: ["Use 3 to 64 letters, digits, dots, underscores or hyphens for your username and at least 8 characters for your password. An administrator must approve your account before use.", "用户名使用 3 至 64 位字母、数字、点、下划线或短横线，密码至少 8 位。注册后需管理员批准才能使用。"],
  approvalPending: ["Your account is awaiting approval. Once approved, sign in with your username and password.", "账号已提交审核。管理员批准后，请使用用户名和密码登录。"],
  enterWorkspace: ["Enter workspace", "进入工作台"],
  preparingWorkspace: ["Preparing your workspace. First startup can take a few minutes.", "正在准备工作台，首次启动可能需要几分钟。"],
  workspaceReady: ["Your workspace is ready.", "工作台已就绪。"],
  account_pending: ["Your account is awaiting administrator approval.", "账号正在等待管理员批准。"],
  account_expired: ["Your account authorization has expired. Contact the administrator.", "账号授权已到期，请联系管理员。"],
  username_taken: ["This username is already registered. Choose another or sign in.", "此用户名已注册，请更换用户名或直接登录。"],
  account_already_registered: ["This installation already has a registered account. Sign in to that account.", "此安装已关联注册账号，请登录原账号。"],
  invalid_registration: ["Check the username and password requirements.", "请检查用户名和密码是否符合要求。"],
  invalid_user_credentials: ["Check your username and password.", "请检查用户名和密码。"],
  password_mismatch: ["The passwords do not match.", "两次输入的密码不一致。"],
  user_login_required: ["Sign in to your account first.", "请先登录账号。"],
  workspace_login_failed: ["Workspace sign-in failed. Retry or check the workspace version in Settings.", "工作台登录失败，请重试，或在设置中检查后台版本。"],
  use_desktop_workspace: ["Use the desktop workspace to access this account.", "请在客户端工作台中使用此账号。"],
  rate_limited: ["Too many attempts. Please wait and retry.", "操作过于频繁，请稍后重试。"],
  device_unavailable: ["This device cannot be linked. Contact the administrator.", "此设备暂时无法关联账号，请联系管理员。"],
  device_authentication_failed: ["This device credential is no longer valid. Sign in again or contact the administrator.", "设备凭据已失效，请重新登录或联系管理员。"],
  management: ["Device authorization", "设备授权"],
  checkManagement: ["Check authorization", "检查授权"],
  activationCode: ["One-time activation code", "一次性激活码"],
  activate: ["Register this device", "注册此设备"],
  reauthorize: ["Enter a new activation code", "输入新的激活码"],
  feature_disabled: ["The administrator has disabled this feature.", "管理员已停用此功能。"],
  installationId: ["Installation ID", "安装标识"],
  managementServer: ["Management server", "管理服务器"],
  policy: ["Policy", "当前策略"],
  leaseExpiry: ["Authorization expires", "授权有效期"],
  connection: ["Connection", "管理连接"],
  online: ["Online", "已连接"],
  offline: ["Connection interrupted. Valid cached authorization remains in effect until it expires.", "管理服务暂时无法连接，已验证的缓存授权在到期前继续生效。"],
  idle: ["Awaiting registration", "等待注册"],
  activation_required: ["Register this device before using the workspace.", "请先注册此设备，再使用工作台。"],
  product_disabled: ["Workspace access has been suspended for this product.", "管理员已停用此产品的工作台。"],
  account_disabled: ["Your management account is suspended.", "管理账号已停用。"],
  device_disabled: ["This device is suspended or its binding was removed.", "此设备已停用或解除绑定。"],
  entitlement_expired: ["The account's authorization has expired.", "账号授权已到期。"],
  lease_expired: ["Reconnect to renew authorization.", "授权已到期，请联网续期。"],
  clock_invalid: ["Check this computer's date and time, then refresh authorization.", "请检查电脑日期和时间，然后刷新授权。"],
  update_required: ["Update the desktop app and workspace to continue.", "请更新桌面端和后台工作台后继续。"],
  maintenance: ["Maintenance is active. You can view existing work and make backups.", "系统维护中，可以查看已有工作和备份。"],
  authorized: ["Authorized", "已授权"],
  invalid_lease: ["Authorization could not be verified.", "无法验证本机授权。"],
  activation_invalid: ["Check the one-time activation code.", "请检查一次性激活码。"],
  invalid_activation: ["Check the one-time activation code or ask for a new one.", "请检查激活码，或联系管理员获取新码。"],
  activation_expired: ["Ask your administrator for a new activation code.", "请联系管理员获取新的激活码。"],
  device_limit: ["The account has reached its device limit.", "该账号已达到设备数量上限。"],
  device_limit_reached: ["The account has reached its device limit.", "该账号已达到设备数量上限。"],
  management_unavailable: ["The management service is temporarily unavailable.", "管理服务暂时不可用。"],
  management_state_unavailable: ["The local authorization state could not be written.", "无法写入本机授权状态。"],
  backend_guard_pending: ["Wait for the managed workspace to confirm the current policy.", "请等待受管后台确认当前策略。"],
  device_credential_unavailable: ["Windows could not unlock the protected device credential.", "Windows 无法解锁设备凭据。"],
  device_already_registered: ["This device is already registered.", "此设备已注册。"],
  installation_already_bound: ["This installation already has an account binding.", "此安装已绑定管理账号。"],
  account_unavailable: ["Ask the administrator to check the account's authorization.", "请联系管理员检查账号授权。"],
  device_requires_reactivation: ["Ask the administrator for a code for this installation.", "请联系管理员为此安装签发重新绑定码。"],
  no_managed_target: ["No update has been assigned to this device.", "管理员暂未向此设备下发更新。"],
  managed_release_not_assigned: ["The administrator has paused or changed this update.", "管理员已暂停或变更此更新。"],
  language: ["Language", "语言"],
  services: ["Services", "服务"],
  refresh: ["Refresh", "刷新"],
  open: ["Open workspace", "打开工作台"],
  browser: ["Open in browser", "在浏览器中打开"],
  start: ["Start services", "启动服务"],
  stop: ["Stop services", "停止服务"],
  loginCodex: ["Sign in to Codex in browser", "在浏览器中登录 Codex"],
  startWorker: ["Start Codex worker", "启动 Codex Worker"],
  stopWorker: ["Stop Codex worker", "停止 Codex Worker"],
  startOnLaunch: ["Start services when I open the app", "打开应用时启动服务"],
  tray: ["Closing a window keeps services running. To exit or stop services, use the system tray menu.", "关闭窗口后服务继续运行。通过系统托盘菜单退出或停止服务。"],
  setup: ["Set up the workspace", "配置工作台"],
  setupHelp: ["Select an existing Windows installation to keep its database and sign-ins, or configure a fresh instance.", "接管旧 Windows 安装可沿用数据库和授权，也可以新建实例。"],
  selectLegacy: ["Select existing installation", "选择已有安装"],
  legacyOptions: ["Specify Docker context or Compose project", "指定 Docker 上下文或 Compose 项目"],
  adopt: ["Use this installation", "接管此安装"],
  oauthHelp: ["Register the callback URLs http://localhost:3300/api/auth/callback/google and http://localhost:3300/desktop/oauth/ga4/callback in your Google Web OAuth client.", "请在 Google 网页应用 OAuth 客户端登记回调 http://localhost:3300/api/auth/callback/google 和 http://localhost:3300/desktop/oauth/ga4/callback。"],
  clientId: ["Google OAuth Client ID", "Google OAuth 客户端 ID"],
  clientSecret: ["Google OAuth Client Secret", "Google OAuth 客户端密钥"],
  createVolume: ["Create a new PostgreSQL volume for this instance", "为此实例创建新的 PostgreSQL 数据卷"],
  create: ["Configure and start", "配置并启动"],
  update: ["Updates", "更新"],
  check: ["Check for updates", "检查更新"],
  manualUpdate: ["Open assigned release", "打开已分配版本的下载页"],
  download: ["Download update", "下载更新"],
  cancel: ["Cancel download", "取消下载"],
  install: ["Restart and install", "重启并安装"],
  backend: ["Apply workspace update", "更新后台工作台"],
  autoCheck: ["Check automatically", "自动检查更新"],
  data: ["Data and diagnostics", "数据与诊断"],
  backup: ["Back up", "备份"],
  logs: ["View diagnostics", "查看诊断"],
  db: ["PostgreSQL", "PostgreSQL"],
  app: ["Workspace", "工作台"],
  worker: ["Background worker", "后台 Worker"],
  contentWorker: ["Local Codex worker", "本机 Codex Worker"],
  dataRoot: ["Data directory", "数据目录"],
  context: ["Docker context", "Docker 上下文"],
  project: ["Compose project", "Compose 项目"],
  volume: ["Database volume", "数据库卷"],
  desktopVersion: ["Desktop version", "桌面版本"],
  backendVersion: ["Workspace version", "后台版本"],
  targetVersion: ["Available version", "可用版本"],
  dockerReady: ["Docker Desktop is ready.", "Docker Desktop 已就绪。"],
  dockerOffline: ["Start Docker Desktop in Linux container mode and refresh.", "请启动 Docker Desktop，使用 Linux 容器模式，然后刷新。"],
  codexUnavailable: ["Install a supported Codex CLI to run local content tasks.", "如需执行本机内容任务，请安装可用的 Codex CLI。"],
  missingRelease: ["This internal build has no release manifest. Fresh setup and package downloads require a release build.", "此内部构建缺少发行清单。首次配置和下载更新需要发行构建。"],
  localBuild: ["Internal build. Fresh setup uses the prepared local Docker image. Automatic updates are disabled.", "本机测试版。首次配置使用已准备好的本地 Docker 镜像，自动更新已关闭。"],
  manual: ["This build uses manually downloaded installers.", "此构建通过手动下载安装包升级。"],
  checking: ["Checking for updates…", "正在检查更新…"],
  current: ["You have the latest desktop version.", "当前是最新桌面版本。"],
  check_failed: ["The update server did not respond successfully. Try again later.", "未能从更新服务器获取版本，请稍后重试。"],
  available: ["An update is available. You can download it now or come back later.", "有可用更新。可以现在下载，也可以稍后处理。"],
  pulling: ["Preparing the new workspace image…", "正在准备新版本后台镜像…"],
  downloading: ["Downloading the Windows installer…", "正在下载 Windows 安装包…"],
  downloaded: ["The installer is ready. Restart when your work is saved.", "安装包已就绪。保存工作后即可重启安装。"],
  download_failed: ["Preparation was interrupted. Check again to retry the download.", "更新准备中断。请再次检查并重试下载。"],
  installing: ["Waiting for the updated desktop app to start.", "等待新版桌面应用启动。"],
  upgrading: ["Applying the workspace update. Keep Docker Desktop running.", "正在更新后台，请保持 Docker Desktop 运行。"],
  failed: ["Workspace update paused. Check diagnostics and retry.", "后台更新已暂停，请检查诊断后重试。"],
  complete: ["Workspace update completed.", "后台更新已完成。"],
  working: ["Working…", "正在处理…"],
  done: ["Completed.", "操作完成。"],
  emptyLogs: ["No diagnostic events.", "暂无诊断事件。"],
  healthy: ["Healthy", "正常"],
  running: ["Running", "运行中"],
  stopped: ["Stopped", "已停止"],
  missing: ["Absent", "未创建"],
  starting: ["Starting", "启动中"],
  unhealthy: ["Needs attention", "异常"],
  unavailable: ["Unavailable", "不可用"],
  powershell_missing: ["Install PowerShell 7.3 or later, then reopen A-Border SEO.", "请安装 PowerShell 7.3 或更新版本，然后重新打开 A-Border SEO。"],
  powershell_version: ["Update to PowerShell 7.3 or later, then refresh.", "请更新到 PowerShell 7.3 或更高版本，然后刷新。"],
  docker_not_running: ["Start Docker Desktop and refresh.", "请启动 Docker Desktop，然后刷新。"],
  docker_missing: ["Install Docker Desktop and reopen this app.", "请安装 Docker Desktop，然后重新打开本应用。"],
  linux_amd64_required: ["Switch Docker Desktop to its Linux x64 engine.", "请将 Docker Desktop 切换到 Linux x64 引擎。"],
  local_context_required: ["Select the local Docker Desktop context.", "请选择本机 Docker Desktop 上下文。"],
  compose_missing: ["Update Docker Desktop or enable Docker Compose v2.", "请更新 Docker Desktop 或启用 Docker Compose v2。"],
  port_conflict: ["Port 3300 or its authentication URL conflicts with the workspace. Check the selected installation.", "3300 端口或授权 URL 与工作台配置冲突。请检查所选安装。"],
  jobs_running: ["Background work is still active. Wait for it to finish and retry.", "后台任务仍在运行，请等待完成后重试。"],
  existing_installation: ["An existing database volume was found. Select its original Windows installation.", "发现已有数据库卷。请选择对应的原 Windows 安装。"],
  project_selection_required: ["Enter the intended Compose project and select the installation again.", "请输入要接管的 Compose 项目，再次选择安装目录。"],
  invalid_docker_selection: ["Enter a valid Docker context and Compose project name.", "请输入有效的 Docker 上下文和 Compose 项目名称。"],
  internal_image_missing: ["Load the Docker image prepared for this internal build, then retry.", "请载入此测试包对应的本地 Docker 镜像，然后重试。"],
  internal_image_mismatch: ["The local image differs from this internal build. Load the matching image.", "本地镜像与此测试包不匹配。请载入对应镜像。"],
  content_worker_start_failed: ["The local Codex worker could not start. Check diagnostics and its dedicated sign-in.", "本机 Codex Worker 未能启动。请检查诊断和专用账号授权。"],
  codex_login_required: ["Sign in to the dedicated Codex profile in your browser.", "请在浏览器中登录专用 Codex 账号。"],
  app_not_ready: ["Start the workspace services and wait for the health check.", "请启动服务并等待工作台通过健康检查。"],
  desktop_backend_required: ["Use the browser for this installation, or apply the workspace update for desktop sign-in.", "此安装可用浏览器打开。更新后台后即可使用桌面登录。"],
  backend_update_incomplete: ["Retry the workspace update before starting services.", "请先重试后台更新，再启动服务。"],
  installer_launch_failed: ["The installer did not start. Try again or open the installer manually.", "安装程序未启动。请重试或手动打开安装包。"],
  upgrade_status_unavailable: ["Reconnect the original installation before retrying the workspace update.", "请重新连接原安装，再重试后台更新。"],
  update_download_failed: ["The installer download failed. Retry or use a manually downloaded installer.", "安装包下载失败。请重试或手动下载安装包。"],
  invalid_google_credentials: ["Enter a Google Web OAuth client ID and secret, and confirm the new volume.", "请填写 Google 网页应用 OAuth 客户端 ID 和密钥，并确认创建数据卷。"],
};

const panel = window.controlPanel;
const byId = id => document.getElementById(id);
let state;
let showReauthorization = false;
let registrationMode = false;
const text = key => labels[key]?.[state?.language === "zh" ? 1 : 0] ?? key;
const statusText = value => value ? text(value) : "–";

function rows(id, pairs) {
  byId(id).replaceChildren(...pairs.flatMap(([label, value]) => {
    const key = document.createElement("dt");
    const cell = document.createElement("dd");
    key.textContent = text(label);
    cell.textContent = value || "–";
    return [key, cell];
  }));
}

function enabled(id, condition) {
  byId(id).disabled = !condition || Boolean(state.busy);
}

function hide(id, value) {
  byId(id).hidden = value;
}

function render(next) {
  if (!next) return;
  state = next;
  const { status, statusError, error, result, busy, update, journal, selection } = next;
  if (result?.action === "RegisterUser") registrationMode = false;
  const managed = next.managed;
  const decision = managed?.decision;
  const mayView = !decision || decision.allowed || decision.reason === "maintenance";
  const ready = !status?.issue && status?.services?.app === "healthy";
  const configured = status?.configured;
  const dockerReady = status?.docker?.available && status.docker.linux && status.docker.compose;
  const incomplete = journal?.version === state.currentVersion && ["installing", "failed", "upgrading"].includes(journal.phase);
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-text]").forEach(element => { element.textContent = text(element.dataset.text); });
  document.querySelectorAll("[data-placeholder]").forEach(element => { element.placeholder = text(element.dataset.placeholder); });
  document.querySelectorAll("[data-label]").forEach(element => { element.setAttribute("aria-label", text(element.dataset.label)); });
  document.querySelectorAll("button, input, select").forEach(element => { element.disabled = Boolean(busy); });
  document.querySelectorAll("[data-language]").forEach(button => { button.setAttribute("aria-pressed", String(button.dataset.language === state.language)); });
  byId("auto-check").checked = state.autoCheck && state.automaticUpdatesAvailable;
  byId("start-on-launch").checked = state.startOnLaunch;
  const settingsView = next.view === "settings";
  document.body.dataset.view = settingsView ? "settings" : "home";
  const toolbar = byId("panel-toolbar");
  const toolbarParent = byId(settingsView ? "settings-view" : "auth-card");
  if (toolbar.parentElement !== toolbarParent) {
    toolbarParent.prepend(toolbar);
    if (settingsView) toolbar.after(byId("message"));
    else byId("user-access").before(byId("message"));
  }
  hide("settings-view", !settingsView);
  hide("welcome", settingsView);
  hide("settings-link", settingsView);
  hide("home-link", !settingsView);
  hide("user-access", !managed || managed.signedIn);
  hide("signed-in", !managed?.signedIn);
  hide("unmanaged-home", Boolean(managed));
  hide("pending-notice", !managed?.pendingUsername);
  hide("confirm-password", !registrationMode);
  hide("registration-help", !registrationMode);
  byId("auth-title").textContent = text(!managed || managed.signedIn ? "welcomeTitle" : registrationMode ? "registerTitle" : "loginTitle");
  byId("auth-help").textContent = text(!managed || managed.signedIn ? "signedInHelp" : registrationMode ? "registerHelp" : "welcomeHelp");
  byId("user-submit-label").textContent = text(busy === "LoginUser" ? "signingIn" : busy === "RegisterUser" ? "registering" : registrationMode ? "register" : "signIn");
  byId("user-form").setAttribute("aria-busy", String(Boolean(busy)));
  hide("login-tab", !registrationMode);
  hide("register-tab", registrationMode);
  hide("login-options", registrationMode);
  byId("auth-switch-label").textContent = text(registrationMode ? "hasAccount" : "noAccount");
  if (registrationMode || managed?.signedIn) {
    hide("password-help", true);
    byId("password-help-toggle").setAttribute("aria-expanded", "false");
  }
  updatePasswordVisibility(managed?.signedIn ? false : byId("user-password").type === "text");
  byId("user-form").elements.confirmPassword.required = registrationMode;
  byId("user-form").elements.password.autocomplete = registrationMode ? "new-password" : "current-password";
  if (managed?.pendingUsername && !byId("user-form").elements.username.value) byId("user-form").elements.username.value = managed.pendingUsername;
  byId("user-greeting").textContent = managed?.user?.username ?? "";
  byId("workspace-state").textContent = busy ? text("preparingWorkspace")
    : !mayView ? text(decision.reason) : ready ? text("workspaceReady") : text("preparingWorkspace");
  enabled("enter-workspace", mayView);
  hide("management", !managed);
  if (managed) {
    hide("activation", Boolean(managed.accountId) && !showReauthorization);
    hide("reauthorize", !managed.accountId || showReauthorization);
    rows("management-details", [
      ["managementServer", managed.server], ["installationId", managed.installationId],
      ["connection", managed.connection === "checking" ? text("working") : text(managed.connection)],
      ["policy", text(decision.reason ?? "authorized")],
      ["leaseExpiry", managed.expiresAt ? new Date(managed.expiresAt * 1000).toLocaleString() : ""],
    ]);
    byId("management-notice").textContent = decision.maintenanceMessage || "";
    hide("management-notice", !decision.maintenanceMessage);
  }
  byId("prerequisites").textContent = next.hosted ? text("hostedHelp") : status
    ? [text(dockerReady ? "dockerReady" : labels[status.docker?.reason] ? status.docker.reason : "dockerOffline"),
      ready && !status.desktopMode ? text("desktop_backend_required") : "",
      configured && !status.codex?.available ? text("codexUnavailable") : ""].filter(Boolean).join(" ")
    : "";
  rows("service-list", ["app", "contentWorker", ...(!next.hosted ? ["db", "worker"] : [])].map(name => [name, statusText(status?.services?.[name])]));
  if (next.hosted) {
    document.querySelector('[data-text="services"]').textContent = text("hostedServices");
    document.querySelector('[data-text="startOnLaunch"]').textContent = text("hostedStart");
    document.querySelector('[data-text="tray"]').textContent = text("hostedTray");
    byId("prerequisites").textContent += " " + next.workspaceOrigin;
  }
  hide("local-data", Boolean(next.hosted));
  for (const id of ["start", "stop", "browser"]) hide(id, Boolean(next.hosted));
  rows("instance", [["dataRoot", state.dataRoot], ["context", status?.context], ["project", status?.project], ["volume", status?.volume]]);
  rows("versions", [["desktopVersion", state.currentVersion], ["backendVersion", status?.backendVersion ?? (ready ? status.image : "")],
    ...((update.version || decision?.release?.version) ? [["targetVersion", update.version || decision.release.version]] : [])]);
  hide("setup", Boolean(configured));
  hide("create", !state.bundledRelease);
  hide("google-setup", Boolean(managed));
  byId("create").elements.googleClientId.required = !managed;
  byId("create").elements.googleClientSecret.required = !managed;
  hide("legacy", !selection);
  if (error?.code === "project_selection_required") byId("legacy-options").open = true;
  hide("codex-actions", !configured);
  if (selection) rows("legacy-details", [
    ["dataRoot", selection.legacyRoot], ["context", selection.data.context],
    ["project", selection.data.project], ["volume", selection.data.volume],
  ]);
  enabled("open", ready && status.desktopMode && mayView);
  enabled("browser", ready && mayView && !managed);
  enabled("start", configured && dockerReady && !incomplete && !status.issue);
  enabled("create-instance", !configured && dockerReady && !status?.issue && state.bundledRelease);
  enabled("stop", configured && dockerReady);
  enabled("login-codex", configured && (next.hosted ? next.localWorker?.available !== false && decision?.allowed && decision.features.codex : status.codex?.available));
  enabled("start-worker", ready && (next.hosted || status.codex?.available && status.codex?.configured) && !["running", "working", "starting", "signing_in"].includes(status.services.contentWorker)
    && (!decision || (decision.allowed && decision.features.codex)));
  enabled("stop-worker", ["running", "working", "waiting_login", "starting"].includes(status?.services?.contentWorker));
  enabled("backup", configured && dockerReady);
  enabled("logs", configured);
  enabled("check", state.automaticUpdatesAvailable);
  hide("manual-update", !next.hosted || state.automaticUpdatesAvailable || !decision?.release?.version ||
    decision.release.version === state.currentVersion);
  enabled("auto-check", state.automaticUpdatesAvailable);
  hide("download", update.phase !== "available");
  hide("cancel", !["pulling", "downloading"].includes(update.phase));
  byId("cancel").disabled = false;
  hide("install", update.phase !== "downloaded");
  hide("backend", next.hosted || !state.backendUpdateAvailable && !incomplete);
  enabled("backend", dockerReady && configured);
  hide("progress", update.phase !== "downloading");
  byId("progress").value = update.progress ?? 0;
  hide("notes", !update.notes);
  byId("notes").textContent = update.notes ?? "";
  hide("journal", !journal);
  byId("journal").textContent = journal ? [journal.version, text(journal.phase)].join(" · ") : "";
  byId("update-status").textContent = update.phase !== "idle" ? text(update.phase)
    : state.automaticUpdatesAvailable ? "" : text(next.hosted ? "manual" : state.internalPackage ? "localBuild" : state.bundledRelease ? "manual" : "missingRelease");
  const issue = error ?? statusError ?? (next.managementError ? { code: next.managementError } : null)
    ?? (status?.issue ? { code: status.issue } : null) ?? (next.localWorker?.error ? { code: next.localWorker.error } : null);
  const warning = result?.data?.warning;
  const message = byId("message");
  message.dataset.error = String(Boolean(issue));
  message.textContent = issue ? [text(issue.code), issue.details].filter(Boolean).join("\n")
    : busy ? text("working") : warning ? text(warning) : result ? text("done") : "";
  message.hidden = !message.textContent;
  const diagnostics = byId("diagnostics");
  if (result?.action === "Logs") {
    const records = result.data?.events ?? result.data;
    diagnostics.textContent = Array.isArray(records)
      ? records.map(entry => [entry.service, entry.time, entry.code ?? entry.event, entry.detail].filter(Boolean).join("  ")).join("\n") || text("emptyLogs")
      : text("emptyLogs");
    diagnostics.hidden = false;
  }
  if (result?.action === "Backup" && result.data) {
    diagnostics.textContent = [result.data.backupPath ?? result.data.path ?? result.data.directory, result.data.sha256].filter(Boolean).join("\n");
    diagnostics.hidden = !diagnostics.textContent;
  }
  if (configured) byId("create").reset();
}

document.querySelectorAll("button[data-action]").forEach(button => {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    const input = action === "InspectLegacy" ? {
      context: byId("legacy-context").value, project: byId("legacy-project").value,
    } : undefined;
    void panel.act(action, input);
  });
});
for (const [tab, mode] of [["login-tab", false], ["register-tab", true]]) {
  byId(tab).addEventListener("click", () => {
    registrationMode = mode;
    byId("user-form").elements.password.value = "";
    byId("user-form").elements.confirmPassword.value = "";
    byId("user-form").elements.confirmPassword.setCustomValidity("");
    updatePasswordVisibility(false);
    render({ ...state, result: null });
  });
}
function updatePasswordVisibility(visible) {
  byId("user-password").type = visible ? "text" : "password";
  byId("toggle-password").setAttribute("aria-pressed", String(visible));
  byId("toggle-password").setAttribute("aria-label", text(visible ? "hidePassword" : "showPassword"));
}
byId("toggle-password").addEventListener("click", () => {
  updatePasswordVisibility(byId("user-password").type === "password");
});
byId("password-help-toggle").addEventListener("click", () => {
  const expanded = byId("password-help").hidden;
  hide("password-help", !expanded);
  byId("password-help-toggle").setAttribute("aria-expanded", String(expanded));
});
byId("user-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  if (registrationMode && fields.get("password") !== fields.get("confirmPassword")) {
    form.elements.confirmPassword.setCustomValidity(text("password_mismatch"));
    form.elements.confirmPassword.reportValidity();
    return;
  }
  const input = { username: fields.get("username"), password: fields.get("password") };
  form.elements.password.value = "";
  form.elements.confirmPassword.value = "";
  updatePasswordVisibility(false);
  void panel.act(registrationMode ? "RegisterUser" : "LoginUser", input);
});
for (const name of ["password", "confirmPassword"]) {
  byId("user-form").elements[name].addEventListener("input", () => {
    byId("user-form").elements.confirmPassword.setCustomValidity("");
  });
}
byId("create").addEventListener("submit", event => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  void panel.act("Setup", {
    googleClientId: fields.get("googleClientId"),
    googleClientSecret: fields.get("googleClientSecret"),
    createVolume: fields.get("createVolume") === "on",
  }).finally(() => { form.elements.googleClientSecret.value = ""; });
});
byId("activation").addEventListener("submit", event => {
  event.preventDefault();
  const field = event.currentTarget.elements.code;
  const code = field.value;
  field.value = "";
  void panel.act("ActivateManaged", { code });
});
byId("reauthorize").addEventListener("click", () => {
  showReauthorization = true;
  render(state);
  byId("activation").elements.code.focus();
});
function saveSettings(language = state.language) {
  void panel.act("Settings", {
    language, autoCheck: byId("auto-check").checked, startOnLaunch: byId("start-on-launch").checked,
  });
}
document.querySelectorAll("[data-language]").forEach(button => {
  button.addEventListener("click", () => saveSettings(button.dataset.language));
});
for (const id of ["auto-check", "start-on-launch"]) {
  byId(id).addEventListener("change", () => {
    saveSettings();
  });
}
panel.subscribe(render);
void panel.read().then(render);
