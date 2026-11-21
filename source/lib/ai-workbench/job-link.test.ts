import { describe, expect, it } from "vitest";
import { jobParam, resultHref, toolAnchor } from "./job-link";

describe("links to a task's result", () => {
  it("open each kind where its result is shown, scrolled to the panel", () => {
    expect(resultHref("site 1", "META_REWRITE", "aw_1")).toBe("/sites/site%201/opportunities?job=aw_1#ai-meta-rewrite");
    expect(resultHref("site-1", "QUERY_CLUSTERS", "aw_2")).toBe("/sites/site-1/content?job=aw_2#ai-query-clusters");
    expect(resultHref("site-1", "OUTREACH_EMAILS", "aw_3")).toBe("/sites/site-1/backlinks?job=aw_3#ai-outreach-emails");
    for (const kind of ["SEO_FIX_PLAN", "SCHEMA_MARKUP", "LOCALIZE_ARTICLE", "TOPIC_BRIEF"]) expect(resultHref("site-1", kind, "aw_4")).toBe("/sites/site-1/assistant?job=aw_4#workbench-results");
    expect(toolAnchor("OUTREACH_EMAILS")).toBe("ai-outreach-emails");
  });
  it("take only a plain task id from the address", () => {
    expect(jobParam("aw_0f8c2d1e-aaaa-4bbb-8ccc-123456789abc")).toBe("aw_0f8c2d1e-aaaa-4bbb-8ccc-123456789abc");
    for (const value of [undefined, null, "", ["aw_1"], "aw_1&x=2", "../x", "x".repeat(201)]) expect(jobParam(value)).toBeUndefined();
  });
});
