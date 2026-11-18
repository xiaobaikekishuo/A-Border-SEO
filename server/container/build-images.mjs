#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 as digest } from "../deploy/common.mjs";

const args = process.argv.slice(2);
if (!["--run", "--prepare-only"].includes(args[0]) || args.length < 3 || args.length > 4) {
  console.log("Usage: node server/container/build-images.mjs --run FINAL_BUNDLE.tar.gz NEW_OUTPUT_DIRECTORY [docker-context]");
  console.log("  --prepare-only FINAL_BUNDLE.tar.gz NEW_OUTPUT_DIRECTORY prepares a host-build context without Docker.");
  process.exit(args.length ? 1 : 0);
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = fileURLToPath(new URL("./", import.meta.url));
const bundle = fs.realpathSync(args[1]), output = path.resolve(args[2]);
if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error("Use an empty output directory.");
fs.mkdirSync(output, { recursive: true });
const stage = path.join(output, "build-context");
fs.mkdirSync(stage);
const version = JSON.parse(fs.readFileSync(path.join(root, "source/package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release version.");
fs.copyFileSync(bundle, path.join(stage, "bundle.tar.gz"));
for (const file of ["Dockerfile.runtime", "Dockerfile.control", "start.mjs", "database.mjs", "control-backup.mjs", "smoke.mjs", "build-on-host.sh"]) {
  fs.copyFileSync(path.join(source, file), path.join(stage, file));
}
fs.mkdirSync(path.join(stage, "control-plane"));
for (const file of fs.readdirSync(path.join(root, "control-plane"))) {
  if (file.endsWith(".mjs") || file === "package.json" || ["web", "migrations"].includes(file)) {
    fs.cpSync(path.join(root, "control-plane", file), path.join(stage, "control-plane", file), { recursive: true });
  }
}
fs.mkdirSync(path.join(stage, "source/lib/managed"), { recursive: true });
fs.copyFileSync(path.join(root, "source/lib/managed/protocol.mjs"), path.join(stage, "source/lib/managed/protocol.mjs"));
if (args[0] === "--prepare-only") {
  fs.writeFileSync(path.join(output, "BUNDLE_SHA256"), digest(bundle) + "\n");
  console.log(`Prepared ${stage}; on the server run: bash build-on-host.sh --run ${digest(bundle)} ${version}`);
  process.exit(0);
}
const context = args[3];
if (context && !/^[A-Za-z0-9._-]+$/.test(context)) throw new Error("Invalid Docker context.");
const docker = (argv, capture = false) => execFileSync("docker", [...(context ? ["--context", context] : []), ...argv],
  { cwd: stage, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true });
const app = `aborder-hosted-app:${version}`, control = `aborder-hosted-control:${version}`;
docker(["build", "--platform", "linux/amd64", "-f", "Dockerfile.runtime", "--build-arg", `BUNDLE_SHA256=${digest(bundle)}`,
  "--build-arg", `RELEASE_VERSION=${version}`, "-t", app, "."]);
docker(["build", "--platform", "linux/amd64", "-f", "Dockerfile.control", "--build-arg", `RELEASE_VERSION=${version}`, "-t", control, "."]);
docker(["pull", "--platform", "linux/amd64", "postgres:16-bookworm"]);
const id = image => docker(["image", "inspect", "--format", "{{.Id}}", image], true).trim();
const postgres = "aborder-hosted-postgres:16-" + id("postgres:16-bookworm").slice(7, 19);
docker(["tag", "postgres:16-bookworm", postgres]);
const archive = path.join(output, "aborder-hosted-images-" + version + ".tar");
docker(["save", "--output", archive, app, control, postgres]);
fs.writeFileSync(path.join(output, "compose.pins.env"), `HOSTED_APP_IMAGE=${id(app)}\nHOSTED_CONTROL_IMAGE=${id(control)}\nHOSTED_POSTGRES_IMAGE=${id(postgres)}\n`);
fs.writeFileSync(path.join(output, "SHA256SUMS"), digest(archive) + "  " + path.basename(archive) + "\n");
console.log("Container images and immutable Compose pins exported to " + output);
