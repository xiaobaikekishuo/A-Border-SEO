import { describe, expect, it } from "vitest";
import { applyParagraphEdit, hasRewriteBody, isAccountLimitError, syncDraftEditor, type WorkbenchJob } from "./model";
import { opportunityWorkbenchHref } from "./opportunity-link";

const completeJob: WorkbenchJob = {
  id: "aw_one", kind: "WRITE_ARTICLE", status: "SUCCEEDED", title: "A guide", createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:01:00Z",
  startedAt: "2026-11-05T00:00:05Z", finishedAt: "2026-11-05T00:01:00Z", error: null, draftText: null,
  result: { title: "A guide", summary: "Summary", contentMarkdown: "Original article", metaTitle: "A guide", metaDescription: "Description", changeNotes: [], factChecks: [], internalLinks: [] },
};

describe("paragraph review", () => {
  const edit = { id: "one", sourceText: "原段落。", replacementText: "有依据的新段落。", reason: "clarify", evidence: ["source"], verification: ["review"] };
  it("changes only a unique original passage and preserves surrounding manual edits", () => {
    expect(applyParagraphEdit("手工前言\n原段落。\n手工结尾", edit)).toEqual({ ok: true, text: "手工前言\n有依据的新段落。\n手工结尾" });
  });
  it("refuses missing or repeated text rather than overwriting newer edits", () => {
    expect(applyParagraphEdit("我已编辑原段落。的新版本", { ...edit, sourceText: "完整原段落。" })).toMatchObject({ ok: false, reason: "missing" });
    expect(applyParagraphEdit("原段落。\n原段落。", edit)).toMatchObject({ ok: false, reason: "ambiguous" });
  });
  it("does not apply twice, even when the replacement contains the old passage", () => {
    const expansion = { ...edit, replacementText: "原段落。新增解释。" };
    const first = applyParagraphEdit("原段落。", expansion);
    expect(first.ok).toBe(true);
    if (first.ok) expect(applyParagraphEdit(first.text, expansion)).toMatchObject({ ok: false, reason: "already" });
  });
  it("allows shortening a passage to a phrase already present inside it", () => {
    expect(applyParagraphEdit("Apple ID用于登录商店", { ...edit, sourceText: "Apple ID用于登录商店", replacementText: "Apple ID" })).toEqual({ ok: true, text: "Apple ID" });
    expect(applyParagraphEdit("Apple ID\nApple ID用于登录商店", { ...edit, sourceText: "Apple ID用于登录商店", replacementText: "Apple ID" })).toEqual({ ok: true, text: "Apple ID\nApple ID" });
  });
  it("bounds the final editable draft", () => {
    expect(applyParagraphEdit("x".repeat(59995) + "原段落。", edit)).toMatchObject({ ok: false, reason: "too_long" });
  });
});

describe("opportunity navigation", () => {
  it("encodes exact query and URL as task identifiers without performance numbers or generation actions", () => {
    const path = opportunityWorkbenchHref("site/a", { query: "App Store & iCloud?", url: "https://site.test/a?x=1&y=2", opportunity: "low_ctr" });
    const result = new URL(path, "http://localhost");
    expect(result.pathname).toBe("/sites/site%2Fa/assistant");
    expect(result.searchParams.get("query")).toBe("App Store & iCloud?");
    expect(result.searchParams.get("url")).toBe("https://site.test/a?x=1&y=2");
    expect([...result.searchParams.keys()].sort()).toEqual(["opportunity", "query", "url"]);
  });
});
describe("account limit messages", () => {
  it("does not misreport a cancellation that mentions used quota as a quota failure", () => {
    expect(isAccountLimitError("Canceled by user. The local helper stops at its next heartbeat; already used quota is not refunded.")).toBe(false);
    expect(isAccountLimitError("chatgpt_usage_limit")).toBe(true);
    expect(isAccountLimitError("Rate limit reached")).toBe(true);
    expect(isAccountLimitError("subscription_sharing_usage_limit_exceeded")).toBe(true);
  });
});
describe("workbench draft editing", () => {
  it("does not overwrite unsaved edits or advance their concurrency token during polling", () => {
    const editing = { jobId: completeJob.id, text: "My unsaved edits", baseline: "Original article", updatedAt: completeJob.updatedAt };
    const changedElsewhere = { ...completeJob, draftText: "Another editor's saved text", updatedAt: "2026-11-05T00:03:00Z" };
    expect(syncDraftEditor(editing, changedElsewhere)).toBe(editing);
  });
  it("loads a saved revision after refresh when there are no local edits", () => {
    const editing = syncDraftEditor(null, completeJob)!;
    const updated = syncDraftEditor(editing, { ...completeJob, draftText: "Saved revision", updatedAt: "2026-11-05T00:03:00Z" });
    expect(updated).toMatchObject({ text: "Saved revision", baseline: "Saved revision", updatedAt: "2026-11-05T00:03:00Z" });
  });
  it("preserves the editor if its task temporarily disappears from the paginated history", () => {
    const editing = syncDraftEditor(null, completeJob)!;
    expect(syncDraftEditor(editing, undefined)).toBe(editing);
  });
  it("opens another task with that task's own saved draft, never the preceding article", () => {
    const previous = { jobId: completeJob.id, text: "Other unsaved text", baseline: "Original article", updatedAt: completeJob.updatedAt };
    expect(syncDraftEditor(previous, { ...completeJob, id: "aw_two", draftText: "Second article" })).toMatchObject({ jobId: "aw_two", text: "Second article", baseline: "Second article" });
  });
});
describe("rewrite evidence gate", () => {
  const pages = [{ id: "body", url: "https://site.test/a", title: "A", hasBody: true }, { id: "old", url: "https://site.test/b", title: "B", hasBody: false }];
  it("requires actual selected body evidence, not an unrelated page or empty crawl", () => {
    expect(hasRewriteBody("", "old", pages)).toBe(false);
    expect(hasRewriteBody("", "body", pages)).toBe(true);
    expect(hasRewriteBody("", "missing", pages)).toBe(false);
    expect(hasRewriteBody("a".repeat(100), "", pages)).toBe(true);
  });
  it("does not accept an undersized pasted override merely because stored body exists", () => {
    expect(hasRewriteBody("short override", "body", pages)).toBe(false);
  });
});
