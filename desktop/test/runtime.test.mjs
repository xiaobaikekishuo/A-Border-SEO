import assert from "node:assert/strict";
import test from "node:test";
import { fetchManifest, validateBundledManifest, validateManifest, validWorkbenchOrigin, workbenchExternal } from "../runtime.mjs";

const origin = "http://localhost:3300";
test("hosted Google authorization only returns to the trusted workspace origin", () => {
  const hostedOrigin = "https://aborder.tuitehao.shop";
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.searchParams.set("redirect_uri", hostedOrigin + "/api/auth/callback/google");
  assert.equal(workbenchExternal(target.href, hostedOrigin), target.href);
  target.searchParams.set("redirect_uri", "https://other.example/api/auth/callback/google");
  assert.equal(workbenchExternal(target.href, hostedOrigin), null);
});
const manifest = {
  schemaVersion: 1, version: "1.2.0", backendVersion: "1.2.0", commit: "a".repeat(40),
  image: "ghcr.io/xiaobaikekishuo/a-border-seo@sha256:" + "b".repeat(64),
  imageTag: "ghcr.io/xiaobaikekishuo/a-border-seo:1.2.0", platform: "win32-x64",
  backendPlatform: "linux/amd64", minimumPowerShell: "7.3.0", migrations: ["20261112000000_desktop_oauth"],
};

test("hosted and local installers cannot be substituted on the release feed", async () => {
  const workspaceOrigin = "https://aborder.tuitehao.shop";
  const hosted = { ...manifest, minimumPowerShell: undefined, desktopMode: "hosted", workspaceOrigin };
  await assert.rejects(fetchManifest("1.2.0", () => Response.json(manifest), workspaceOrigin), /invalid_release_manifest/);
  await assert.rejects(fetchManifest("1.2.0", () => Response.json(hosted)), /invalid_release_manifest/);
  await assert.rejects(fetchManifest("1.2.0", () => Response.json({ ...hosted, workspaceOrigin: "https://other.example" }), workspaceOrigin),
    /invalid_release_manifest/);
  assert.equal((await fetchManifest("1.2.0", () => Response.json(hosted), workspaceOrigin)).desktopMode, "hosted");
});

test("requires release metadata to bind the exact versions, platforms and official image digest", () => {
  assert.deepEqual(validateManifest(manifest, "1.2.0"), manifest);
  for (const change of [
    { image: "ghcr.io/xiaobaikekishuo/a-border-seo:latest" }, { backendVersion: "1.1.2" },
    { imageTag: "ghcr.io/xiaobaikekishuo/a-border-seo:latest" }, { platform: "win32-ia32" },
  ]) assert.throws(() => validateManifest({ ...manifest, ...change }, "1.2.0"), /invalid_release_manifest/);
});

test("release manifests follow GitHub asset redirects only", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
    return calls.length === 1
      ? Response.redirect("https://release-assets.githubusercontent.com/asset")
      : Response.json(manifest);
  };
  assert.deepEqual(await fetchManifest("1.2.0", fetcher), manifest);
  assert.equal(calls.length, 2);
  await assert.rejects(fetchManifest("1.2.0", async () => Response.redirect("https://example.org/asset")), /invalid_release_redirect/);
});

test("only bundled internal manifests can pin an already-loaded local backend", async () => {
  const image = "aborder-seo-internal:1.2.0";
  const local = { ...manifest, image, imageTag: image, localImageId: "sha256:" + "d".repeat(64) };
  assert.deepEqual(validateBundledManifest(local, "1.2.0"), local);
  assert.throws(() => validateBundledManifest({ ...local, image: "a-border-seo:latest" }, "1.2.0"), /invalid_release_manifest/);
  assert.throws(() => validateBundledManifest({ ...local, localImageId: "sha256:123" }, "1.2.0"), /invalid_release_manifest/);
  assert.throws(() => validateManifest(local, "1.2.0"), /invalid_release_manifest/);
  await assert.rejects(fetchManifest("1.2.0", async () => Response.json(local)), /invalid_release_manifest/);
});

test("only the configured desktop OAuth flows can launch from the exposed bridge", () => {
  const login = `${origin}/desktop/oauth/login?id=${"a".repeat(43)}`;
  const ga = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  ga.searchParams.set("redirect_uri", `${origin}/desktop/oauth/ga4/callback`);
  const gsc = new URL(ga);
  gsc.searchParams.set("redirect_uri", `${origin}/desktop/oauth/google/callback`);
  const existingGoogle = new URL(ga);
  existingGoogle.searchParams.set("redirect_uri", `${origin}/api/auth/callback/google`);
  const chatgpt = new URL("https://auth.openai.com/api/accounts/authorize");
  chatgpt.searchParams.set("redirect_uri", "http://127.0.0.1:3300/auth/chatgpt/callback");
  for (const url of [login, ga.href, gsc.href, existingGoogle.href, chatgpt.href]) assert.equal(workbenchExternal(url, origin), url);
  for (const url of [
    login + "&next=https://example.org/", login.replace("localhost", "127.0.0.1"),
    ga.href + "&redirect_uri=https://example.org/", gsc.href + "&redirect_uri=https://example.org/", gsc.href.replace("3300", "8080"), chatgpt.href.replace("3300", "8080"),
    existingGoogle.href.replace("3300", "8080"), existingGoogle.href + "&redirect_uri=https://example.org/",
    "file:///C:/Windows/System32/cmd.exe", "https://accounts.google.com.example.org/o/oauth2/v2/auth",
  ]) assert.equal(workbenchExternal(url, origin), null);
  assert.equal(validWorkbenchOrigin(origin), origin);
  assert.equal(validWorkbenchOrigin("http://localhost:3300.example.org"), null);
});
