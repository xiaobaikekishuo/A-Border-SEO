const byId = id => document.getElementById(id);
const featureNames = { jobs: "后台任务", codex: "本机 Codex 与 ChatGPT 任务", manus: "Manus 研究", geo: "GEO 检测" };
const scopeNames = { product: "整个产品", account: "指定账号", device: "指定设备", group: "设备组" };
const receiptNames = {
  pending: "待下发", received: "已收到", draining: "正在收尾", effective: "已生效",
  failed: "执行失败", upgrading: "正在升级", offline: "离线／待确认",
};
const auditNames = {
  products: "产品", accounts: "账号授权", devices: "设备状态", policy: "管理策略",
  activation: "签发激活码", releases: "版本发布", device_activated: "设备绑定", device_receipt: "客户端回执",
  user_registered: "用户注册", user_login: "用户登录",
};
const apiErrors = {
  invalid_input: "请检查表单内容和长度。",
  invalid_scope: "请选择此产品内的有效目标。",
  invalid_maintenance_window: "维护结束时间必须晚于开始时间。",
  reason_required: "请填写操作原因。",
  account_unavailable: "该账号已停用或授权已到期。",
  device_requires_reactivation: "此设备需要使用新的激活码重新绑定。",
  minimum_exceeds_release: "最低版本必须等于或低于目标版本。",
  release_unverified: "发布资源尚未通过验证。",
  release_assets_unavailable: "安装包、更新元数据、发行清单或后台镜像验证失败。请检查对应版本的发行资源。",
  rollout_failed: "本版本已有测试失败回执。请保留当前范围或暂停投放，修复后发布更高版本。",
};
const pageInfo = {
  overview: ["总览", "查看当前产品的连接设备、版本分布和策略回执。"],
  accounts: ["账号授权", "审核新注册用户，设置授权期限、设备数量和可用功能。批准后用户可登录客户端。"],
  devices: ["设备管理", "核对最近在线、已安装版本和策略执行结果，管理设备分组与绑定。"],
  policies: ["维护与策略", "为整个产品或指定账号、设备与分组设置停用、维护和功能权限。"],
  releases: ["版本发布", "设置测试或稳定渠道、投放范围和最低版本。"],
  audit: ["操作记录", "核对管理员操作的作用范围、变更前后状态及原因。"],
};
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });
const ON_LINE_SECONDS = 180;
let state = null;
let csrf = null;
let page = Object.hasOwn(pageInfo, location.hash.slice(1)) ? location.hash.slice(1) : "overview";
let productId = null;
let readController = null;
let submitting = false;
let editorSubmit = null;
let editorProductId = null;
let deviceQuery = "";
let receiptPage = 0;

function el(tag, attributes = {}, ...content) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  node.append(...content.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false));
  return node;
}

function button(text, action, variant = "") {
  const node = el("button", { type: "button", class: `button ${variant}` }, text);
  node.addEventListener("click", action);
  return node;
}

function status(text, tone = "") {
  return el("span", { class: `pill ${tone}` }, text);
}

function date(value, fallback = "—") {
  const seconds = Number(value);
  return seconds > 0 && Number.isFinite(seconds) ? dateFormat.format(seconds * 1000) : fallback;
}

function isOnline(device) {
  return Number(device.lastSeenAt) > Date.now() / 1000 - ON_LINE_SECONDS;
}

function card(title, body, controls, table = false) {
  return el("article", { class: "card" },
    el("div", { class: "card-head" }, el("h2", {}, title), controls && el("div", { class: "actions" }, controls)),
    table ? body : el("div", { class: "card-body" }, body));
}

function dataTable(label, headings, rows, emptyText) {
  if (!rows.length) return el("p", { class: "empty" }, emptyText);
  return el("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": label },
    el("table", { "aria-label": label },
      el("thead", {}, el("tr", {}, headings.map(name => el("th", { scope: "col" }, name)))),
      el("tbody", {}, rows.map(row => el("tr", {}, row.map(cell => el("td", {}, cell)))))));
}

class HttpError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function api(path, { body, signal } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST", headers, signal,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store", credentials: "same-origin",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new HttpError(apiErrors[data?.error] || data?.error || `请求失败（HTTP ${response.status}）`, response.status);
  if (data === null && response.status !== 204) throw new Error("管理服务返回了无法读取的数据。");
  return data;
}

