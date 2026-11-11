import { describe, expect, it } from "vitest";
import { formatDay } from "./format";

describe("localized UTC dates", () => {
  it("keeps Search Console calendar days consistent in both languages", () => {
    expect(formatDay("2026-11-05", { locale: "zh" })).toBe("11月5日");
    expect(formatDay("2026-11-05", { locale: "en", year: true })).toBe("5 Nov 2026");
    expect(formatDay("2026-11-05", { locale: "zh", year: true })).toBe("2026年11月5日");
  });
  it("displays timestamps in the same UTC timezone", () => {
    const timestamp = "2026-11-05T01:02:00+08:00";
    expect(formatDay(timestamp, { locale: "zh", time: true })).toBe("11月4日 17:02 UTC");
    expect(formatDay(timestamp, { locale: "en", time: true })).toBe("4 Nov 17:02 UTC");
  });
  it("handles invalid dates without exposing undefined month names", () => {
    expect(formatDay("invalid", { locale: "zh" })).toBe("日期无效");
    expect(formatDay("invalid", { locale: "en" })).toBe("Invalid date");
  });
});
