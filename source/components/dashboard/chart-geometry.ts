/*
 * Geometry for the overview's daily chart (traffic-chart.tsx). A day Search
 * Console has not reported is null: it breaks the line and the area, and is
 * never drawn as a zero.
 */

/** A rounded axis top at or above `value`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceMax(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5]) if (step * power >= value) return step * power;
  return 10 * power;
}

/** Runs of reported days, as index ranges, in order. */
function runs(values: readonly (number | null)[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  values.forEach((value, index) => {
    if (value !== null && start < 0) start = index;
    if (value === null && start >= 0) { out.push([start, index - 1]); start = -1; }
  });
  if (start >= 0) out.push([start, values.length - 1]);
  return out;
}

const point = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`;

/** The line through the reported days; each gap starts a new segment. */
export function linePath(values: readonly (number | null)[], x: (index: number) => number, y: (value: number) => number): string {
  return runs(values).map(([from, to]) => {
    const parts: string[] = [];
    for (let index = from; index <= to; index++) parts.push(`${index === from ? "M" : "L"}${point(x(index), y(values[index]!))}`);
    return parts.join(" ");
  }).join(" ");
}

/** The area under each run of reported days, down to `base`. */
export function areaPath(values: readonly (number | null)[], x: (index: number) => number, y: (value: number) => number, base: number): string {
  return runs(values).filter(([from, to]) => to > from).map(([from, to]) => {
    const parts: string[] = [`M${point(x(from), base)}`];
    for (let index = from; index <= to; index++) parts.push(`L${point(x(index), y(values[index]!))}`);
    parts.push(`L${point(x(to), base)}`, "Z");
    return parts.join(" ");
  }).join(" ");
}

/** Indices for the x-axis labels: the first day, then every week, and the last day. */
export function weekTicks(length: number): number[] {
  if (length <= 0) return [];
  const ticks: number[] = [];
  for (let index = 0; index < length - 3; index += 7) ticks.push(index);
  ticks.push(length - 1);
  return ticks;
}

/** The change from `previous` to `current` in percent, or null without a usable baseline. */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}