function notify(text = "", level = "success") {
  const node = byId("notification");
  node.textContent = text;
  node.dataset.level = level;
  node.hidden = !text;
}

function showLogin() {
  state = null;
  csrf = null;
  byId("editor").close();
  byId("console-view").hidden = true;
  byId("load-view").hidden = true;
  byId("login-view").hidden = false;
}

async function load({ feedback = false } = {}) {
  readController?.abort();
  const controller = new AbortController();
  readController = controller;
  const query = productId ? `?productId=${encodeURIComponent(productId)}` : "";
  byId("refresh").disabled = true;
  try {
    const data = await api("/admin/api/state" + query, { signal: controller.signal });
    if (controller.signal.aborted) return false;
    state = data;
    csrf = data.csrf;
    productId = data.product.id;
    byId("admin-name").textContent = data.username || "管理员";
    byId("console-view").hidden = false;
    byId("load-view").hidden = true;
    byId("login-view").hidden = true;
    render();
    if (feedback) notify("已刷新。");
    return true;
  } catch (error) {
    if (controller.signal.aborted) return false;
    if (error.statusCode === 401) showLogin();
    else if (state) notify(error.message || "无法连接管理服务。", "error");
    else {
      showLogin();
      const node = byId("login-error");
      node.textContent = error.message || "无法连接管理服务。";
      node.hidden = false;
    }
    return false;
  } finally {
    if (readController === controller) {
      readController = null;
      byId("refresh").disabled = false;
    }
  }
}

function field(label, name, value, attributes = {}) {
  const input = el("input", { name, ...attributes });
  input.value = value ?? "";
  return el("label", {}, label, input);
}

function area(label, name, value, attributes = {}) {
  const input = el("textarea", { name, ...attributes });
  input.value = value ?? "";
  return el("label", {}, label, input);
}

function check(label, name, checked) {
  const input = el("input", { type: "checkbox", name });
  input.checked = checked;
  return el("label", { class: "check" }, input, label);
}

function selectField(label, name, options, value) {
  const select = el("select", { name, required: true }, options.map(([id, text]) => el("option", { value: id }, text)));
  select.value = value;
  return el("label", {}, label, select);
}

function reason() {
  return area("操作原因", "reason", "", { required: true, maxlength: 500 });
}

function features(values) {
  return el("fieldset", {}, el("legend", {}, "允许功能"),
    Object.entries(featureNames).map(([key, label]) => check(label, `feature_${key}`, values?.[key] !== false)));
}

function readFeatures(data) {
  return Object.fromEntries(Object.keys(featureNames).map(key => [key, data.has(`feature_${key}`)]));
}

function featureText(values) {
  const blocked = Object.entries(featureNames).filter(([key]) => values?.[key] === false).map(([, label]) => label);
  return blocked.length ? blocked.join("、") : "全部允许";
}

