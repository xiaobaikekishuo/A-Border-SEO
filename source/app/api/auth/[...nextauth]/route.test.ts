import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ handlers: { GET: mocks.get, POST: mocks.post } }));
vi.mock("@/lib/google/connection-callback", () => ({ handleGoogleConnectionCallback: mocks.connect }));

import { GET, POST } from "./route";

const origin = "http://localhost:3300";
const connectionState = "aborder-gsc." + "a".repeat(43);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(new Response("normal Google sign-in", { headers: { "Set-Cookie": "ordinary-session=fixture" } }));
  mocks.post.mockResolvedValue(new Response("Auth.js POST result"));
  mocks.connect.mockResolvedValue(new Response("Return to your workspace", { status: 303, headers: { Location: "/desktop/oauth/google/callback?finished=1" } }));
});

describe("Google callback dispatch preserves application sign-in", () => {
  it.each([
    "/api/auth/callback/google?state=ordinary-authjs-state&code=fixture-code",
    "/api/auth/callback/google?error=access_denied&state=ordinary-authjs-state",
    "/api/auth/callback/google?code=fixture-code",
  ])("passes the normal Auth.js callback through unchanged: %s", async path => {
    const req = new NextRequest(origin + path, { headers: { Cookie: "authjs.state=fixture" } });
    const expected = await mocks.get.getMockImplementation()!();
    const response = await GET(req);
    expect(response).toBe(expected);
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(req);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBe("ordinary-session=fixture");
  });

  it.each([
    "/api/auth/signin/google",
    "/api/auth/callback/github",
    "/api/auth/callback/google/extra",
  ])("does not intercept another Auth.js route even with a connection state: %s", async path => {
    const req = new NextRequest(origin + path + "?state=" + connectionState);
    await GET(req);
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(req);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("routes a connection callback to the attachment flow without creating a sign-in cookie", async () => {
    const req = new NextRequest(origin + "/api/auth/callback/google?state=" + connectionState + "&code=fixture-code");
    const response = await GET(req);
    expect(mocks.connect).toHaveBeenCalledExactlyOnceWith(req);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it.each([
    "state=aborder-gsc.",
    "state=aborder-gsc.invalid",
    "state=" + connectionState + "&state=ordinary-authjs-state",
    "state=ordinary-authjs-state&state=" + connectionState,
  ])("does not fall back to sign-in for a rejected namespaced callback: %s", async query => {
    const rejected = new Response("Invalid connection request", { status: 400 });
    mocks.connect.mockResolvedValueOnce(rejected);
    const req = new NextRequest(origin + "/api/auth/callback/google?" + query + "&code=fixture-code");
    expect(await GET(req)).toBe(rejected);
    expect(mocks.connect).toHaveBeenCalledExactlyOnceWith(req);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("keeps POST handling with Auth.js", async () => {
    const req = new NextRequest(origin + "/api/auth/signin/google", { method: "POST", body: "csrfToken=fixture" });
    expect(POST).toBe(mocks.post);
    expect(await (await POST(req)).text()).toBe("Auth.js POST result");
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(req);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
