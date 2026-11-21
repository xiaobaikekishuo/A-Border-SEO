import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generationSchemaFor, workbenchRequestSchema, workbenchResultSchema, type WorkbenchResult } from "../schema";
import { displayUnits, fitSample, fitsWorkerClaim, isPanelKind, isToolKind, TOOL_KINDS, urlsIn } from "./common";
import { assertToolFields, assertToolRequest } from "./index";

const base: WorkbenchResult = { title: "t", summary: "s", contentMarkdown: "c", metaTitle: "", metaDescription: "", changeNotes: [], factChecks: ["review"], internalLinks: [], paragraphEdits: [] };
const thrown = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as Error).message; } return null; };

describe("structured task basics", () => {
  it("counts wide characters twice", () => {
    expect(displayUnits("Apple ID")).toBe(8);
    expect(displayUnits("苹果账号")).toBe(8);
    expect(displayUnits("Apple ID 苹果")).toBe(13);
    expect(displayUnits("ｱｲ")).toBe(2);
  });

  it("finds bare URLs without trailing punctuation", () => {
    expect(urlsIn("See https://a.test/x, and www.b.test/y. 网址https://c.test/z。")).toEqual(["https://a.test/x", "www.b.test/y", "https://c.test/z"]);
  });

  it("fits a sample into a worker claim, largest first", () => {
    const schema = { type: "object" };
    expect(fitsWorkerClaim("x".repeat(1000), schema)).toBe(true);
    expect(fitsWorkerClaim("x".repeat(70000), schema)).toBe(false);
    // Quotes are escaped on the wire: 40,000 quotes take 80,000 characters.
    expect(fitsWorkerClaim("\"".repeat(40000), schema)).toBe(false);
    const sample = fitSample(100, 1, rows => "y".repeat(rows * 1000), text => text, schema);
    expect(sample.length).toBeLessThanOrEqual(65000);
    expect(sample.length).toBeGreaterThanOrEqual(63000);
    expect(thrown(() => fitSample(5, 2, rows => "y".repeat(70000 + rows), text => text, schema))).toBe("tool_context_too_large");
  });

  it("lists panel and tool kinds", () => {
    expect(TOOL_KINDS).toEqual(["META_REWRITE", "LOCALIZE_ARTICLE", "SCHEMA_MARKUP", "OUTREACH_EMAILS", "QUERY_CLUSTERS", "TOPIC_BRIEF"]);
    expect(isToolKind("SCHEMA_MARKUP")).toBe(true);
    expect(isToolKind("WRITE_ARTICLE")).toBe(false);
    expect(isPanelKind("META_REWRITE")).toBe(true);
    expect(isPanelKind("LOCALIZE_ARTICLE")).toBe(false);
    expect(isPanelKind("BACKLINK_ANALYSIS")).toBe(true);
  });

  it("gives each structured task an output schema whose fields are all required", () => {
    for (const [kind, field] of [["META_REWRITE", "metaRewrites"], ["LOCALIZE_ARTICLE", "localKeywords"], ["SCHEMA_MARKUP", "schemaBlocks"], ["OUTREACH_EMAILS", "outreachEmails"], ["QUERY_CLUSTERS", "queryClusters"], ["TOPIC_BRIEF", "topicBrief"]] as const) {
      const schema = z.toJSONSchema(generationSchemaFor(kind), { target: "draft-7" }) as { properties: Record<string, unknown>; required: string[] };
      expect(schema.required).toContain(field);
      expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
      // Fields the server fills in are never asked of the model.
      expect(schema.required).not.toContain("hreflang");
      expect(schema.required).not.toContain("schemaReview");
      expect(schema.required).not.toContain("clusterReview");
      // Released local workers refuse a schema with references or over 65,536 characters.
      const text = JSON.stringify(schema);
      expect(text).not.toMatch(/"\$ref"\s*:/);
      expect(text.length).toBeLessThan(65536);
    }
    const plain = z.toJSONSchema(generationSchemaFor("WRITE_ARTICLE"), { target: "draft-7" }) as { properties: Record<string, unknown> };
    expect(Object.keys(plain.properties)).not.toContain("metaRewrites");
  });
});

