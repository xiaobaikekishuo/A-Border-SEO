import { describe, expect, it } from "vitest";
import { factHints, storedFacts } from "./fact-check";

const facts = [
  { label: "Founded|成立", value: "2015" },
  { label: "Headquarters|总部", value: "Shanghai|上海" },
  { label: "Warranty|保修", value: "2 years|两年" },
  { label: "Price from", value: "$1,299" },
];

describe("brand fact card", () => {
  it("marks facts the answer states, facts it talks about without the value, and facts it leaves out", () => {
    const hints = factHints("Kammak was founded in 2016 and is based in SHANGHAI. Prices start at $1299.", facts);
    expect(hints.map(h => h.status)).toEqual(["CHECK", "STATED", "ABSENT", "STATED"]);
  });

  it("matches Chinese text and full-width forms", () => {
    const hints = factHints("卡玛克成立于２０１５年，总部位于上海，提供两年保修。", facts);
    expect(hints.map(h => h.status)).toEqual(["STATED", "STATED", "STATED", "ABSENT"]);
  });

  it("does not find a number inside a longer one", () => {
    expect(factHints("Over 20150 customers", [{ label: "Founded", value: "2015" }])[0].status).toBe("ABSENT");
  });

  it("reads stored facts defensively", () => {
    expect(storedFacts([{ label: " Founded ", value: " 2015 " }, { label: "", value: "x" }, { label: 1, value: "y" }, "bad"])).toEqual([{ label: "Founded", value: "2015" }]);
    expect(storedFacts(null)).toEqual([]);
  });
});
