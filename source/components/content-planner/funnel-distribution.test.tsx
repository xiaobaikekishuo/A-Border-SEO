import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { FunnelDistribution } from "./funnel-distribution";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const noop = () => {};
describe("funnel allocation controls", () => {
  it("shows exact preset counts, percentages and guidance in Chinese", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><FunnelDistribution total={9} counts={{ TOFU: 5, MOFU: 3, BOFU: 1 }} preset="awareness" disabled={false} onTotal={noop} onPreset={noop} onCount={noop} /></I18nProvider>);
    for (const text of ["认知优先", "自定义数量", "55.6%", "33.3%", "11.1%", "已分配 9 / 9", "允许某阶段为 0", "不保证流量或排名"]) expect(html).toContain(text);
    expect(html).not.toContain('role="alert"');
  });
  it("flags a changed total requiring adjustment and supports the English UI", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en"><FunnelDistribution total={6} counts={{ TOFU: 5, MOFU: 3, BOFU: 1 }} preset="custom" disabled={true} onTotal={noop} onPreset={noop} onCount={noop} /></I18nProvider>);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Allocated 9 / 6");
    expect(html).toContain("The three counts must add up");
    expect(html).toContain('<fieldset class="');
    expect(html).toContain('disabled=""');
  });
});
