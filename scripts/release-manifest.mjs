import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertVersion, releaseNotes } from "./version.mjs";

const registryImage = "ghcr.io/xiaobaikekishuo/a-border-seo";
const root = fileURLToPath(new URL("..", import.meta.url));

try {
  const args = process.argv.slice(2);
  let output = new URL("../desktop/release-manifest.json", import.meta.url);
  if (args.at(-2) === "--output") {
    output = args.pop();
    args.pop();
  }
  const hosted = args.at(-1) === "--hosted";
  if (hosted) args.pop();
  const [imageArg, tag] = args;
  const version = assertVersion(tag);
  const localImage = imageArg === "--local-image" ? `aborder-seo-internal:${version}` : null;
  const isLocal = imageArg === "--local" || Boolean(localImage);
  const digest = imageArg?.slice(registryImage.length);
  if (!isLocal && (!imageArg?.startsWith(registryImage) || !/^@sha256:[0-9a-f]{64}$/.test(digest))) {
    throw new Error("Provide " + registryImage + "@sha256:<digest>, --local-image, or --local.");
  }
  if (!isLocal) releaseNotes(version);
  let localImageId;
  if (localImage) {
    const imageInfo = execFileSync("docker", ["image", "inspect", "--format",
      '{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.version"}}', localImage],
    { cwd: root, encoding: "utf8" }).trim().split(/\s+/);
    if (!/^sha256:[a-f0-9]{64}$/.test(imageInfo[0]) || imageInfo[1] !== "linux/amd64" || imageInfo[2] !== version) {
      throw new Error(`${localImage} must be a local linux/amd64 backend built as version ${version}.`);
    }
    [localImageId] = imageInfo;
  }

  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const migrations = readdirSync(new URL("../source/prisma/migrations/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const manifest = {
    schemaVersion: 1,
    version,
    backendVersion: version,
    commit,
    image: localImage ?? (isLocal ? "" : imageArg),
    imageTag: localImage ?? (isLocal ? "" : registryImage + ":" + version),
    ...(localImageId ? { localImageId } : {}),
    platform: "win32-x64",
    backendPlatform: "linux/amd64",
    migrations,
    ...(hosted ? { desktopMode: "hosted",
      workspaceOrigin: JSON.parse(readFileSync(new URL("../desktop/hosted-workspace.json", import.meta.url), "utf8")).workspaceOrigin,
    } : { minimumPowerShell: "7.3.0" }),
  };
  writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
