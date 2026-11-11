import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateWorkbenchResult, buildWorkbenchPrompt } from "./worker";
import { workbenchGenerationSchema, workbenchResultSchema } from "./schema";

const source = "第一段介绍实际支持的功能，清晰解释使用条件。\n\n第二段保留原本可靠的说明，并建议读者核实信息。";
const edit = { id: "intro", sourceText: "第一段介绍实际支持的功能，清晰解释使用条件。", replacementText: "先说明实际支持的功能，再解释使用条件。", reason: "让读者更快理解内容", evidence: ["原文第一段"], verification: ["核对功能描述符合实际"] };
const result = { title: "文章草稿", summary: "供审阅", contentMarkdown: "完整修改提案", metaTitle: "", metaDescription: "", changeNotes: [], factChecks: ["审核后使用"], internalLinks: [] };
const context = { body: source, allowedInternalLinks: ["https://example.com/guide"] };
describe("reviewable paragraph edits", () => {
  it("accepts exact Chinese source excerpts and preserves historical result shapes", () => {
    expect(validateWorkbenchResult(result, "example.com", context)).toEqual(result);
    expect(validateWorkbenchResult({ ...result, paragraphEdits: [edit] }, "example.com", context).paragraphEdits).toEqual([edit]);
  });
  it("requires the new array only in the generation schema", () => {
    expect(workbenchResultSchema.safeParse(result).success).toBe(true);
    expect(workbenchGenerationSchema.safeParse(result).success).toBe(false);
    const schema = z.toJSONSchema(workbenchGenerationSchema, { target: "draft-7" });
    expect(schema.required).toContain("paragraphEdits");
  });
  it("rejects fabricated source, duplicate IDs, repeated source and overlapping passages", () => {
    expect(() => validateWorkbenchResult({ ...result, paragraphEdits: [{ ...edit, sourceText: "不存在的原文内容，不能用于修改。" }] }, "example.com", context)).toThrow("unique exact passage");
    expect(() => validateWorkbenchResult({ ...result, paragraphEdits: [edit, edit] }, "example.com", context)).toThrow();
    expect(() => validateWorkbenchResult({ ...result, paragraphEdits: [edit] }, "example.com", { ...context, body: source + edit.sourceText })).toThrow("unique exact passage");
    expect(() => validateWorkbenchResult({ ...result, paragraphEdits: [edit, { ...edit, id: "overlap", sourceText: source }] }, "example.com", context)).toThrow("overlap");
  });
  it("validates links in every proposed field but allows verbatim external URLs in the original excerpt", () => {
    const original = "原文引用 https://outside.example/source 以供核实。";
    expect(validateWorkbenchResult({ ...result, paragraphEdits: [{ ...edit, sourceText: original }] }, "example.com", { ...context, body: original })).toHaveProperty("paragraphEdits");
    for (const patch of [ { replacementText: "https://outside.example/invented" }, { reason: "[外链](https://outside.example/invented)" }, { evidence: ["https://outside.example/invented"] }, { verification: ['<img src="https://outside.example/invented">'] } ]) {
      expect(() => validateWorkbenchResult({ ...result, paragraphEdits: [{ ...edit, ...patch }] }, "example.com", context)).toThrow("verified site URLs");
    }
  });
  it("keeps evidence and uncertainty boundaries in the task instructions", () => {
    const prompt = buildWorkbenchPrompt({ kind: "REWRITE_ARTICLE", title: "Revise", language: "zh-CN" }, context);
    expect(prompt).toContain("non-overlapping and verbatim"); expect(prompt).toContain("Historical null means not checked");
    expect(prompt).toContain("Do not demand fixed word counts"); expect(prompt).toContain("no publishing");
    expect(prompt).toContain("plain-text excerpt of at most 12,000 characters"); expect(prompt).toContain("Absence from any sample is not evidence");
  });
});
