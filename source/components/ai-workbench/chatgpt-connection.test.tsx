import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { ChatGPTConnection, nativeCodexReady } from "./chatgpt-connection";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

describe("account-only keyword connection", () => {
  it("enables hosted generation only for a verified signed-in running native worker", () => {
    const connected = { hosted: true, available: true, signedIn: true, phase: "running" };
    expect(nativeCodexReady(connected)).toBe(true);
    expect(nativeCodexReady({ ...connected, phase: "working" })).toBe(true);
    for (const phase of ["starting", "waiting_login", "stopped", "failed", "signing_in"]) expect(nativeCodexReady({ ...connected, phase })).toBe(false);
    expect(nativeCodexReady({ ...connected, available: null })).toBe(false);
    expect(nativeCodexReady({ ...connected, signedIn: false })).toBe(false);
    expect(nativeCodexReady(null)).toBe(false);
  });
  it("keeps disconnected research in app mode with plan confirmation and no local fallback", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><ChatGPTConnection siteId="site" disabled={false} onChange={() => {}} appOnly returnPage="keyword-research" /></I18nProvider>);
    expect(html).toContain("关闭达到套餐上限后的额度使用");
    expect(html).toContain('value="CHATGPT_APP" selected=""');
    expect(html).not.toContain('value="CODEX_LOCAL"');
    expect(html).toContain("平台无法验证该开关");
    expect(html).toContain("不会转为 API Key 付费调用");
  });
  it("retains the existing workbench choice of dedicated Codex login", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en"><ChatGPTConnection siteId="site" disabled={false} onChange={() => {}} /></I18nProvider>);
    expect(html).toContain('value="CODEX_LOCAL" selected=""');
    expect(html).toContain('value="CHATGPT_APP"');
  });
});