function dateField(label, name, seconds) {
  let value = "";
  if (seconds) {
    const when = new Date(seconds * 1000);
    value = new Date(when.getTime() - when.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  return field(label, name, value, { type: "datetime-local" });
}

function readDate(data, name) {
  const value = data.get(name);
  return value ? Math.floor(new Date(value).getTime() / 1000) : null;
}

function text(data, name) {
  return String(data.get(name) ?? "").trim();
}

function showEditor(title, fields, onSubmit, { action = "保存", danger = false } = {}) {
  const editor = byId("editor");
  if (editor.open) editor.close();
  byId("editor-title").textContent = title;
  byId("editor-fields").replaceChildren(...fields);
  byId("editor-error").hidden = true;
  byId("editor-cancel").textContent = onSubmit ? "取消" : "完成";
  const submit = byId("editor-submit");
  submit.textContent = action;
  submit.hidden = !onSubmit;
  submit.classList.toggle("danger", danger);
  submit.classList.toggle("primary", !danger);
  editorSubmit = onSubmit;
  editorProductId = state.product.id;
  editor.showModal();
}

async function save(endpoint, body) {
  return api(`/admin/api/${endpoint}`, { body: { productId: editorProductId, ...body } });
}

function accountName(id) {
  return state.accounts.find(account => account.id === id)?.label || id || "—";
}

function deviceGroups() {
  return [...new Set(state.devices.map(device => device.group).filter(Boolean))].sort();
}

function receiptStatus(device) {
  if (!device.receiptStatus) return status("待下发", "warn");
  if (device.receiptRevision != null && device.receiptRevision < state.product.revision) {
    return el("div", {}, status("新策略待确认", "warn"), el("span", { class: "quiet" }, `上次：${receiptNames[device.receiptStatus] || device.receiptStatus}`));
  }
  const code = device.receiptStatus;
  const tone = code === "effective" ? "good" : code === "failed" ? "bad" : "warn";
  return status(receiptNames[code] || code, tone);
}

function deviceLabel(device) {
  return el("span", { class: "mono wrap", title: device.installationId }, device.installationId);
}

function hostedReceipts() {
  const labels = { effective: "策略已应用", blocked: "请求／任务已拦截", draining: "正在收尾", failed: "执行失败" };
  const components = { http_session: "设备会话", http_api: "业务 API", content_worker: "本机内容 Worker", ordinary_worker: "普通后台 Worker", legacy: "未区分组件的历史记录" };
  const reasons = { device_disabled: "设备已停用", account_disabled: "账号已停用", product_disabled: "产品已停用",
    maintenance: "维护期间暂停操作", entitlement_expired: "账号授权已到期", update_required: "需要升级",
    feature_disabled: "功能已关闭", policy_denied: "策略限制访问" };
  const receipts = state.hostedReceipts || [];
  const pages = Math.ceil(receipts.length / 20);
  receiptPage = Math.min(receiptPage, Math.max(0, pages - 1));
  const rows = receipts.slice(receiptPage * 20, (receiptPage + 1) * 20).map(receipt => [
    accountName(receipt.accountId),
    receipt.scope === "account" ? "账号后台任务" : el("span", { class: "mono wrap" }, receipt.installationId),
    components[receipt.component] || "未知组件",
    `${receipt.desktopVersion || "—"} / ${receipt.backendVersion}`,
    el("div", {}, status(labels[receipt.status] || receipt.status, receipt.status === "failed" ? "bad" : ""),
      el("span", { class: "quiet" }, receipt.current ? "近期已确认" : "历史回执")),
    String(receipt.revision), date(receipt.at), reasons[receipt.code]
      ? el("div", {}, reasons[receipt.code], el("span", { class: "quiet mono" }, receipt.code)) : receipt.code || "—",
  ]);
  return card("服务器工作台执行回执", [
    el("p", { class: "quiet" }, "每个执行组件显示最近一次策略回执。请按设备标识、组件、策略版本和回执时间分别核对；任务完成和桌面升级结果需在对应记录中查看。"),
    dataTable("服务器工作台执行回执", ["账号", "执行范围", "执行组件", "桌面 / 服务端版本", "执行状态", "策略版本", "回执时间", "原因／结果代码"],
      rows, "尚未收到服务器工作台执行回执。"),
    pages > 1 && el("div", { class: "actions" },
      receiptPage > 0 && button("上一页", () => { receiptPage--; render(); }),
      el("span", { class: "quiet" }, `第 ${receiptPage + 1} / ${pages} 页`),
      receiptPage < pages - 1 && button("下一页", () => { receiptPage++; render(); })),
  ]);
}

function overview() {
  const { summary, product, devices } = state;
  const receipts = summary.receipts || {};
  const online = summary.online ?? devices.filter(isOnline).length;
  const stats = [
    ["受管设备", summary.devices, `最近 3 分钟在线 ${online}`],
    ["策略已生效", receipts.effective ?? 0, `当前策略版本 ${product.revision}`],
    ["执行失败", receipts.failed ?? 0, `正在升级 ${receipts.upgrading ?? 0}`],
    ["离线／待确认", receipts.offline ?? 0, `在线待下发 ${receipts.pending ?? 0}`],
  ];
  const versions = Object.entries(summary.versions || {}).map(([kind, counts]) =>
    card(kind === "desktop" ? "桌面版本分布" : "后台版本分布",
      Object.keys(counts).length ? el("ul", { class: "list" },
        Object.entries(counts).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([version, count]) =>
          el("li", {}, el("span", { class: "mono" }, version === "unknown" ? "未上报" : version), status(`${count} 台`))))
        : el("p", { class: "quiet" }, "暂无版本上报。")));
  const rows = [...devices].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)).slice(0, 8)
    .map(device => [deviceLabel(device), accountName(device.accountId), date(device.lastSeenAt), receiptStatus(device)]);
  const productPolicy = state.policies.find(policy => policy.scope === "product");
  const notices = [];
  if (productPolicy?.disabled) notices.push(el("p", { class: "notice danger" }, "已发布全产品停用策略。设备执行后会回执。"));
  if (summary.maintenance) notices.push(el("p", { class: "notice warning" }, "全产品维护时段已开始。实际执行情况见设备回执。"));
  const upgrades = summary.upgrades && card("升级结果", el("ul", { class: "upgrade-results" },
    [["成功", "succeeded"], ["失败", "failed"], ["正在升级", "upgrading"], ["待完成", "pending"]].map(([label, key]) =>
      el("li", {}, el("span", { class: "quiet" }, label), el("strong", {}, String(summary.upgrades[key] ?? 0))))));
  return [notices, el("div", { class: "stats" }, stats.map(([name, value, hint]) =>
    el("article", { class: "stat" }, el("p", { class: "quiet" }, name), el("strong", {}, String(value ?? 0)), el("p", { class: "quiet" }, hint)))),
    upgrades, el("div", { class: "split" }, versions),
    card("最近连接", dataTable("最近连接", ["设备", "账号", "最近在线", "策略回执"], rows, "还没有受管设备连接。"),
      button("查看全部设备", () => navigate("devices")), true), hostedReceipts()];
}

