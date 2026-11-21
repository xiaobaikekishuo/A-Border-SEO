import { readFileSync } from "fs";
import { join } from "path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { SKILLS, skillByName, skillMarkdown } from "./catalog";
import { SKILLS_README, skillsDownload } from "./package";
import { zipFiles } from "./zip";

/** The MCP tool names, read from the package's source: the skills must call tools that exist. */
function toolNames(): string[] {
  const source = readFileSync(join(__dirname, "../../packages/mcp/src/tools.ts"), "utf8");
  const list = source.match(/export const TOOL_NAMES = \[([\s\S]*?)\] as const/)?.[1] ?? "";
  return [...list.matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
}

/** The entries of a zip, read from its central directory. */
function unzip(bytes: Buffer): { path: string; data: Buffer; crcOk: boolean }[] {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const out: { path: string; data: Buffer; crcOk: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
    const crc = bytes.readUInt32LE(at + 16);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const local = bytes.readUInt32LE(at + 42);
    const path = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    out.push({ path, data, crcOk: (crc32(data) >>> 0) === crc });
    at += 46 + nameLength;
  }
  return out;
}

describe("skills", () => {
  it("have valid, unique names and descriptions that say when to use them", () => {
    const names = SKILLS.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const skill of SKILLS) {
      expect(skill.name).toMatch(/^aborder-[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(skill.name.length).toBeLessThanOrEqual(64);
      expect(skill.description.length).toBeGreaterThan(40);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
      expect(skill.description).not.toMatch(/[<>]/);
      expect(skillByName(skill.name)).toBe(skill);
    }
  });

  it("call only MCP tools that exist, starting from list_sites", () => {
    const tools = new Set(toolNames());
    expect(tools.has("get_rankings")).toBe(true);
    for (const skill of SKILLS) {
      const named = [...skill.body.matchAll(/`((?:get|list)_[a-z_]+)\(/g)].map(m => m[1]);
      expect(named.length).toBeGreaterThan(0);
      for (const tool of named) expect(tools.has(tool), `${skill.name} names ${tool}`).toBe(true);
      expect(skill.body).toContain("`list_sites`");
    }
  });

  it("render as SKILL.md with front matter and no em dashes", () => {
    for (const skill of SKILLS) {
      const md = skillMarkdown(skill);
      const [, front, body] = md.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/) ?? [];
      expect(front.split("\n")[0]).toBe(`name: ${skill.name}`);
      expect(JSON.parse(front.split("\n")[1].replace(/^description: /, ""))).toBe(skill.description);
      expect(body.startsWith("# ")).toBe(true);
      expect(md).not.toMatch(/[\u2014\u2015]/);
    }
    expect(SKILLS_README).not.toMatch(/[\u2014\u2015]/);
  });
});

describe("skill downloads", () => {
  it("zip every skill with a README, or one skill on its own", () => {
    const all = skillsDownload(null)!;
    expect(all.filename).toBe("a-border-seo-skills.zip");
    const entries = unzip(all.bytes);
    expect(entries.map(e => e.path)).toEqual(["README.md", ...SKILLS.map(s => `${s.name}/SKILL.md`)]);
    expect(entries.every(e => e.crcOk)).toBe(true);
    expect(entries[1].data.toString("utf8")).toBe(skillMarkdown(SKILLS[0]));

    const one = skillsDownload("aborder-rank-review")!;
    expect(one.filename).toBe("aborder-rank-review.zip");
    expect(unzip(one.bytes).map(e => e.path)).toEqual(["aborder-rank-review/SKILL.md"]);
    expect(skillsDownload("../etc/passwd")).toBeNull();
  });

  it("gives the same bytes every time and refuses unsafe paths", () => {
    expect(skillsDownload(null)!.bytes.equals(skillsDownload(null)!.bytes)).toBe(true);
    for (const path of ["../x", "/abs", "a//b", "a/../b", "名字.md"]) {
      expect(() => zipFiles([{ path, data: Buffer.from("x") }])).toThrow("Unsafe path");
    }
  });
});
