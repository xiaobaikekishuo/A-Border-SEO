import { describe, expect, it } from "vitest";
import {
  generateIndexNowKey, groupSiteUrls, INDEXNOW_MAX_URLS, keyFileMatches, keyFileUrl, submissionBody, submissionOutcome, validIndexNowKey,
} from "./indexnow";

describe("IndexNow keys", () => {
  it("generates keys the protocol accepts", () => {
    const key = generateIndexNowKey();
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(validIndexNowKey(key)).toBe(true);
    expect(generateIndexNowKey()).not.toBe(key);
    expect(validIndexNowKey("short")).toBe(false);
    expect(validIndexNowKey("has space 1234")).toBe(false);
  });

  it("checks the key file's text exactly, ignoring a BOM and surrounding whitespace", () => {
    expect(keyFileUrl("https://shop.example/", "abc12345")).toBe("https://shop.example/abc12345.txt");
    expect(keyFileMatches("﻿abc12345\n", "abc12345")).toBe(true);
    expect(keyFileMatches("abc12345 extra", "abc12345")).toBe(false);
    expect(keyFileMatches("<html>abc12345</html>", "abc12345")).toBe(false);
    expect(keyFileMatches(null, "abc12345")).toBe(false);
  });
});

describe("IndexNow submissions", () => {
  it("keeps the site's URLs, one group per origin, and drops the rest", () => {
    const { groups, rejected, truncated } = groupSiteUrls([
      "https://shop.example/a", "https://shop.example/a#top", "https://www.shop.example/b", "http://shop.example/c",
      "https://other.example/x", "ftp://shop.example/y", "not a url", "https://user:pw@shop.example/z",
    ], "shop.example");
    expect(Object.fromEntries(groups)).toEqual({
      "https://shop.example": ["https://shop.example/a"],
      "https://www.shop.example": ["https://www.shop.example/b"],
      "http://shop.example": ["http://shop.example/c"],
    });
    expect({ rejected, truncated }).toEqual({ rejected: 4, truncated: 0 });
  });

  it("stops at the protocol's limit of URLs per submission", () => {
    const urls = Array.from({ length: INDEXNOW_MAX_URLS + 5 }, (_, i) => `https://shop.example/p/${i}`);
    const { groups, truncated } = groupSiteUrls(urls, "www.shop.example");
    expect(groups.get("https://shop.example")).toHaveLength(INDEXNOW_MAX_URLS);
    expect(truncated).toBe(5);
  });

  it("builds the request body and reads the documented status codes", () => {
    expect(submissionBody("https://www.shop.example", "abc12345", ["https://www.shop.example/a"])).toEqual({
      host: "www.shop.example", key: "abc12345", keyLocation: "https://www.shop.example/abc12345.txt", urlList: ["https://www.shop.example/a"],
    });
    expect([200, 202, 400, 403, 422, 429, 500].map(submissionOutcome)).toEqual(["ACCEPTED", "PENDING_KEY", "BAD_REQUEST", "KEY_INVALID", "WRONG_HOST", "RATE_LIMITED", "FAILED"]);
  });
});