function editAccount(account) {
  showEditor(account ? `编辑授权 · ${account.label}` : "新增授权账号", [
    field("账号名称", "label", account?.label, { required: true, maxlength: 100 }),
    ...(account?.username ? [el("p", { class: "quiet" }, `登录账号：${account.username}。${account.approval === "pending" ? "勾选批准并启用后，用户才可登录使用。" : "登录名由用户注册时确定。"}`)] : []),
    check(account?.approval === "pending" ? "批准注册并启用账号" : "账号启用", "enabled", account?.enabled !== false),
    dateField("授权到期（留空为长期）", "expiresAt", account?.expiresAt),
    field("设备上限", "deviceLimit", account?.deviceLimit ?? 1, { type: "number", min: 1, max: 1000, required: true }),
    features(account?.features), reason(),
  ], async data => {
    await save("accounts", {
      id: account?.id, label: text(data, "label"), enabled: data.has("enabled"),
      expiresAt: readDate(data, "expiresAt"), deviceLimit: Number(data.get("deviceLimit")), features: readFeatures(data), reason: text(data, "reason"),
    });
  });
}

function availableAccounts() {
  return state.accounts.filter(account => account.enabled && (!account.expiresAt || account.expiresAt > Date.now() / 1000));
}

function issueActivation(account, device) {
  const candidates = device ? availableAccounts() : [];
  if (device && !candidates.length) {
    notify("先启用一个有效的授权账号。", "error");
    return;
  }
  const label = device ? "签发重新绑定码" : `签发激活码 · ${account.label}`;
  const scope = device ? [
    el("p", { class: "mono wrap" }, device.installationId),
    selectField("绑定账号", "accountId", candidates.map(item => [item.id, item.label]),
      (candidates.find(item => item.id === device.accountId) || candidates[0]).id),
  ] : [];
  showEditor(label, [
    ...scope,
    el("p", { class: "quiet" }, "客户端输入此码完成设备绑定。签发后请通过安全渠道交给对应账号。"), reason(),
  ], async data => {
    const result = await save("activation", {
      accountId: device ? text(data, "accountId") : account.id,
      installationId: device?.installationId, reason: text(data, "reason"),
    });
    return () => {
      const code = el("input", { readonly: true, "aria-label": "一次性激活码", class: "mono" });
      code.value = result.code;
      showEditor("一次性激活码", [
        code, el("p", { class: "quiet" }, `有效至 ${date(result.expiresAt)}。`),
        button("复制激活码", async () => {
          try { await navigator.clipboard.writeText(result.code); } catch { code.select(); }
        }),
      ], null);
      code.focus();
      code.select();
    };
  }, { action: "签发" });
}

