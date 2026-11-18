import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { actionEvidenceRevision, collectActionEvidence, getActionEvidence, limitActionEvidence } from "./action-evidence";
import { actionScopes } from "./action-scope";

const now = new Date("2026-11-18T18:12:00Z");
const site = { id: "paper", domain: "paper.test" };
const property = "sc-domain:paper.test";
let fixture: TestDb;
beforeAll(async () => {
  fixture = await createTestDb();
  await fixture.db.user.create({ data: { id: "owner", email: "owner@example.test" } });
  await fixture.db.site.create({ data: { ...site, userId: "owner", gscProperty: property, bingSite: "https://paper.test/" } });
});
afterAll(async () => fixture?.close());

describe("report action evidence", () => {
  it("keeps reviewable source prefixes within the old desktop worker's escaped prompt limit", () => {
    const sources = ["audit", "gsc", "performance"];
    const escaped = '"\\'.repeat(180);
    const sections = sources.map(source => ({ source, rows: Array.from({ length: 15 }, (_, i) => ({ id: i, sample: escaped })) }));
    const limited = limitActionEvidence({ site, scope: "weekly", hasData: true, sections,
      period: { start: "", end: "", previousStart: "", previousEnd: "" } });
    expect(limited).toMatchObject({ truncated: true });
    expect(JSON.stringify(JSON.stringify(limited)).length).toBeLessThanOrEqual(18_000);
    for (const [i, section] of limited.sections.entries()) {
      expect(section.rows.length).toBeGreaterThan(0);
      expect(section.rows).toEqual(sections[i].rows.slice(0, section.rows.length));
    }
  });
  it("requires the owner, has empty sections for missing evidence, and never queues a generation from a preview", async () => {
    const { db } = fixture;
    await expect(getActionEvidence(db, undefined, site.id, "weekly", now)).rejects.toMatchObject({ status: 401 });
    await expect(getActionEvidence(db, "another", site.id, "geo", now)).rejects.toMatchObject({ status: 404 });
    for (const scope of actionScopes) {
      const evidence = await getActionEvidence(db, "owner", site.id, scope, now);
      expect(evidence.site).toEqual(site);
      expect(evidence.hasData).toBe(false);
      expect(evidence.sections.every(s => !s.rows.length)).toBe(true);
    }
    expect(await db.aiWorkbenchJob.count()).toBe(0);
  });

  it("binds GSC to the current property and labels missing, measured zero, partial weeks and Bing's distinct weekly bucket", async () => {
    const { db } = fixture;
    const date = new Date("2026-11-13");
    await db.gscSyncCoverage.createMany({ data: [
      { siteId: site.id, gscProperty: property, date, pagesComplete: true, propertyChecked: true, propertyClicks: 0, propertyImpressions: 14 },
      { siteId: site.id, gscProperty: "sc-domain:former.test", date: new Date("2026-11-12"), propertyChecked: true, pagesComplete: true, propertyClicks: 100 },
    ] });
    await db.page.createMany({ data: [
      { siteId: site.id, url: "https://paper.test/guide", date, impressions: 10, clicks: 0 },
      { siteId: site.id, url: "https://paper.test/old", date: new Date("2026-11-12"), impressions: 100, clicks: 72 },
      { siteId: site.id, url: "https://paper.test/share?private=token", date, impressions: 5 },
    ] });
    await db.bingDaily.createMany({ data: [
      { siteId: site.id, date, clicks: null, impressions: 0, inIndex: 4 },
      { siteId: site.id, date: new Date("2026-11-06"), clicks: 1, impressions: 2 },
    ] });
    await db.bingSearchWeekly.create({ data: { siteId: site.id, weekEnding: date, kind: "page", key: "https://paper.test/bing", clicks: 5, impressions: 50 } });
    const period = { start: "2026-11-09", end: "2026-11-15", previousStart: "2026-11-02", previousEnd: "2026-11-08" };
    const preview = await getActionEvidence(db, "owner", site.id, "weekly", now);
    expect(preview.period).toEqual(period);
    const sources = Object.fromEntries(preview.sections.map(s => [s.source, s.rows]));
    expect(sources.gsc).toHaveLength(2);
    expect(sources.gsc[0]).toMatchObject({ clickDays: 1, impressionDays: 1, expectedDays: 7, observedClicks: 0, observedImpressions: 14 });
    expect(sources.gsc[1]).toMatchObject({ kind: "topPage", url: "https://paper.test/guide", coveredDays: 1 });
    expect(sources.bing[0]).toMatchObject({ start: period.previousStart, observedClicks: 1 });
    expect(sources.bing[1]).toMatchObject({ start: period.start, observedClicks: null, clickDays: 0, observedImpressions: 0 });
    expect(sources.bing[3]).toMatchObject({ kind: "topPage", start: "2026-11-07", end: "2026-11-13" });
    const anotherRead = await db.$transaction(tx => collectActionEvidence(tx, site, "weekly", new Date(now.getTime() + 30000)));
    expect(actionEvidenceRevision(anotherRead)).toBe(preview.revision);
    await db.bingDaily.update({ where: { siteId_date: { siteId: site.id, date } }, data: { clicks: 0 } });
    expect((await getActionEvidence(db, "owner", site.id, "weekly", now)).revision).not.toBe(preview.revision);
    await db.gscSyncCoverage.update({ where: { siteId_date: { siteId: site.id, date } }, data: { propertyChecked: false } });
    const legacy = (await getActionEvidence(db, "owner", site.id, "weekly", now)).sections[0].rows;
    expect(legacy[0]).toMatchObject({ kind: "pageRowsTraffic", clickDays: 1, observedClicks: 0, observedImpressions: 15 });
  });

  it("keeps query-only citation detail separate from totals, referral traffic, user-agent probes and crawler observations", async () => {
    const { db } = fixture;
    await db.geoSnapshot.createMany({ data: [
      { siteId: site.id, kind: "BING_AI", updatedAt: now, report: { daily: [], queries: [{ query: "wine cellar", value: 14 }] } },
      { siteId: site.id, kind: "GA4", updatedAt: now, report: { start: "2026-10-01", end: "2026-10-31", rows: [{ platform: "ChatGPT", count: 3 }] } },
      { siteId: site.id, kind: "BOT", updatedAt: now, report: { start: "2026-11-12", end: "2026-11-13", rows: [{ platform: "GPTBot", count: 2 }] } },
      { siteId: site.id, kind: "PROBE", updatedAt: now, report: { checks: [{ token: "GPTBot", url: "https://paper.test/", verdict: "OK", status: 200 }] } },
    ] });
    const prompt = await db.geoPrompt.create({ data: { siteId: site.id, text: "What is a wine cellar?" } });
    await db.geoAnswer.create({ data: { siteId: site.id, promptId: prompt.id, platform: "chatgpt", source: "MANUAL", status: "OK",
      citations: [{ url: "https://paper.test/guide" }], text: "private-answer-text" } });
    const evidence = await getActionEvidence(db, "owner", site.id, "geo", now);
    expect(evidence.sections[0].rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "queryCitations", citations: 14 }),
      expect.objectContaining({ kind: "officialCitations", citations: null }),
      expect.objectContaining({ kind: "accessProbe", verdict: "OK" }),
      expect.objectContaining({ kind: "referralTraffic", referralSessions: 3, end: "2026-10-31" }),
      expect.objectContaining({ kind: "botRequests", crawlerRequests: 2, end: "2026-11-13" }),
      expect.objectContaining({ kind: "answerObservation", siteCited: true, answerSource: "MANUAL" }),
    ]));
    expect(JSON.stringify(evidence)).not.toContain("private-answer-text");
  });

  it("reports recent actual triggers and performance samples without sending alert configuration or older alerts as weekly evidence", async () => {
    const { db } = fixture;
    await db.alert.createMany({ data: [now, new Date("2026-10-01")].map(lastFired => ({ siteId: site.id, userId: "owner",
      type: "NEW_404" as const, channel: "WEBHOOK" as const, config: { endpoint: "fixture-private-endpoint" }, lastFired })) });
    await db.vitalsReport.create({ data: { siteId: site.id, url: "https://paper.test/guide", date: now, device: "MOBILE", lcp: 3.2 } });
    const evidence = await getActionEvidence(db, "owner", site.id, "weekly", now);
    expect(evidence.sections.find(s => s.source === "alerts")?.rows).toHaveLength(1);
    expect(evidence.sections.find(s => s.source === "performance")?.rows[0]).toMatchObject({ device: "MOBILE", lcpSeconds: 3.2, inpMs: null });
    expect(JSON.stringify(evidence)).not.toContain("fixture-private-endpoint");
    expect((await getActionEvidence(db, "owner", site.id, "alerts", now)).sections[0].rows).toHaveLength(2);
  });
});
