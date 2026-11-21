import { describe, expect, it } from "vitest";
import { compareRates, normalCdf, rateInterval, wilsonInterval } from "./stats";

describe("rate ranges", () => {
  it("gives the Wilson interval, which stays inside 0 to 100%", () => {
    expect(wilsonInterval(5, 10)).toEqual({ low: 0.237, high: 0.763 });
    expect(wilsonInterval(0, 10)).toEqual({ low: 0, high: 0.278 });
    expect(wilsonInterval(10, 10)).toEqual({ low: 0.722, high: 1 });
    expect(wilsonInterval(1, 0)).toBeNull();
  });

  it("narrows as prompts are added", () => {
    const few = rateInterval(0.4, 10)!;
    const many = rateInterval(0.4, 100)!;
    expect(few.high - few.low).toBeGreaterThan(many.high - many.low);
    expect(rateInterval(null, 10)).toBeNull();
  });
});

describe("changes between runs", () => {
  it("tells a real change from noise", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    // 30% to 40% over 20 prompts each could easily be chance.
    expect(compareRates({ rate: 0.3, n: 20 }, { rate: 0.4, n: 20 })).toMatchObject({ change: 0.1, significant: false });
    // 20% to 60% over 50 prompts each is not.
    const big = compareRates({ rate: 0.2, n: 50 }, { rate: 0.6, n: 50 })!;
    expect(big.significant).toBe(true);
    expect(big.p).toBeLessThan(0.001);
  });

  it("handles runs without variation or without answers", () => {
    expect(compareRates({ rate: 0, n: 10 }, { rate: 0, n: 12 })).toEqual({ change: 0, p: 1, significant: false });
    expect(compareRates({ rate: null, n: 0 }, { rate: 0.5, n: 10 })).toBeNull();
  });
});
