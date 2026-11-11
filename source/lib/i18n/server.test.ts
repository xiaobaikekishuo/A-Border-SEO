import { beforeEach, describe, expect, it, vi } from "vitest";
const cookieState = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => cookieState.value === undefined ? undefined : { value: cookieState.value } }) }));
import { getI18n } from "./server";

describe("request-scoped locale", () => {
  beforeEach(() => { cookieState.value = undefined; });
  it("renders new visitors in Chinese", async () => {
    const { locale, t } = await getI18n();
    expect(locale).toBe("zh");
    expect(t("Overview", "概览")).toBe("概览");
  });
  it("uses the current request cookie without leaking between requests", async () => {
    cookieState.value = "en";
    expect((await getI18n()).t("Overview", "概览")).toBe("Overview");
    cookieState.value = "zh";
    expect((await getI18n()).t("Overview", "概览")).toBe("概览");
  });
});
