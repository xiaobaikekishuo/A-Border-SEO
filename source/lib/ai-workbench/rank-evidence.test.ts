import { describe, expect, it } from "vitest";
import { rankingRows, type RankCheckFacts } from "./action-evidence";

const site = { id: "site_1", domain: "shop.test" };
const run = { finishedAt: new Date("2026-11-18T03:00:00.000Z"), device: "desktop", depth: 30, language: "en", location: 2840, failed: 1 };
const top = (domains: string[]) => domains.map((domain, i) => ({ rank: i + 1, domain, url: `https://${domain}/p`, title: domain }));
const check = (keyword: string, position: number | null, previous: number | null, extra: Partial<RankCheckFacts> = {}): RankCheckFacts => ({
  keyword, position, previous, hadPrevious: previous !== null, url: position === null ? null : "https://shop.test/a", previousUrl: previous === null ? null : "https://shop.test/a",
  aiOverview: false, aiCited: false, checkedAt: new Date("2026-11-18T02:00:00.000Z"), top: [], previousTop: [], ...extra,
});

describe("rankings evidence", () => {
  it("describes the run, then the biggest moves first", () => {
    const rows = rankingRows(run, [
      check("steady", 3, 3),
      check("rose", 4, 9),
      check("fell", 12, 5),
      check("gone", null, 8),
      check("moved page", 6, 6, { url: "https://shop.test/b", previousUrl: "https://shop.test/a" }),
      check("new", 20, null, { hadPrevious: true }),
      check("first check", 7, null),
    ], site);
    expect(rows[0]).toEqual({ kind: "rankRun", date: "2026-11-18T03:00:00.000Z", device: "desktop", depth: 30, language: "en", location: "United States", checked: 7, failed: 1 });
    expect(rows.filter(r => r.kind === "rankChange").map(r => r.query)).toEqual(["gone", "fell", "moved page", "new", "rose", "steady", "first check"]);
    expect(rows.find(r => r.query === "fell")).toMatchObject({ position: 12, previousPosition: 5, change: -7, url: "https://shop.test/a" });
    expect(rows.find(r => r.query === "moved page")).toMatchObject({ url: "https://shop.test/b", previousUrl: "https://shop.test/a" });
  });
  it("names sites that moved above a dropped keyword by domain, never by URL, and leaves out our own", () => {
    const rows = rankingRows(run, [check("fell", 6, 2, {
      top: top(["rival.test", "www.shop.test", "blog.shop.test", "new.test", "old.test", "shop.test"]),
      previousTop: top(["shop.test", "old.test", "rival.test"]),
    })], site);
    const entrants = rows.filter(r => r.kind === "serpEntrant");
    expect(entrants).toEqual([
      { kind: "serpEntrant", query: "fell", competitor: "rival.test", position: 1, previousPosition: 3, change: -4 },
      { kind: "serpEntrant", query: "fell", competitor: "new.test", position: 4, previousPosition: null, change: -4 },
    ]);
    expect(entrants.every(r => !("url" in r))).toBe(true);
  });
  it("only links our own public pages", () => {
    const rows = rankingRows(run, [check("x", 3, 9, { url: "https://other.test/a", previousUrl: "https://shop.test/a?session=1" })], site);
    expect(rows[1]).toMatchObject({ url: null, previousUrl: null });
  });
});
