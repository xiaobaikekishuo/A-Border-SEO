import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const packages = ["source", "source/packages/mcp", "desktop"];
const changelog = "source/CHANGELOG.md";
const notesPlaceholder = "填写本版变更、数据库迁移和重新授权要求。";
const imageFiles = [
  "source/Dockerfile",
  "source/docker-compose.yml",
  "source/.env.example",
  "windows/compose.local.yml",
  "windows/scripts/common.ps1",
  "windows/.env.example",
];

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function requireVersion(version) {
  if (typeof version !== "string" || !versionPattern.test(version)) {
    throw new Error("Expected a stable MAJOR.MINOR.PATCH version.");
  }
  return version;
}

function versionRecords() {
  return packages.flatMap((directory) => {
    const path = directory + "/package.json";
    const lockPath = directory + "/package-lock.json";
    const content = read(path);
    const records = [{ path, content, data: JSON.parse(content) }];
    if (directory !== "source/packages/mcp" || existsSync(resolve(root, lockPath))) {
      const content = read(lockPath);
      const data = JSON.parse(content);
      if (!data.packages?.[""]) throw new Error(lockPath + " has no root package entry.");
      records.push({ path: lockPath, content, data, root: data.packages[""] });
    }
    return records;
  });
}

export function assertVersion(tag) {
  const records = versionRecords();
  const version = requireVersion(records[0].data.version);
  for (const { path, data, root } of records) {
    if (data.version !== version || (root && root.version !== version)) {
      throw new Error(path + " version must match source/package.json (" + version + ").");
    }
  }
  if (tag !== undefined && tag !== "v" + version) {
    throw new Error("Git tag must be v" + version + " (got " + tag + ").");
  }
  return version;
}

export function releaseNotes(version = assertVersion()) {
  const content = read(changelog).replace(/\r\n/g, "\n");
  const [, ...sections] = content.split(/^## /m);
  const section = sections.find((value) => value.split("\n", 1)[0].split(/[（ (]/, 1)[0] === version);
  const notes = section?.slice(section.indexOf("\n") + 1).trim();
  if (!notes || notes === notesPlaceholder) {
    throw new Error("Add release notes for " + version + " in " + changelog + ".");
  }
  return notes + "\n";
}

function setVersion(nextVersion, date) {
  const records = versionRecords();
  const current = requireVersion(records[0].data.version);
  requireVersion(nextVersion);
  const next = nextVersion.split(".").map(Number);
  const previous = current.split(".").map(Number);
  const firstDifference = next.findIndex((part, index) => part !== previous[index]);
  if (firstDifference < 0 || next[firstDifference] < previous[firstDifference]) {
    throw new Error("New version must be greater than " + current + ".");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ||
      Number.isNaN(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error("Provide the release date as YYYY-MM-DD.");
  }

  const writes = records.map(({ path, content, data, root }) => {
    for (const version of root ? [data.version, root.version] : [data.version]) {
      if (version !== current && version !== nextVersion) {
        throw new Error(path + " has an unexpected version (" + version + ").");
      }
    }
    const topLevelVersion = /^([ \t]{2}"version"[ \t]*:[ \t]*")[^"]+"/m;
    const lockRootVersion = /^([ \t]{6}"version"[ \t]*:[ \t]*")[^"]+"/m;
    const replacement = (_, prefix) => prefix + nextVersion + '"';
    let updated = content.replace(topLevelVersion, replacement);
    if (root) updated = updated.replace(lockRootVersion, replacement);
    data.version = nextVersion;
    if (root) root.version = nextVersion;
    if (JSON.stringify(JSON.parse(updated)) !== JSON.stringify(data)) {
      throw new Error("Could not update only the version metadata in " + path + ".");
    }
    return [path, updated];
  });
  for (const path of imageFiles) {
    if (!existsSync(resolve(root, path))) continue;
    const content = read(path);
    const updated = content.replaceAll("a-border-seo:" + current, "a-border-seo:" + nextVersion);
    if (content !== updated) writes.push([path, updated]);
  }
  const log = read(changelog);
  const newline = log.includes("\r\n") ? "\r\n" : "\n";
  const titleEnd = log.indexOf(newline);
  if (titleEnd < 0) throw new Error("Missing title in " + changelog + ".");
  const section = ["", "", "## " + nextVersion + "（" + date + "）", "", notesPlaceholder, "", ""].join(newline);
  writes.push([changelog, log.slice(0, titleEnd) + section + log.slice(titleEnd + newline.length)]);
  for (const [path, content] of writes) writeFileSync(resolve(root, path), content);
  console.log("v" + current + " → v" + nextVersion + ". Complete " + changelog + " before tagging.");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const [action, value, date] = process.argv.slice(2);
    if (action === "check") {
      console.log(assertVersion(value));
    } else if (action === "notes") {
      process.stdout.write(releaseNotes(assertVersion(value)));
    } else if (action === "set") {
      setVersion(value, date);
    } else if (action === "bump" && ["major", "minor", "patch"].includes(value)) {
      const index = ["major", "minor", "patch"].indexOf(value);
      const parts = assertVersion().split(".").map(Number);
      parts[index] += 1;
      parts.fill(0, index + 1);
      setVersion(parts.join("."), date);
    } else {
      throw new Error("Usage: node scripts/version.mjs check [vX.Y.Z] | notes [vX.Y.Z] | set X.Y.Z YYYY-MM-DD | bump major|minor|patch YYYY-MM-DD");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