function accounts() {
  const rows = state.accounts.map(account => {
    const count = state.devices.filter(device => device.accountId === account.id && !device.revoked).length;
    const expired = account.expiresAt && account.expiresAt <= Date.now() / 1000;
    return [
      el("div", {}, el("strong", {}, account.label), account.username && el("span", { class: "quiet" }, `登录账号：${account.username}`),
        el("span", { class: "quiet mono" }, account.id)),
      account.approval === "pending" ? status("待审核", "warn")
        : account.enabled ? expired ? status("已到期", "warn") : status("已启用", "good") : status("已停用", "bad"),
      date(account.expiresAt, "长期"), `${count} / ${account.deviceLimit}`, featureText(account.features),
      el("div", { class: "actions" }, button(account.approval === "pending" ? "审核注册" : "编辑授权", () => editAccount(account), "small"),
        account.enabled && !expired && button("签发激活码", () => issueActivation(account), "small")),
    ];
  });
  return card("授权账号", dataTable("授权账号", ["账号", "状态", "授权期限", "已绑定／上限", "关闭功能", "操作"], rows, "用户在客户端注册后会显示在这里，审核通过后才能使用。也可手动新增授权账号。"),
    button("新增账号", () => editAccount(), "primary"), true);
}

function editDevice(device) {
  showEditor(`编辑设备 · ${accountName(device.accountId)}`, [
    el("p", { class: "mono wrap" }, device.installationId),
    check("设备启用", "enabled", device.enabled),
    field("设备组（字母、数字、下划线或连字符）", "group", device.group, { maxlength: 48, pattern: "[A-Za-z0-9_\\-]*", list: "group-options" }),
    el("datalist", { id: "group-options" }, deviceGroups().map(group => el("option", { value: group }))),
    reason(),
  ], async data => {
    await save("devices", { installationId: device.installationId, enabled: data.has("enabled"), group: text(data, "group"), reason: text(data, "reason") });
  });
}

function unbindDevice(device) {
  showEditor(`解除绑定 · ${accountName(device.accountId)}`, [
    el("p", { class: "mono wrap" }, device.installationId),
    el("p", { class: "notice warning" }, "此设备的绑定会被撤销并释放一个名额。再次绑定需要有效激活码。"), reason(),
  ], async data => {
    await save("devices", { installationId: device.installationId, enabled: false, group: device.group || "", unbind: true, reason: text(data, "reason") });
  }, { action: "解除绑定", danger: true });
}

function deviceTable() {
  const filter = deviceQuery.trim().toLowerCase();
  const canRebind = availableAccounts().length > 0;
  const rows = state.devices.filter(device => !filter ||
    [device.installationId, accountName(device.accountId), device.group].some(value => String(value || "").toLowerCase().includes(filter)))
    .map(device => [
      el("div", {}, deviceLabel(device), el("span", { class: "quiet" }, `${accountName(device.accountId)} · ${device.group || "未分组"}`)),
      el("div", {}, device.revoked ? status("已解除绑定", "bad") : device.enabled ? status("启用", "good") : status("停用", "bad"),
        el("span", { class: "quiet" }, `${isOnline(device) ? "在线" : "离线"} · ${date(device.lastSeenAt, "未连接")}`)),
      device.desktopVersion || "未上报", device.backendVersion || "未上报",
      el("div", {}, receiptStatus(device),
        device.receiptRevision != null && el("span", { class: "quiet" }, `策略 ${device.receiptRevision} · ${date(device.receiptAt)}`),
        device.receiptCode && el("span", { class: "quiet mono wrap" }, device.receiptCode)),
      device.revoked ? canRebind && button("重新绑定", () => issueActivation(null, device), "small")
        : el("div", { class: "actions" }, button("编辑", () => editDevice(device), "small"),
          button("解除绑定", () => unbindDevice(device), "small danger")),
    ]);
  return dataTable("设备", ["设备／账号", "连接与绑定", "桌面版本", "后台版本", "策略执行", "操作"], rows,
    filter ? "未找到匹配设备。" : "还没有设备注册。");
}

function devices() {
  const filter = el("input", { class: "search", type: "search", placeholder: "设备、账号或分组", "aria-label": "筛选设备" });
  filter.value = deviceQuery;
  const body = el("div", {}, deviceTable());
  filter.addEventListener("input", () => {
    deviceQuery = filter.value;
    body.replaceChildren(deviceTable());
  });
  return card("受管设备", body, filter, true);
}

function policyTarget(policy) {
  if (policy.scope === "account") return accountName(policy.scopeId);
  if (policy.scope === "product") return state.product.name;
  return policy.scopeId;
}

function targets(scope) {
  if (scope === "account") return state.accounts.map(account => [account.id, account.label]);
  if (scope === "device") return state.devices.filter(device => !device.revoked)
    .map(device => [device.installationId, `${accountName(device.accountId)} · ${device.installationId}`]);
  if (scope === "group") return deviceGroups().map(group => [group, group]);
  return [];
}

