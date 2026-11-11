import { describe, expect, it } from "vitest";
import { headerDirectives, metaDirectives, pageEligibility, summarizeEligibility, type DirectivePage } from "./directives";

const page = (over: Partial<DirectivePage> = {}): DirectivePage => ({
  url: "https://example.com/a", statusCode: 200, robotsMeta: null, robotsMetas: [], xRobotsTag: null, dataNosnippet: false, ...over,
});

describe("robots directives", () => {
  it("scopes X-Robots-Tag lines by crawler and keeps valued directives", () => {
    const lines = ["noarchive", "googlebot: nosnippet, max-snippet: 20", "bingbot: noindex", "unavailable_after: 2027-01-01"];
    expect(headerDirectives(lines, ["googlebot"])).toEqual(["noarchive", "nosnippet", "max-snippet:20", "unavailable_after:2027-01-01"]);
    expect(headerDirectives(lines, ["bingbot", "msnbot"])).toEqual(["noarchive", "noindex", "unavailable_after:2027-01-01"]);
    expect(headerDirectives(["otherbot: noindex"], [])).toEqual([]);
  });

  it("reads the robots meta tag and the tags named for the crawler", () => {
    const metas: [string, string][] = [["robots", "index, follow"], ["GoogleBot", "nosnippet"], ["bingbot", "noarchive"]];
    expect(metaDirectives(metas, ["googlebot"])).toEqual(["index", "follow", "nosnippet"]);
    expect(metaDirectives(metas, ["bingbot", "msnbot"])).toEqual(["index", "follow", "noarchive"]);
  });
});

describe("eligibility by platform rules", () => {
  it("Google: noindex, nosnippet and max-snippet:0 exclude; short snippets and data-nosnippet limit", () => {
    expect(pageEligibility(page(), "GOOGLE")).toEqual({ effect: "OK", reasons: [], complete: true });
    expect(pageEligibility(page({ robotsMetas: [["googlebot", "nosnippet"]] }), "GOOGLE").effect).toBe("EXCLUDED");
    expect(pageEligibility(page({ xRobotsTag: "max-snippet: 0" }), "GOOGLE").reasons).toEqual(["MAX_SNIPPET_ZERO"]);
    expect(pageEligibility(page({ robotsMetas: [["robots", "max-snippet:30"]] }), "GOOGLE")).toMatchObject({ effect: "LIMITED", reasons: ["MAX_SNIPPET_SHORT"] });
    expect(pageEligibility(page({ robotsMetas: [["robots", "max-snippet:-1"]] }), "GOOGLE").effect).toBe("OK");
    expect(pageEligibility(page({ dataNosnippet: true }), "GOOGLE")).toMatchObject({ effect: "LIMITED", reasons: ["DATA_NOSNIPPET"] });
    expect(pageEligibility(page({ robotsMetas: [["robots", "none"]] }), "GOOGLE").reasons).toEqual(["NOINDEX"]);
  });

  it("Bing: noarchive excludes, nocache limits, both together count as nocache", () => {
    expect(pageEligibility(page({ robotsMetas: [["robots", "noarchive"]] }), "BING")).toMatchObject({ effect: "EXCLUDED", reasons: ["NOARCHIVE"] });
    expect(pageEligibility(page({ robotsMetas: [["robots", "nocache"]] }), "BING")).toMatchObject({ effect: "LIMITED", reasons: ["NOCACHE"] });
    expect(pageEligibility(page({ robotsMetas: [["robots", "noarchive, nocache"]] }), "BING")).toMatchObject({ effect: "LIMITED", reasons: ["NOCACHE"] });
    expect(pageEligibility(page({ xRobotsTag: "bingbot: ai-grounding: disallow" }), "BING").reasons).toEqual(["AI_GROUNDING_DISALLOW"]);
    // A Google-only tag does not touch Bing.
    expect(pageEligibility(page({ robotsMetas: [["googlebot", "noindex"]] }), "BING").effect).toBe("OK");
  });

  it("other platforms: noindex is flagged as undocumented, never as excluded", () => {
    expect(pageEligibility(page({ robotsMeta: "noindex", robotsMetas: null }), "GENERIC")).toEqual({ effect: "LIMITED", reasons: ["NOINDEX_UNDOCUMENTED"], complete: true });
  });

  it("marks pages of older crawls as incompletely checked", () => {
    expect(pageEligibility(page({ robotsMetas: null, robotsMeta: "index" }), "GOOGLE").complete).toBe(false);
    expect(pageEligibility(page({ dataNosnippet: null }), "GOOGLE").complete).toBe(false);
    expect(pageEligibility(page({ dataNosnippet: null }), "BING").complete).toBe(true);
  });

  it("summarizes HTTP 200 pages only, with examples", () => {
    const summary = summarizeEligibility([
      page(),
      page({ url: "https://example.com/b", robotsMetas: [["robots", "nosnippet"]] }),
      page({ url: "https://example.com/c", dataNosnippet: true }),
      page({ url: "https://example.com/gone", statusCode: 404, robotsMetas: [["robots", "noindex"]] }),
    ], "GOOGLE");
    expect(summary).toMatchObject({ pages: 3, ok: 1, limited: 1, excluded: 1, complete: true, reasons: { NOSNIPPET: 1, DATA_NOSNIPPET: 1 } });
    expect(summary.examples.map(e => e.url)).toEqual(["https://example.com/b", "https://example.com/c"]);
  });
});
