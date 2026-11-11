export type PageSpeedErrorCode = "QUOTA_EXCEEDED" | "SERVICE_DISABLED" | "API_KEY_SERVICE_BLOCKED" | "API_KEY_INVALID" | "PERMISSION_DENIED" | "REQUEST_FAILED";
export function classifyPageSpeedError(status: number, body: string): PageSpeedErrorCode {
  if (status === 429 || /RESOURCE_EXHAUSTED|quota exceeded|dailyLimitExceeded|rateLimitExceeded/i.test(body)) return "QUOTA_EXCEEDED";
  if (/API_KEY_SERVICE_BLOCKED|API_KEY_HTTP_REFERRER_BLOCKED|API_KEY_IP_ADDRESS_BLOCKED/i.test(body)) return "API_KEY_SERVICE_BLOCKED";
  if (/SERVICE_DISABLED|accessNotConfigured/i.test(body)) return "SERVICE_DISABLED";
  if (/API_KEY_INVALID|keyInvalid|API key not valid/i.test(body)) return "API_KEY_INVALID";
  if (status === 401 || status === 403) return "PERMISSION_DENIED";
  return "REQUEST_FAILED";
}
const messages: Record<Exclude<PageSpeedErrorCode, "REQUEST_FAILED">, { en: string; zh: string }> = {
  QUOTA_EXCEEDED: { en: "PageSpeed quota exhausted. Check this project's API quotas and wait for the quota reset before retrying.", zh: "PageSpeed 配额已用尽。请检查该项目的 API 配额，等待配额恢复后重试。" },
  SERVICE_DISABLED: { en: "Enable the PageSpeed Insights API in the Google Cloud project that owns this key, then wait a few minutes and retry.", zh: "请在此密钥所属的 Google Cloud 项目中启用 PageSpeed Insights API，等待几分钟后重试。" },
  API_KEY_SERVICE_BLOCKED: { en: "This key's restrictions block PageSpeed. Allow PageSpeed Insights API and check server IP restrictions. Browser referrer restrictions do not work for server requests.", zh: "密钥限制阻止了 PageSpeed。请允许 PageSpeed Insights API，并检查服务器 IP 限制。本地服务端请求不能使用浏览器来源网址限制。" },
  API_KEY_INVALID: { en: "The PageSpeed API key is invalid. Replace it in local Settings > Connections; do not send the key in chat.", zh: "PageSpeed API 密钥无效。请在本机“设置 → 连接”中更换，不要把密钥发到聊天中。" },
  PERMISSION_DENIED: { en: "Google refused this PageSpeed request. Check the key's project, API enablement and restrictions, then retry.", zh: "Google 拒绝了本次 PageSpeed 请求。请检查密钥所属项目、API 启用状态及密钥限制，然后重试。" },
};
export function pageSpeedMessage(code: PageSpeedErrorCode, status: number) {
  return code === "REQUEST_FAILED" ? `PageSpeed Insights request failed (HTTP ${status})` : `[PSI_${code}] ${messages[code].en}`;
}
export function pageSpeedGuidance(message: string, locale: string = "en") {
  const code = (Object.keys(messages).find(key => message.includes(`[PSI_${key}]`)) ?? (/PageSpeed Insights request failed \(HTTP (401|403)\)/.test(message) ? "PERMISSION_DENIED" : undefined)) as Exclude<PageSpeedErrorCode, "REQUEST_FAILED"> | undefined;
  if (!code) return null;
  const href = code === "API_KEY_INVALID" ? "/settings?connect=google_pagespeed#connections"
    : code === "SERVICE_DISABLED" ? "https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com"
    : code === "QUOTA_EXCEEDED" ? "https://console.cloud.google.com/apis/api/pagespeedonline.googleapis.com/quotas"
    : "https://console.cloud.google.com/apis/credentials";
  return { text: messages[code][locale === "zh" ? "zh" : "en"], href };
}
