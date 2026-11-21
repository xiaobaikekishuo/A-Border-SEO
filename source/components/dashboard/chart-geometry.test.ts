import { describe, expect, it } from "vitest";
import { areaPath, linePath, niceMax, percentChange, weekTicks } from "./chart-geometry";

const x = (index: number) => index * 10;
const y = (value: number) => 100 - value;

describe("daily chart geometry", () => {
  it("rounds the axis top up to a readable number", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(1127)).toBe(2000);
    expect(niceMax(2400)).toBe(2500);
    expect(niceMax(4100)).toBe(5000);
    expect(niceMax(5000)).toBe(5000);
    expect(niceMax(0.3)).toBe(0.5);
  });
  it("breaks the line where a day is not reported, never drawing it as zero", () => {
    expect(linePath([10, 20, null, 30, 40], x, y)).toBe("M0.0 90.0 L10.0 80.0 M30.0 70.0 L40.0 60.0");
    expect(linePath([null, null], x, y)).toBe("");
    expect(linePath([5], x, y)).toBe("M0.0 95.0");
  });
  it("fills under each run of two or more reported days", () => {
    expect(areaPath([10, 20, null, 30], x, y, 100)).toBe("M0.0 100.0 L0.0 90.0 L10.0 80.0 L10.0 100.0 Z");
  });
  it("labels the first day, each week and the last day", () => {
    expect(weekTicks(28)).toEqual([0, 7, 14, 21, 27]);
    expect(weekTicks(9)).toEqual([0, 8]);
    expect(weekTicks(1)).toEqual([0]);
    expect(weekTicks(0)).toEqual([]);
  });
  it("compares with the previous period only against a reported, positive baseline", () => {
    expect(percentChange(1127, 990)).toBeCloseTo(13.84, 2);
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(null, 10)).toBeNull();
    expect(percentChange(10, null)).toBeNull();
  });
});
