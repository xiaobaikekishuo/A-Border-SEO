import { describe, expect, it } from "vitest";
import { bingSyncOutcome } from "./bing-sync-button";

describe("Bing sync results", () => {
  it("does not claim success while a job is waiting or running", () => {
    expect(bingSyncOutcome({ status: "RUNNING" })).toBeNull();
    expect(bingSyncOutcome({ status: "QUEUED", stalled: true })).toBe("pending");
    expect(bingSyncOutcome({ status: "QUEUED", waiting: true })).toBe("pending");
    expect(bingSyncOutcome({ status: "FAILED" })).toBe("failed");
  });
  it("distinguishes complete, partial and empty provider results", () => {
    expect(bingSyncOutcome({ status: "SUCCEEDED", result: { daysUpserted: 12 } })).toBe("success");
    expect(bingSyncOutcome({ status: "SUCCEEDED", result: { daysUpserted: 12, partial: ["queries"] } })).toBe("partial");
    expect(bingSyncOutcome({ status: "SUCCEEDED", result: { daysUpserted: 0, queriesUpserted: 0, pagesUpserted: 0 } })).toBe("empty");
    expect(bingSyncOutcome({ status: "SUCCEEDED" })).toBe("empty");
  });
});
