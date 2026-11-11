import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";

// Static guards for the fixed dark palette, readable controls and brand fonts.
// Browser checks under both OS preferences remain in e2e/light-only.e2e.ts.

const root = resolve(__dirname, "..");
const css = readFileSync(join(root, "app/globals.css"), "utf8");
const layout = readFileSync(join(root, "app/layout.tsx"), "utf8");
const manifest = readFileSync(join(root, "app/manifest.ts"), "utf8");
const fonts = readFileSync(join(root, "app/fonts.ts"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css|svg)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Value of a custom property declared in globals.css, following var() references. */
function token(name: string): string {
  const match = css.match(new RegExp(`\\s${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`${name} is not declared`);
  const value = match[1].trim();
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  return ref ? token(ref[1]) : value;
}

function luminance(hex: string): number {
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) throw new Error(`Expected an opaque hex token, received ${hex}`);
  const expanded = hex.length === 4 ? hex.slice(1).split("").map((part) => part + part).join("") : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(expanded.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("fixed dark theme", () => {
  it("selects dark before first paint without an OS-dependent theme override", () => {
    expect(layout).toMatch(/<html\b[^>]*className=["'][^"']*\bdark\b/);
    for (const file of [...sourceFiles(join(root, "app")), ...sourceFiles(join(root, "components"))]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/prefers-color-scheme:\s*(?:light|dark)/);
      expect(text, file).not.toMatch(/classList\.(remove|toggle)\(\s*["']dark/);
    }
  });

  it("uses dark native controls and a matching browser and installed-app background", () => {
    expect(css).toMatch(/html\s*\{[^}]*color-scheme:\s*dark/);
    expect(layout).toMatch(/colorScheme:\s*"dark"/);
    expect(layout).toMatch(/themeColor:\s*"#080e1c"/i);
    expect(manifest).toMatch(/theme_color:\s*"#080e1c"/i);
    expect(manifest).toMatch(/background_color:\s*"#080e1c"/i);
  });

  it("paints the body and cards with the navy palette", () => {
    expect(css).toMatch(/body\s*\{[^}]*bg-background/);
    expect(token("--background").toLowerCase()).toBe("#080e1c");
    expect(token("--card").toLowerCase()).toBe("#101a2d");
    expect(token("--primary").toLowerCase()).toBe("#6d5ce8");
  });

  it("keeps text, primary controls, state labels and chart marks readable on dark surfaces", () => {
    for (const surface of ["--background", "--card", "--bg-soft"]) {
      for (const text of ["--foreground", "--text-strong", "--muted-foreground"]) {
        expect(contrast(token(text), token(surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const background of ["--primary", "--button-primary-hover"]) {
      expect(contrast(token("--primary-foreground"), token(background)), `primary label on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const state of ["success", "warning", "danger"]) {
      expect(contrast(token(`--${state}`), token(`--${state}-bg`)), `${state} label`).toBeGreaterThanOrEqual(4.5);
    }
    expect(token("--chart-1")).not.toBe(token("--chart-2"));
    for (const series of ["--chart-1", "--chart-2"]) {
      expect(contrast(token(series), token("--card")), `${series} on card`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("fonts", () => {
  /** The localFont({...}) calls in app/fonts.ts. */
  const calls = [...fonts.matchAll(/localFont\(\{([\s\S]*?)\n\}\);/g)].map((m) => m[1]);
  const files = calls.map((call) => call.match(/fonts\/([\w-]+)\.woff2/)?.[1]);

  it("self-hosts both fonts with next/font/local, nothing from Google at build time", () => {
    for (const file of [...sourceFiles(join(root, "app")), ...sourceFiles(join(root, "components"))]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from "next\/font\/google"/);
    }
    expect(layout).toMatch(/^import "\.\/fonts";$/m);
    expect(calls).toHaveLength(13);
    expect(fonts.match(/^export const \w+ = localFont\(/gm)).toHaveLength(13);
    for (const call of calls) {
      const src = call.match(/src: "\.\/(fonts\/[\w-]+\.woff2)"/)?.[1];
      expect(src && existsSync(join(root, "app", src)), call).toBe(true);
      expect(call).toMatch(/prop: "font-family", value: "(Inter|'Geist Mono')"/);
      expect(call).toMatch(/prop: "unicode-range", value: "U\+/);
    }
    // Only latin is preloaded, as next/font/google did with subsets: ["latin"].
    const preloaded = calls.filter((call) => !/preload: false/.test(call));
    expect(preloaded.map((call) => call.match(/fonts\/([\w-]+)\.woff2/)?.[1])).toEqual([
      "inter-latin",
      "geist-mono-latin",
    ]);
    // Latin is declared last in each family, as Google orders it: where
    // unicode-ranges overlap, the last face wins.
    expect(files.indexOf("inter-latin")).toBe(files.filter((f) => f?.startsWith("inter-")).length - 1);
    expect(files.at(-1)).toBe("geist-mono-latin");
    expect(existsSync(join(root, "app/fonts/Inter-OFL.txt"))).toBe(true);
    expect(existsSync(join(root, "app/fonts/GeistMono-OFL.txt"))).toBe(true);
  });

  it("names the families and their metric-matched fallbacks", () => {
    expect(token("--font-inter")).toBe('"Inter", "Inter Fallback"');
    expect(token("--font-geist-mono")).toBe('"Geist Mono", "Geist Mono Fallback"');
    expect(css).toMatch(/@font-face\s*\{\s*font-family: "Inter Fallback";\s*src: local\("Arial"\);/);
    expect(css).toMatch(/@font-face\s*\{\s*font-family: "Geist Mono Fallback";\s*src: local\("Arial"\);/);
  });

  it("maps the theme fonts to those variables with sans and monospace fallbacks", () => {
    expect(css).toMatch(/--font-sans:\s*var\(--font-inter\),[^;]*\bsans-serif;/);
    expect(css).toMatch(/--font-mono:\s*var\(--font-geist-mono\),[^;]*\bmonospace;/);
    expect(css).toMatch(/html\s*\{[^}]*font-sans/);
  });
});
