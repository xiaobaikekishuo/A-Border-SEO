import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  listBingSites: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/bing", () => ({
  listBingSites: mocks.listBingSites,
  BingKeyMissingError: class BingKeyMissingError extends Error {},
}));

import { BingKeyMissingError } from "@/lib/bing";
import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "current-user" } });
  mocks.listBingSites.mockResolvedValue([{ url: "https://example.org/" }]);
});

describe("GET /api/bing/sites", () => {
  it("requires an authenticated user before looking up provider resources", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.listBingSites).not.toHaveBeenCalled();
  });

  it("requests only the signed-in user's verified resources", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mocks.listBingSites).toHaveBeenCalledWith("current-user");
    expect(await response.json()).toEqual([{ url: "https://example.org/" }]);
  });

  it("identifies a missing key without returning the exception message", async () => {
    const error = new BingKeyMissingError();
    error.message = "private-context";
    mocks.listBingSites.mockRejectedValueOnce(error);
    const response = await GET();
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("BING_KEY_MISSING");
    expect(body).not.toContain("private-context");
  });

  it("never returns or logs credentials from a failed provider lookup", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.listBingSites.mockRejectedValueOnce(new Error("GetUserSites?apikey=secret-marker upstream response"));
      const response = await GET();
      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).toContain("BING_PROPERTY_CHECK_FAILED");
      expect(body).not.toContain("secret-marker");
      expect(body).not.toContain("upstream response");
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
