import { describe, expect, it } from "vitest";
import type { WorkbenchResult } from "../schema";
import { reviewOutreach, type OutreachContext } from "./outreach";

const prospect = (n: number, domain: string) => ({ id: `R${n}`, row: n - 1, domain, url: `https://${domain}/resources`, prospectType: "resource_page",
  relevance: "Lists phone accessory guides", approach: "Suggest our guide", pitchAngle: "Care guide for leather cases", contactUrl: `https://${domain}/contact`, observedOn: null });
const context: OutreachContext = {
  domain: "shop.test", brand: "Shop", homepage: "https://shop.test/", topic: "leather phone cases", audience: "UK buyers",
  sender: { name: "Lee", role: "Editor" }, offer: { text: "Our leather care guide", page: { url: "https://shop.test/guides/leather-care", title: "Leather care" } },
  prospects: [prospect(1, "blog.example"), prospect(2, "list.example")],
  allowedLinks: ["https://shop.test/guides/leather-care", "https://shop.test/"],
};
const base: WorkbenchResult = { title: "Drafts", summary: "s", contentMarkdown: "c", metaTitle: "m", metaDescription: "d", changeNotes: [], factChecks: ["Check the contact route"], internalLinks: [], paragraphEdits: [] };
const email = (prospectId: string, body: string, extra: Record<string, unknown> = {}) => ({ prospectId, subject: "A leather care guide for your list", body, basis: ["pitchAngle: care guide"], followUp: "Just checking in.", ...extra });

describe("outreach drafts", () => {
  it("keeps allowed links, replaces others, and fills in the prospect", () => {
    const checked = reviewOutreach({ ...base, outreachEmails: [
      email("R2", "Hi {{name}}, your list https://list.example/resources is great. Our guide: https://shop.test/guides/leather-care/ and also see https://spam.example/x."),
      email("R1", "Hello, we would pay for a sponsored link on https://blog.example/contact"),
      email("R1", "duplicate"),
      email("R5", "unknown prospect"),
    ] }, context, "en");
    expect(checked.metaTitle).toBe("");
    expect(checked.outreachEmails!.map(e => e.prospectId)).toEqual(["R1", "R2"]);
    const [first, second] = checked.outreachEmails!;
    expect(first).toMatchObject({ domain: "blog.example", url: "https://blog.example/resources", contactUrl: "https://blog.example/contact", removedUrls: [] });
    expect(first.warnings).toContain("MENTIONS_PAYMENT");
    expect(second.body).toContain("https://list.example/resources");
    expect(second.body).toContain("https://shop.test/guides/leather-care/");
    expect(second.body).toContain("[verify link]");
    expect(second.body).not.toContain("spam.example");
    expect(second.removedUrls).toEqual(["https://spam.example/x"]);
    expect(second.placeholders).toEqual(["{{name}}"]);
    expect(second.warnings).toEqual(["URL_REMOVED"]);
  });
  it("does not let one prospect's address into another's email, and warns about long bodies", () => {
    const checked = reviewOutreach({ ...base, outreachEmails: [email("R1", `${"word ".repeat(230)} https://list.example/contact`)] }, context, "zh-CN");
    expect(checked.outreachEmails![0].body).toContain("〔链接待核实〕");
    expect(checked.outreachEmails![0].warnings).toEqual(expect.arrayContaining(["URL_REMOVED", "LONG_BODY"]));
  });
  it("fails when no draft matches a chosen prospect", () => {
    let message = "";
    try { reviewOutreach({ ...base, outreachEmails: [email("R9", "x")] }, context, "en"); } catch (error) { message = (error as Error).message; }
    expect(message).toBe("Codex did not return drafts for the selected prospects");
  });
});
