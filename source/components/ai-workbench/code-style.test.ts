import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import { describe, expect, it } from "vitest";

// The AI workbench screens are formatted with Prettier (source/.prettierrc.json, printWidth 140), so a
// review shows one change per line. Prettier never splits a string, so a line may run past 160 characters
// only when it is a single string (a long message). After an edit, format the file again:
//   npx prettier@3 --write components/ai-workbench/<file>.tsx

const root = resolve(__dirname, "../..");
const MAX = 160;
const RESEARCH_AI = [
  "keyword-ai-panel.tsx",
  "research-ai-panel.tsx",
  "keyword-ai-model.ts",
  "research-ai-model.ts",
  "research-prompt-presets.tsx",
  "research-messages.ts",
  "use-research-input.ts",
].map(name => join(root, "components/research", name));
const LONE_STRING = /^\s*(`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*[,;)\]}]*\s*$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

export function longLines(source: string): number[] {
  return source.split("\n").flatMap((line, index) => (line.length > MAX && !LONE_STRING.test(line) ? [index + 1] : []));
}

describe("code style of the AI workbench screens", () => {
  it("keeps lines short enough to review, except single long messages", () => {
    const files = [...sourceFiles(join(root, "components/ai-workbench")), ...RESEARCH_AI];
    const hits = files.flatMap(file => longLines(readFileSync(file, "utf8")).map(line => `${relative(root, file)}:${line}`));
    expect(hits).toEqual([]);
  });

  it("tells a long message from a long line of code", () => {
    // Prettier puts a string that does not fit on a line of its own.
    expect(longLines(`    "${"x".repeat(170)}",`)).toEqual([]);
    expect(longLines(`      \`${"x".repeat(170)}\`,`)).toEqual([]);
    expect(longLines(`  t("${"x".repeat(170)}"),`)).toEqual([1]);
    expect(longLines(`  const a = { b: "${"x".repeat(170)}" };`)).toEqual([1]);
    expect(longLines(`ok\n<p className="x">{t("${"x".repeat(80)}", "${"x".repeat(80)}")}</p>`)).toEqual([2]);
  });
});
