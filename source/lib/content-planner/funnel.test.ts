import { describe, expect, it } from "vitest";
import { actionSchema } from "./schema";
import { presetFunnelCounts, storedFunnelCounts, validFunnelCounts, matchesFunnelCounts, TOPIC_COUNTS, type FunnelPreset } from "./funnel";
import { buildContentPrompt } from "./prompt";

describe("funnel distribution", () => {
  it("keeps preset totals exact and produces the stated nine-topic presets", () => {
    expect(presetFunnelCounts(9)).toEqual({ TOFU: 3, MOFU: 3, BOFU: 3 });
    expect(presetFunnelCounts(9, "awareness")).toEqual({ TOFU: 5, MOFU: 3, BOFU: 1 });
    expect(presetFunnelCounts(9, "decision")).toEqual({ TOFU: 2, MOFU: 3, BOFU: 4 });
    for (const total of TOPIC_COUNTS) for (const preset of ["balanced", "awareness", "decision"] as FunnelPreset[]) expect(validFunnelCounts(presetFunnelCounts(total, preset), total)).toBe(true);
    expect(() => presetFunnelCounts(4)).toThrow();
  });
  it("accepts a deliberate one-stage plan while rejecting malformed or mismatched requests", () => {
    expect(actionSchema.parse({ action: "startPlan", pillarId: "p", topicCount: 3, funnelCounts: { TOFU: 0, MOFU: 0, BOFU: 3 } })).toMatchObject({ funnelCounts: { TOFU: 0, MOFU: 0, BOFU: 3 } });
    for (const counts of [null, [], { TOFU: 1, MOFU: 1 }, { TOFU: 1, MOFU: 1, BOFU: 1, extra: 0 }, { TOFU: 2, MOFU: 1, BOFU: 1 }, { TOFU: -1, MOFU: 1, BOFU: 3 }, { TOFU: 0.5, MOFU: 0.5, BOFU: 2 }, { TOFU: "1", MOFU: 1, BOFU: 1 }, { TOFU: NaN, MOFU: 1, BOFU: 1 }, { TOFU: 0, MOFU: 0, BOFU: 0 }]) {
      expect(validFunnelCounts(counts, 3)).toBe(false);
      expect(() => actionSchema.parse({ action: "startPlan", pillarId: "p", topicCount: 3, funnelCounts: counts })).toThrow();
    }
  });
  it("retains legacy balanced defaults but does not silently repair invalid saved settings", () => {
    for (const input of [undefined, null, {}]) expect(storedFunnelCounts(input, 6)).toEqual({ TOFU: 2, MOFU: 2, BOFU: 2 });
    expect(actionSchema.parse({ action: "startPlan", pillarId: "p" })).toMatchObject({ topicCount: 9 });
    expect(() => storedFunnelCounts({ funnelCounts: { TOFU: 6, MOFU: 6, BOFU: 6 } }, 6)).toThrow(/Invalid saved/);
    expect(matchesFunnelCounts([{ funnel: "TOFU" }, { funnel: "TOFU" }, { funnel: "BOFU" }], { TOFU: 2, MOFU: 0, BOFU: 1 })).toBe(true);
    expect(matchesFunnelCounts([{ funnel: "TOFU" }, { funnel: "TOFU" }, { funnel: "BOFU" }], { TOFU: 1, MOFU: 1, BOFU: 1 })).toBe(false);
  });
  it("sends the exact editorial mix, including zero stages, without conflating intent and demand", () => {
    const prompt = buildContentPrompt({ domain: "catalog.example", topicCount: 3, funnelCounts: { TOFU: 0, MOFU: 1, BOFU: 2 }, pillar: { title: "Guide", keyword: "cup", description: "", audience: "", goal: "", url: null }, existingTopics: [], knownPages: [], searchEvidence: [], metricsPeriod: null, allowedInternalLinks: [] });
    expect(prompt).toContain("TOFU 0, MOFU 1, BOFU 2");
    expect(prompt).toContain("stage set to zero must have no topics");
    expect(prompt).toContain("Keep search intent as a separate field");
    expect(prompt).toContain("not evidence of demand or a guarantee of traffic");
    expect(prompt).not.toContain("equal counts");
  });
});