function affectedDevices(scope, scopeId) {
  const selected = state.devices.filter(device => !device.revoked);
  if (scope === "account") return selected.filter(device => device.accountId === scopeId);
  if (scope === "device") return selected.filter(device => device.installationId === scopeId);
  if (scope === "group") return selected.filter(device => device.group === scopeId);
  return selected;
}

function editPolicy(initial) {
  const scopeField = selectField("作用范围", "scope", Object.entries(scopeNames), initial?.scope || "product");
  const scope = scopeField.querySelector("select");
  const targetField = selectField("目标", "scopeId", [], "");
  const target = targetField.querySelector("select");
  const settings = el("div", { class: "form-grid" });
  const preview = el("p", { class: "notice warning", role: "status" });

  function updateSettings() {
    const current = state.policies.find(item => item.scope === scope.value && item.scopeId === target.value);
    const affected = affectedDevices(scope.value, target.value);
    preview.textContent = `影响范围 ${affected.length} 台已绑定设备，${affected.filter(isOnline).length} 台近期在线。`;
    const confirmStop = check("我已核对全产品停用的影响范围", "confirmStop", false);
    const stop = check("停用此范围", "disabled", Boolean(current?.disabled));
    const stopInput = stop.querySelector("input");
    const confirmInput = confirmStop.querySelector("input");
    function syncConfirmation() {
      const required = scope.value === "product" && stopInput.checked && !current?.disabled;
      confirmStop.hidden = !required;
      confirmInput.required = required;
    }
    stopInput.addEventListener("change", syncConfirmation);
    syncConfirmation();
    settings.replaceChildren(
      stop, confirmStop,
      check("启用维护", "maintenance", Boolean(current?.maintenance)),
      dateField("维护开始（留空立即开始）", "startAt", current?.startAt),
      dateField("预计结束（留空手动解除）", "endAt", current?.endAt),
      area("维护公告", "message", current?.message, { maxlength: 500 }),
      features(current?.features),
    );
  }

  function updateTarget(value) {
    const selectTarget = scope.value !== "product";
    targetField.hidden = !selectTarget;
    target.required = selectTarget;
    const values = targets(scope.value);
    target.replaceChildren(el("option", { value: "" }, selectTarget ? "请选择目标" : "整个产品"),
      ...values.map(([id, label]) => el("option", { value: id }, label)));
    target.value = values.some(([id]) => id === value) ? value : "";
    updateSettings();
  }

  scope.addEventListener("change", () => updateTarget(""));
  target.addEventListener("change", updateSettings);
  updateTarget(initial?.scopeId);
  showEditor("设置管理策略", [scopeField, targetField, preview, settings, reason()], async data => {
    await save("policy", {
      scope: text(data, "scope"), scopeId: text(data, "scopeId"), disabled: data.has("disabled"),
      maintenance: data.has("maintenance"), startAt: readDate(data, "startAt"), endAt: readDate(data, "endAt"),
      message: text(data, "message"), features: readFeatures(data), reason: text(data, "reason"),
    });
  }, { action: "发布策略" });
}

function policies() {
  const now = Date.now() / 1000;
  const rows = state.policies.map(policy => {
    const current = policy.maintenance && (!policy.startAt || policy.startAt <= now) && (!policy.endAt || policy.endAt > now);
    const scheduled = policy.maintenance && policy.startAt > now;
    const maintenance = current ? status("维护中", "warn") : scheduled ? status("待开始", "warn") : status("未维护");
    return [
      el("div", {}, el("strong", {}, scopeNames[policy.scope] || policy.scope), el("span", { class: "quiet wrap" }, policyTarget(policy))),
      policy.disabled ? status("已停用", "bad") : status("允许", "good"),
      el("div", {}, maintenance, policy.maintenance && el("span", { class: "quiet" }, `${date(policy.startAt, "立即")} 至 ${date(policy.endAt, "手动解除")}`)),
      el("span", { class: "wrap" }, policy.message || "—"), featureText(policy.features),
      button("编辑", () => editPolicy(policy), "small"),
    ];
  });
  return card("已发布策略", dataTable("已发布策略", ["范围", "停用", "维护计划", "维护公告", "关闭功能", "操作"], rows,
    "还没有发布管理策略。"), button("设置策略", () => editPolicy(), "primary"), true);
}

