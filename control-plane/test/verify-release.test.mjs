import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyOfficialRelease } from "../verify-release.mjs";

const version = "1.3.0";
const repository = "xiaobaikekishuo/A-Border-SEO";
const registry = "ghcr.io/xiaobaikekishuo/a-border-seo";
const prefix = `https://github.com/${repository}/releases/download/v${version}/`;
const installer = `A-Border-SEO-Setup-${version}-x64.exe`;
const childDigest = "sha256:" + "a".repeat(64);
const index = JSON.stringify({ manifests: [{ digest: childDigest, platform: { os: "linux", architecture: "amd64" } }] });
const digest = value => "sha256:" + createHash("sha256").update(value).digest("hex");
const manifest = {
  schemaVersion: 1, version, backendVersion: version, platform: "win32-x64", backendPlatform: "linux/amd64",
  imageTag: registry + ":" + version, image: registry + "@" + digest(index), commit: "b".repeat(40),
  migrations: ["20261112000000_desktop_oauth"], desktopMode: "hosted", workspaceOrigin: "https://aborder.tuitehao.shop",
};
const files = {
  [installer]: "installer fixture",
  [installer + ".blockmap"]: "blockmap fixture",
  "latest.yml": `version: ${version}\npath: ${installer}\nsha512: ${"a".repeat(86)}==\n`,
  "desktop-release.json": JSON.stringify(manifest),
  [`aborder-hosted-images-${version}.tar.gz`]: "hosted deployment archive fixture",
  [`aborder-hosted-ops-${version}.tar.gz`]: "matching hosted maintenance scripts fixture",
  "compose.pins.env": ["APP", "CONTROL", "POSTGRES"].map(role => `HOSTED_${role}_IMAGE=${childDigest}`).join("\n"),
};
files["SHA256SUMS.txt"] = Object.entries(files).map(([name, body]) => `${digest(body).slice(7)}  ${name}`).join("\n");
const release = {
  tag_name: "v" + version, draft: false, prerelease: false,
  assets: Object.entries(files).map(([name, body]) => ({
    name, state: "uploaded", size: body.length, digest: digest(body), browser_download_url: prefix + name,
  })),
};

function fakeNetwork({ assetRedirect = false, publicImage = true, info = release, bodies = files } = {}) {
  return async (raw, options) => {
    const url = new URL(raw);
    if (url.host === "api.github.com") return Response.json(info);
    if (url.host === "github.com") {
      const name = url.pathname.split("/").at(-1);
      if (assetRedirect) return Response.redirect("https://bad.example/" + name);
      if (options.method === "HEAD") return new Response(null, { headers: { "content-length": bodies[name].length } });
      return new Response(bodies[name]);
    }
    if (url.host === "ghcr.io" && url.pathname === "/token") {
      return publicImage ? Response.json({ token: "t".repeat(64) }) : new Response(null, { status: 403 });
    }
    if (url.host === "ghcr.io" && url.pathname.endsWith(digest(index))) return new Response(index);
    if (url.host === "ghcr.io" && url.pathname.endsWith(childDigest)) {
      assert.equal(options.method, "HEAD");
      return new Response(null, { headers: { "docker-content-digest": childDigest } });
    }
    throw new Error("unexpected network destination");
  };
}

test("only allows a complete public official release with matching asset and image digests", async () => {
  assert.deepEqual(await verifyOfficialRelease(version, { fetcher: fakeNetwork() }), { image: manifest.image, commit: manifest.commit });
  for (const overrides of [
    { publicImage: false }, { assetRedirect: true }, { info: { ...release, draft: true } },
    { info: { ...release, assets: release.assets.slice(1) } },
    { info: { ...release, assets: release.assets.filter(asset => !asset.name.startsWith("aborder-hosted-ops-")) } },
    { info: { ...release, assets: release.assets.map(asset => asset.name === "desktop-release.json"
      ? { ...asset, digest: childDigest } : asset) } },
  ]) {
    await assert.rejects(verifyOfficialRelease(version, { fetcher: fakeNetwork(overrides) }), /release_assets_unavailable/);
  }
});

test("rejects checksum-consistent releases for the old architecture, another origin or invalid hosted image pins", async () => {
  for (const change of [
    { "desktop-release.json": JSON.stringify({ ...manifest, desktopMode: undefined }) },
    { "desktop-release.json": JSON.stringify({ ...manifest, workspaceOrigin: "https://other.example" }) },
    { "compose.pins.env": files["compose.pins.env"].replace(childDigest, "latest") },
  ]) {
    const bodies = { ...files, ...change };
    bodies["SHA256SUMS.txt"] = Object.entries(bodies).filter(([name]) => name !== "SHA256SUMS.txt")
      .map(([name, value]) => digest(value).slice(7) + "  " + name).join("\n");
    const assets = release.assets.map(asset => ({ ...asset, digest: digest(bodies[asset.name]), size: bodies[asset.name].length }));
    await assert.rejects(verifyOfficialRelease(version, { fetcher: fakeNetwork({ bodies, info: { ...release, assets } }) }),
      /release_assets_unavailable/);
  }
});
