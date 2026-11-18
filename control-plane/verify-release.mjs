import { createHash } from "node:crypto";
import { RequestError } from "./model.mjs";

const repository = "xiaobaikekishuo/A-Border-SEO";
const imageRepository = "xiaobaikekishuo/a-border-seo";
const assetHosts = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const acceptImage = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

function requireRelease(ok) {
  if (!ok) throw new RequestError(422, "release_assets_unavailable");
}
function sha256(body) { return "sha256:" + createHash("sha256").update(body).digest("hex"); }
async function bodyBytes(response, limit) {
  requireRelease(response.ok && response.body);
  let size = 0;
  const reader = response.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      requireRelease(false);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
function safeAssetUrl(version, name) {
  return `https://github.com/${repository}/releases/download/v${version}/${name}`;
}
async function requestAsset(version, name, method, signal, fetcher) {
  let url = new URL(safeAssetUrl(version, name));
  for (let hop = 0; hop < 5; hop++) {
    requireRelease(url.protocol === "https:" && !url.port && !url.username && !url.password && assetHosts.has(url.hostname));
    const response = await fetcher(url, { method, redirect: "manual", signal });
    const next = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && next) {
      await response.body?.cancel();
      url = new URL(next, url);
      continue;
    }
    requireRelease(response.ok);
    return response;
  }
  requireRelease(false);
}
async function downloadText(version, asset, signal, fetcher) {
  const response = await requestAsset(version, asset.name, "GET", signal, fetcher);
  const bytes = await bodyBytes(response, 256 * 1024);
  requireRelease(sha256(bytes) === asset.digest);
  return bytes.toString("utf8");
}

async function verifyImage(digest, signal, fetcher) {
  const tokenUrl = new URL("https://ghcr.io/token");
  tokenUrl.searchParams.set("service", "ghcr.io");
  tokenUrl.searchParams.set("scope", `repository:${imageRepository}:pull`);
  const authentication = await fetcher(tokenUrl, { redirect: "error", signal });
  const token = JSON.parse(await bodyBytes(authentication, 16 * 1024)).token;
  requireRelease(typeof token === "string" && /^[a-zA-Z0-9_.=-]{20,8192}$/.test(token));
  const headers = { Authorization: `Bearer ${token}`, Accept: acceptImage };
  const manifestUrl = id => `https://ghcr.io/v2/${imageRepository}/manifests/${id}`;
  const indexResponse = await fetcher(manifestUrl(digest), { headers, redirect: "error", signal });
  const indexBytes = await bodyBytes(indexResponse, 512 * 1024);
  requireRelease(sha256(indexBytes) === digest);
  const index = JSON.parse(indexBytes);
  const amd64 = index.manifests?.find(manifest => manifest.platform?.os === "linux" && manifest.platform.architecture === "amd64");
  requireRelease(sha256Pattern.test(amd64?.digest));
  const child = await fetcher(manifestUrl(amd64.digest), { method: "HEAD", headers, redirect: "error", signal });
  requireRelease(child.ok && child.headers.get("docker-content-digest") === amd64.digest);
}

export async function verifyOfficialRelease(version, { fetcher = fetch } = {}) {
  const signal = AbortSignal.timeout(25_000);
  try {
    const api = await fetcher(`https://api.github.com/repos/${repository}/releases/tags/v${version}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "A-Border-SEO-control-plane" },
      redirect: "error", signal,
    });
    const release = JSON.parse(await bodyBytes(api, 512 * 1024));
    requireRelease(release.tag_name === `v${version}` && release.draft === false && release.prerelease === false);
    const installer = `A-Border-SEO-Setup-${version}-x64.exe`;
    const archive = `aborder-hosted-images-${version}.tar.gz`;
    const operations = `aborder-hosted-ops-${version}.tar.gz`;
    const names = [installer, installer + ".blockmap", "latest.yml", "desktop-release.json", archive, operations, "compose.pins.env", "SHA256SUMS.txt"];
    const assets = Object.fromEntries(names.map(name => {
      const asset = release.assets?.find(item => item.name === name);
      requireRelease(asset?.state === "uploaded" && Number.isSafeInteger(asset.size) && asset.size > 0
        && sha256Pattern.test(asset.digest) && asset.browser_download_url === safeAssetUrl(version, name));
      return [name, asset];
    }));
    const [latest, manifestJson, checksums, pins] = await Promise.all([
      downloadText(version, assets["latest.yml"], signal, fetcher),
      downloadText(version, assets["desktop-release.json"], signal, fetcher),
      downloadText(version, assets["SHA256SUMS.txt"], signal, fetcher),
      downloadText(version, assets["compose.pins.env"], signal, fetcher),
      ...[installer, archive, operations].map(async name => {
        const response = await requestAsset(version, name, "HEAD", signal, fetcher);
        const length = response.headers.get("content-length");
        requireRelease(length === null || Number(length) === assets[name].size);
      }),
    ]);
    const expectedPins = ["APP", "CONTROL", "POSTGRES"].map(role => `HOSTED_${role}_IMAGE`);
    const pinRows = pins.trimEnd().split(/\r?\n/);
    requireRelease(pinRows.length === expectedPins.length && expectedPins.every(key =>
      pinRows.some(row => row.startsWith(key + "=") && sha256Pattern.test(row.slice(key.length + 1)))));
    const sumRows = new Map(checksums.trim().split(/\r?\n/).map(line => line.split(/\s+/, 2).reverse()));
    for (const name of names.slice(0, -1)) requireRelease(`sha256:${sumRows.get(name)}` === assets[name].digest);
    const latestField = field => latest.split(/\r?\n/).find(line => line.startsWith(`${field}: `))?.slice(field.length + 2).trim();
    requireRelease(latestField("version") === version && latestField("path") === installer
      && /^[A-Za-z0-9+/]{86}==$/.test(latestField("sha512")));
    const manifest = JSON.parse(manifestJson);
    const prefix = `ghcr.io/${imageRepository}@`;
    requireRelease(manifest.schemaVersion === 1 && manifest.version === version && manifest.backendVersion === version
      && manifest.desktopMode === "hosted" && manifest.workspaceOrigin === "https://aborder.tuitehao.shop"
      && manifest.platform === "win32-x64" && manifest.backendPlatform === "linux/amd64"
      && manifest.imageTag === `ghcr.io/${imageRepository}:${version}`
      && !manifest.localImageId && typeof manifest.image === "string" && manifest.image.startsWith(prefix)
      && /^[a-f0-9]{40}$/.test(manifest.commit) && Array.isArray(manifest.migrations)
      && manifest.migrations.every(name => /^\d{14}_[a-zA-Z0-9_-]+$/.test(name)));
    const digest = manifest.image.slice(prefix.length);
    requireRelease(sha256Pattern.test(digest));
    await verifyImage(digest, signal, fetcher);
    return { image: manifest.image, commit: manifest.commit };
  } catch {
    throw new RequestError(422, "release_assets_unavailable");
  }
}
