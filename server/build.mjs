#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args[0] !== "--run" || args.length > 3) {
  console.log("Usage: node server/build.mjs --run [output-directory] [docker-context]");
  console.log("Builds an isolated Linux glibc bundle. Does not alter any installed app or database.");
  process.exit(args.length ? 1 : 0);
}
const destination = path.resolve(args[1] ?? path.join(root, "server", "dist"));
if (existsSync(destination) && readdirSync(destination).length) throw new Error("Use a new empty output directory.");
mkdirSync(destination, { recursive: true });
const { version } = JSON.parse(readFileSync(path.join(root, "source", "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid source release version.");
const context = args[2];
if (context && !/^[A-Za-z0-9._-]+$/.test(context)) throw new Error("Invalid Docker context.");
execFileSync("docker", [...(context ? ["--context", context] : []), "buildx", "build", "--platform", "linux/amd64",
  "--file", "server/Dockerfile.bundle", "--target", "export", "--build-arg", `BUILD_VERSION=${version}`,
  "--output", `type=local,dest=${destination}`, "."], { cwd: root, stdio: "inherit", windowsHide: true });
console.log(`Server bundle exported to ${destination}`);