function editRelease(release) {
  const group = field("设备组（测试渠道必填）", "group", release?.group, { maxlength: 48, pattern: "[A-Za-z0-9_\\-]*", list: "release-groups" });
  const channel = selectField("渠道", "channel", [["test", "测试"], ["stable", "稳定"]], release?.channel || "test");
  const channelInput = channel.querySelector("select");
  const groupInput = group.querySelector("input");
  const setGroupRequirement = () => { groupInput.required = channelInput.value === "test"; };
  channelInput.addEventListener("change", setGroupRequirement);
  setGroupRequirement();
  const versionField = (label, name, value, required = false) =>
    field(label, name, value, { pattern: "[0-9]+\\.[0-9]+\\.[0-9]+", required: required || null, maxlength: 24 });
  const version = versionField("目标版本（例如 1.3.0）", "version", release?.version, true);
  if (release) version.querySelector("input").readOnly = true;
  showEditor(release ? `编辑发布 · ${release.version}` : "新增版本发布", [
    version, channel, group,
    el("datalist", { id: "release-groups" }, deviceGroups().map(value => el("option", { value }))),
    field("投放比例（%）", "percent", release?.percent ?? 10, { type: "number", min: 0, max: 100, required: true }),
    versionField("最低桌面版本（可选）", "minimumDesktopVersion", release?.minimumDesktopVersion),
    versionField("最低后台版本（可选）", "minimumBackendVersion", release?.minimumBackendVersion),
    dateField("最低版本生效时间（留空立即生效）", "deadline", release?.deadline),
    check("暂停投放", "paused", release?.paused ?? true),
    area("更新说明", "notes", release?.notes, { maxlength: 3000 }), reason(),
  ], async data => {
    await save("releases", {
      version: text(data, "version"), channel: text(data, "channel"), group: text(data, "group"),
      percent: Number(data.get("percent")), minimumDesktopVersion: text(data, "minimumDesktopVersion") || null,
      minimumBackendVersion: text(data, "minimumBackendVersion") || null, deadline: readDate(data, "deadline"),
      notes: text(data, "notes"), paused: data.has("paused"), reason: text(data, "reason"),
    });
  }, { action: "保存发布" });
}

function releases() {
  const rows = state.releases.map(release => [
    el("div", {}, el("strong", { class: "mono" }, release.version),
      release.notes && el("details", {}, el("summary", {}, "更新说明"), el("pre", {}, release.notes))),
    release.channel === "test" ? status("测试", "warn") : status("稳定", "good"),
    el("div", {}, `${release.percent}%`, el("span", { class: "quiet" }, release.group || "全部分组")),
    el("div", {}, `桌面 ${release.minimumDesktopVersion || "无门槛"}`,
      el("span", { class: "quiet" }, `后台 ${release.minimumBackendVersion || "无门槛"}`),
      release.deadline && el("span", { class: "quiet" }, `生效 ${date(release.deadline)}`)),
    el("div", {}, release.paused ? status("已暂停", "warn") : status("投放中", "good"),
      el("span", { class: "quiet" }, release.verifiedAt ? `资源核验 ${date(release.verifiedAt)}` : "资源待核验")),
    button("编辑", () => editRelease(release), "small"),
  ]);
  return [
    el("p", { class: "notice" }, "发布服务会核验 Windows 安装包、更新元数据、发行清单和后台镜像。设备仍会根据分组和投放比例领取升级建议。"),
    card("版本与投放", dataTable("版本与投放", ["目标版本", "渠道", "投放范围", "最低版本", "状态", "操作"], rows,
      "还没有版本发布记录。"), button("新增发布", () => editRelease(), "primary"), true),
  ];
}

function auditDetail(before, after) {
  if (before == null && after == null) return "—";
  return el("details", {}, el("summary", {}, "查看变更"),
    before != null && el("div", {}, el("span", { class: "quiet" }, "变更前"), el("pre", {}, JSON.stringify(before, null, 2))),
    after != null && el("div", {}, el("span", { class: "quiet" }, "变更后"), el("pre", {}, JSON.stringify(after, null, 2))));
}

