export const FUNNEL_STAGES = ["TOFU", "MOFU", "BOFU"] as const;
export const TOPIC_COUNTS = [3, 6, 9, 12, 15, 18] as const;
export type FunnelCounts = Record<(typeof FUNNEL_STAGES)[number], number>;
export type FunnelPreset = "balanced" | "awareness" | "decision";

export function validFunnelCounts(value: unknown, total: number): value is FunnelCounts {
  if (!TOPIC_COUNTS.includes(total as (typeof TOPIC_COUNTS)[number]) || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && FUNNEL_STAGES.every(stage => Number.isInteger(record[stage]) && (record[stage] as number) >= 0 && (record[stage] as number) <= 18)
    && FUNNEL_STAGES.reduce((sum, stage) => sum + (record[stage] as number), 0) === total;
}

/** Largest-remainder allocation keeps the requested total exact at every size. */
export function presetFunnelCounts(total: number, preset: FunnelPreset = "balanced"): FunnelCounts {
  if (!TOPIC_COUNTS.includes(total as (typeof TOPIC_COUNTS)[number])) throw new Error("Invalid topic count");
  const weights = preset === "awareness" ? [5, 3, 1] : preset === "decision" ? [2, 3, 4] : [3, 3, 3];
  const raw = weights.map(weight => weight * total / 9);
  const counts = raw.map(Math.floor);
  const order = raw.map((value, index) => ({ index, remainder: value - counts[index] })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let remaining = total - counts.reduce((sum, count) => sum + count, 0), i = 0; remaining > 0; remaining--, i++) counts[order[i].index]++;
  return { TOFU: counts[0], MOFU: counts[1], BOFU: counts[2] };
}

/** Legacy jobs have no request JSON and retain their original balanced contract. */
export function storedFunnelCounts(request: unknown, total: number): FunnelCounts {
  if (request === null || request === undefined) return presetFunnelCounts(total);
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid saved funnel distribution");
  const value = (request as Record<string, unknown>).funnelCounts;
  if (value === undefined) return presetFunnelCounts(total);
  if (!validFunnelCounts(value, total)) throw new Error("Invalid saved funnel distribution");
  return { ...value };
}

export function matchesFunnelCounts(topics: { funnel: string }[], counts: FunnelCounts): boolean {
  return topics.length === FUNNEL_STAGES.reduce((sum, stage) => sum + counts[stage], 0)
    && FUNNEL_STAGES.every(stage => topics.filter(topic => topic.funnel === stage).length === counts[stage]);
}
