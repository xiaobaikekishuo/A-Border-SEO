import { describe, expect, it } from "vitest";
import { decodeReportBytes, parseReportFiles, reportDay, reportNumber, reportUrl } from "./reports";

const gsc = [
  { name: "Dates.csv", text: "\ufeffDate,Impressions\r\n2026-10-02,40\r\n2026-10-01,25\r\n" },
  { name: "Pages.csv", text: "Top pages,Impressions\nhttps://www.kammakhome.com/sofa?utm_source=x,30\nhttps://shop.kammakhome.com/a,10\nhttps://other.test/x,5\n" },
  { name: "Countries.csv", text: "Country,Impressions\nUnited States,50\nCanada,15\n" },
  { name: "Filters.csv", text: "Filter,Value\nSearch type,Web\n" },
];

describe("AI report parsing", () => {
  it("reads numbers, days and the site's URLs as exported", () => {
    expect(reportNumber("1,234")).toBe(1234);
    expect(reportNumber("31%", true)).toBe(0.31);
    expect(reportNumber("0.25", true)).toBe(0.25);
    expect(reportNumber("-3")).toBeNull();
    expect(reportDay("2026/10/04")).toBe("2026-10-04");
    expect(reportDay("10/4/2026")).toBe("2026-10-04");
    expect(reportDay("25/10/2026")).toBe("2026-10-25");
    expect(reportDay("Oct 4, 2026")).toBe("2026-10-04");
    expect(reportDay("2026年10月4日")).toBe("2026-10-04");
    expect(reportDay("2026-02-30")).toBeNull();
    expect(reportUrl("/guide#x", "kammakhome.com")).toBe("https://kammakhome.com/guide");
    expect(reportUrl("https://evil.test/kammakhome.com", "kammakhome.com")).toBeNull();
  });

  it("recognises the Search Console tables by their columns and skips other files", () => {
    const report = parseReportFiles("GSC_AI", gsc, "kammakhome.com");
    expect(report.tables).toEqual(["DAILY", "PAGES", "COUNTRIES"]);
    expect(report.ignored).toEqual(["Filters.csv"]);
    expect(report).toMatchObject({ start: "2026-10-01", end: "2026-10-02", skipped: 1, truncated: 0 });
    expect(report.daily).toEqual([{ day: "2026-10-01", value: 25, pages: null }, { day: "2026-10-02", value: 40, pages: null }]);
    expect(report.pages).toEqual([{ url: "https://www.kammakhome.com/sofa", value: 30 }, { url: "https://shop.kammakhome.com/a", value: 10 }]);
    expect(report.countries[0]).toEqual({ name: "United States", value: 50 });
  });

  it("reads Chinese column names", () => {
    const report = parseReportFiles("GSC_AI", [{ name: "日期.csv", text: "日期,展示\n2026-10-01,7\n" }], "kammakhome.com");
    expect(report.daily).toEqual([{ day: "2026-10-01", value: 7, pages: null }]);
  });

  it("reads the Bing tables with cited pages and citation share", () => {
    const report = parseReportFiles("BING_AI", [
      { name: "daily.csv", text: "Date,Citations,Cited pages\n10/1/2026,12,3\n" },
      { name: "queries.csv", text: "Grounding query,Intent,Topic,Citations,Citation share\nbest sofa,Commercial,Furniture,9,12.5%\n" },
      { name: "pages.csv", text: "URL,Citations\nhttps://kammakhome.com/sofa,9\n" },
    ], "kammakhome.com");
    expect(report.daily).toEqual([{ day: "2026-10-01", value: 12, pages: 3 }]);
    expect(report.queries).toEqual([{ query: "best sofa", value: 9, share: 0.125, intent: "Commercial", topic: "Furniture" }]);
  });

  it("refuses the wrong report, the ordinary performance report and repeated rows", () => {
    expect(() => parseReportFiles("BING_AI", gsc.slice(0, 1), "kammakhome.com")).toThrow("report_wrong_kind");
    expect(() => parseReportFiles("GSC_AI", [{ name: "q.csv", text: "Date,Clicks,Impressions,CTR,Position\n2026-10-01,1,9,11%,4.2\n" }], "kammakhome.com")).toThrow("report_not_ai");
    expect(parseReportFiles("GSC_AI", [{ name: "d.csv", text: "Date,Clicks,Impressions\n2026-10-01,1,9\n" }], "kammakhome.com").daily[0].value).toBe(9);
    expect(() => parseReportFiles("GSC_AI", [gsc[0], gsc[0]], "kammakhome.com")).toThrow("report_duplicate_table");
    expect(() => parseReportFiles("GSC_AI", [{ name: "d.csv", text: "Date,Impressions\n2026-10-01,1\n2026/10/01,2\n" }], "kammakhome.com")).toThrow("report_duplicate_day");
    expect(() => parseReportFiles("GSC_AI", [gsc[3]], "kammakhome.com")).toThrow("report_unrecognised");
    expect(() => parseReportFiles("GSC_AI", [], "kammakhome.com")).toThrow("report_files");
  });

  it("decodes UTF-8 and UTF-16 exports", () => {
    expect(decodeReportBytes(new TextEncoder().encode("日期,展示"))).toBe("日期,展示");
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from("Date").flatMap(c => [c.charCodeAt(0), 0])]);
    expect(decodeReportBytes(utf16)).toBe("Date");
  });
});
