import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { ChatGPTConnection } from "./chatgpt-connection";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

describe("account-only keyword connection", () => {
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