function audit() {
  const rows = state.audit.map(entry => [
    date(entry.at), entry.actor || "—", auditNames[entry.action] || entry.action,
    el("span", { class: "wrap" }, typeof entry.scope === "string" ? entry.scope : JSON.stringify(entry.scope)),
    el("span", { class: "wrap" }, entry.reason || "—"), auditDetail(entry.before, entry.after),
  ]);
  return card("操作与回执", dataTable("操作与回执", ["时间", "执行方", "操作", "范围", "原因", "变更"], rows, "还没有操作或回执。"),
    button("查看客户端回执", () => navigate("devices")), true);
}

const renderPage = { overview, accounts, devices, policies, releases, audit };

function render() {
  const [title, description] = pageInfo[page];
  byId("page-title").textContent = title;
  byId("page-description").textContent = description;
  byId("page-content").replaceChildren(...[renderPage[page]()].flat(Infinity));
  const product = byId("product");
  const nextOptions = state.products.map(item => [item.id, item.name]);
  if (JSON.stringify([...product.options].map(option => [option.value, option.textContent])) !== JSON.stringify(nextOptions)) {
    product.replaceChildren(...nextOptions.map(([id, name]) => el("option", { value: id }, name)));
  }
  product.value = productId;
  for (const item of document.querySelectorAll("nav [data-page]")) {
    if (item.dataset.page === page) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

function navigate(next) {
  if (!Object.hasOwn(renderPage, next) || !state) return;
  page = next;
  history.replaceState(null, "", `#${page}`);
  notify();
  render();
  byId("page-title").focus();
}

byId("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button[type=submit]");
  const failure = byId("login-error");
  const data = new FormData(form);
  submit.disabled = true;
  failure.hidden = true;
  try {
    const result = await api("/admin/login", { body: { username: text(data, "username"), password: data.get("password") } });
    csrf = result?.csrf;
    await load();
  } catch (error) {
    failure.textContent = error.statusCode === 401 ? "管理员账号或密码错误。" : error.message;
    failure.hidden = false;
  } finally {
    form.elements.password.value = "";
    submit.disabled = false;
  }
});

byId("logout").addEventListener("click", async () => {
  byId("logout").disabled = true;
  try {
    await api("/admin/logout", { body: {} });
    readController?.abort();
    productId = null;
    showLogin();
  } catch (error) {
    if (error.statusCode === 401) showLogin();
    else notify(error.message, "error");
  } finally {
    byId("logout").disabled = false;
  }
});

byId("product").addEventListener("change", async event => {
  const previous = state.product.id;
  const product = event.target;
  const content = byId("page-content");
  productId = product.value;
  deviceQuery = "";
  receiptPage = 0;
  notify();
  product.disabled = true;
  content.inert = true;
  content.setAttribute("aria-busy", "true");
  try {
    if (!await load() && state?.product.id === previous && !readController) {
      productId = previous;
      product.value = previous;
    }
  } finally {
    product.disabled = false;
    content.inert = false;
    content.removeAttribute("aria-busy");
  }
});
byId("refresh").addEventListener("click", () => { void load({ feedback: true }); });
for (const item of document.querySelectorAll("nav [data-page]")) item.addEventListener("click", () => navigate(item.dataset.page));

const editor = byId("editor");
const closeEditor = () => { if (!submitting) editor.close(); };
byId("editor-close").addEventListener("click", closeEditor);
byId("editor-cancel").addEventListener("click", closeEditor);
editor.addEventListener("cancel", event => { if (submitting) event.preventDefault(); });
editor.addEventListener("close", () => {
  if (!editor.open) {
    byId("editor-fields").replaceChildren();
    editorSubmit = null;
    editorProductId = null;
  }
});
byId("editor-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (submitting || !editorSubmit) return;
  const data = new FormData(event.currentTarget);
  const submit = byId("editor-submit");
  const failure = byId("editor-error");
  const label = submit.textContent;
  submitting = true;
  failure.hidden = true;
  submit.disabled = true;
  submit.textContent = "提交中…";
  try {
    const next = await editorSubmit(data);
    editor.close();
    if (await load()) notify("已保存。");
    if (state) next?.();
  } catch (error) {
    if (error.statusCode === 401) showLogin();
    else {
      failure.textContent = error.message || "操作失败。";
      failure.hidden = false;
    }
  } finally {
    submitting = false;
    submit.disabled = false;
    if (submit.textContent === "提交中…") submit.textContent = label;
  }
});

void load();
setInterval(() => {
  if (state && !editor.open && !readController && !document.hidden && document.activeElement?.type !== "search") void load();
}, 30000);
