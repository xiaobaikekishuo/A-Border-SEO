import { describe, expect, it } from "vitest";
import { robotsDirectivesOf } from "./engine";

describe("robots directives recorded per page", () => {
  it("keeps the robots-type meta tags, lower-cased, and spots data-nosnippet where Google honours it", () => {
    const metas: [string, string][] = [["robots", "index, follow"], ["GoogleBot", "nosnippet"], ["viewport", "width=device-width"], ["bingbot", "nocache"]];
    expect(robotsDirectivesOf(metas, '<main><div class="x" data-nosnippet>price</div></main>')).toEqual({
      metas: [["robots", "index, follow"], ["googlebot", "nosnippet"], ["bingbot", "nocache"]],
      dataNosnippet: true,
    });
    expect(robotsDirectivesOf([], "<p data-nosnippet>x</p>").dataNosnippet).toBe(false);
    expect(robotsDirectivesOf([], "<span data-nosnippet-like>x</span>").dataNosnippet).toBe(false);
  });

  it("bounds what it keeps", () => {
    const many = Array.from({ length: 20 }, (): [string, string] => ["robots", "x".repeat(900)]);
    const kept = robotsDirectivesOf(many, "").metas;
    expect(kept).toHaveLength(10);
    expect(kept[0][1]).toHaveLength(500);
  });
});
