import { describe, expect, it } from "vitest";
import { activeTaskOf, isActiveTask } from "./use-site-tasks";
import { researchErrorText } from "@/components/research/research-messages";
import { workbenchErrorText, workbenchKindName, workbenchTasks } from "./workbench-text";

const t = (en: string) => en;
const job = (id: string, status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED", kind = "META_REWRITE") => ({ id, kind, status });

describe("the active task of a site", () => {
  it("lets a background pool task run without blocking a new one", () => {
    expect(activeTaskOf(null)).toEqual({ active: null, blocking: null });
    expect(activeTaskOf({ activeTask: null, jobs: [job("a", "SUCCEEDED")] })).toEqual({ active: null, blocking: null });
    const background = { id: "bg", kind: "SCHEMA_MARKUP", title: "x", background: true };
    expect(activeTaskOf({ activeTask: background, jobs: [job("bg", "RUNNING")] })).toEqual({ active: background, blocking: null });
    const mine = { id: "w", kind: "WRITE_ARTICLE", title: "x" };
    expect(activeTaskOf({ activeTask: mine, jobs: [] })).toEqual({ active: mine, blocking: mine });
    // Without the site's active task, a queued or running task of the list counts.
    expect(activeTaskOf({ jobs: [job("a", "SUCCEEDED"), job("b", "QUEUED")] }).blocking).toMatchObject({ id: "b" });
    expect([isActiveTask(job("a", "RUNNING")), isActiveTask(job("a", "FAILED"))]).toEqual([true, false]);
  });
});

describe("task messages", () => {
  it("reads research and keyword task errors", () => {
    expect(researchErrorText("Invalid backlink sample row 3", t)).toMatch(/^Check backlink sample row 3:/);
    expect(researchErrorText("chatgpt_usage_limit", t)).toMatch(/^This account cannot generate right now/);
    expect(researchErrorText("Site already has an active task", t)).toMatch(/^This site already has an active task/);
    expect(researchErrorText("something new", t)).toBe("something new");
  });
  it("reads workbench errors and names its task types", () => {
    expect(workbenchErrorText("report_evidence_empty", t)).toBe("This report has no saved evidence yet.");
    expect(workbenchErrorText("tool_context_too_large", t)).toMatch(/^The selected material exceeds/);
    expect(workbenchErrorText("something new", t)).toBe("something new");
    expect(workbenchTasks(t).map(task => task.kind)).toEqual([
      "WRITE_ARTICLE",
      "REWRITE_ARTICLE",
      "SEO_FIX_PLAN",
      "LOCALIZE_ARTICLE",
      "SCHEMA_MARKUP",
    ]);
    expect(workbenchKindName("SCHEMA_MARKUP", t)).toBe("Structured data code");
  });
});
