import { expect, it } from "vitest";
import type { HostedSnapshot } from "@/lib/hosted/control";
import { ordinaryReceiptStatus } from "./hosted-receipts";

const policy = (allowed = true, geo = true) => ({ allowed, features: { jobs: true, geo, codex: true, manus: true } }) as HostedSnapshot;
it("does not report enforcement complete while affected jobs are still running", () => {
  expect(ordinaryReceiptStatus(policy(false), [{ type: "crawl" }])).toBe("draining");
  expect(ordinaryReceiptStatus(policy(false), [])).toBe("blocked");
});
it("only waits for running work affected by a feature restriction", () => {
  expect(ordinaryReceiptStatus(policy(true, false), [{ type: "geo-visibility" }])).toBe("draining");
  expect(ordinaryReceiptStatus(policy(true, false), [{ type: "gsc-sync" }])).toBe("blocked");
  expect(ordinaryReceiptStatus(policy(), [{ type: "gsc-sync" }])).toBe("effective");
});