describe("structured task requests", () => {
  const request = (extra: Record<string, unknown>) => workbenchRequestSchema.parse({ kind: "META_REWRITE", title: "Titles", ...extra });
  it("accepts each kind with its own settings", () => {
    expect(thrown(() => assertToolRequest(request({ metaRewrite: { urls: ["https://a.test/x"] } })))).toBeNull();
    expect(thrown(() => assertToolRequest(request({ kind: "SCHEMA_MARKUP", pageId: "page-1" })))).toBeNull();
    expect(thrown(() => assertToolRequest(request({ kind: "LOCALIZE_ARTICLE", pageId: "page-1", localization: { location: 2276 } })))).toBeNull();
    expect(thrown(() => assertToolRequest(request({ kind: "LOCALIZE_ARTICLE", body: "x".repeat(200), localization: { location: 2276 } })))).toBeNull();
    expect(thrown(() => assertToolRequest(request({ kind: "QUERY_CLUSTERS", queryClusters: { limit: 100 } })))).toBeNull();
    expect(thrown(() => assertToolRequest(request({ kind: "OUTREACH_EMAILS", outreach: { taskId: "m1", rows: [0, 2], senderName: "Lee", offer: "Our guide" } })))).toBeNull();
  });
  it("refuses missing settings, settings of another kind and fields that belong elsewhere", () => {
    expect(thrown(() => assertToolRequest(request({})))).toBe("Missing settings for this task");
    expect(thrown(() => assertToolRequest(request({ kind: "SCHEMA_MARKUP" })))).toBe("Choose a crawled page");
    expect(thrown(() => assertToolRequest(request({ kind: "WRITE_ARTICLE", metaRewrite: { urls: ["https://a.test/x"] } })))).toBe("These settings belong to another task type");
    expect(thrown(() => assertToolRequest(request({ metaRewrite: { urls: ["https://a.test/x"] }, body: "pasted" })))).toBe("Pasted text is only used for localization");
    expect(thrown(() => assertToolRequest(request({ metaRewrite: { urls: ["https://a.test/x"] }, pageId: "p" })))).toBe("Invalid settings for this task");
    expect(thrown(() => assertToolRequest(request({ metaRewrite: { urls: ["https://a.test/x"] }, schedule: "WEEKLY" })))).toBe("Invalid settings for this task");
    expect(thrown(() => assertToolRequest(request({ metaRewrite: { urls: ["https://a.test/x"] }, actionScope: "weekly", evidenceRevision: "a".repeat(64) })))).toBe("Invalid settings for this task");
    // Plain tasks pass untouched.
    expect(thrown(() => assertToolRequest(request({ kind: "WRITE_ARTICLE" })))).toBeNull();
  });
  it("keeps the fields of a structured result on its own kind", () => {
    const meta = { ...base, metaRewrites: [{ pageId: "P1", title: "A title", description: "A description", targetQueries: ["q"], reason: "r" }] };
    expect(workbenchResultSchema.safeParse(meta).success).toBe(true);
    expect(thrown(() => assertToolFields("META_REWRITE", meta))).toBeNull();
    expect(thrown(() => assertToolFields("WRITE_ARTICLE", meta))).toBe("The result has fields of another task type");
    expect(thrown(() => assertToolFields("", { ...base, hreflang: { code: "de-DE", sourceUrl: "https://a.test/", sourceCode: null, sourceCodeGuessed: false, targetUrl: null, tags: [], html: "", notes: [] } }))).toBe("The result has fields of another task type");
    expect(thrown(() => assertToolFields("WRITE_ARTICLE", base))).toBeNull();
  });
});
