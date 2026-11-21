import { describe, expect, it } from "vitest";
import { slowQueryLine, slowQueryThreshold } from "./db-log";

describe("slow query log", () => {
  it("is off unless a positive number of milliseconds is set", () => {
    expect(slowQueryThreshold(undefined)).toBeNull();
    expect(slowQueryThreshold("")).toBeNull();
    expect(slowQueryThreshold("0")).toBeNull();
    expect(slowQueryThreshold("-5")).toBeNull();
    expect(slowQueryThreshold("soon")).toBeNull();
    expect(slowQueryThreshold(" 200 ")).toBe(200);
  });
  it("logs the time and the SQL on one line, without parameters", () => {
    const line = slowQueryLine({ duration: 231.6, query: 'SELECT "id"\n  FROM "Keyword"\n  WHERE "siteId" = $1' });
    expect(line).toBe('[slow query] 232 ms SELECT "id" FROM "Keyword" WHERE "siteId" = $1');
    expect(slowQueryLine({ duration: 1, query: "x".repeat(900) })).toHaveLength("[slow query] 1 ms ".length + 600);
  });
});
