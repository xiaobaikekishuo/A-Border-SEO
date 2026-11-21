import { expect, test } from "@playwright/test";

// The app uses a fixed dark theme with Inter and Geist Mono. /login is public
// and loads the same root layout and globals.css as every other page.

test.use({ colorScheme: "dark" });

test("both OS preferences render the fixed dark UI", async ({ page }) => {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/login");
    const { background, scheme, htmlClass } = await page.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      htmlClass: document.documentElement.className,
    }));
    expect(background, `${colorScheme} OS preference`).toBe("rgb(11, 13, 17)");
    expect(scheme).toBe("dark");
    expect(htmlClass).toMatch(/\bdark\b/);
  }
});

test("login text uses Inter and the code font is Geist Mono", async ({ page }) => {
  await page.goto("/login");
  await page.evaluate(() => document.fonts.ready);

  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(bodyFont).toMatch(/^"?Inter"?,/);
  expect(bodyFont).toMatch(/sans-serif$/);

  // Action and data labels use the text face. Code retains the monospace face.
  const buttonFont = await page
    .getByRole("button", { name: /Continue with Google|使用 Google 继续/ })
    .evaluate((el) => getComputedStyle(el).fontFamily);
  expect(buttonFont).toBe(bodyFont);

  const labelFont = await page.evaluate(() => {
    const span = document.createElement("span");
    span.className = "mono-label";
    span.textContent = "Label";
    document.body.append(span);
    const family = getComputedStyle(span).fontFamily;
    span.remove();
    return family;
  });
  expect(labelFont).toBe(bodyFont);

  // The fonts actually loaded, not just named.
  const loaded = await page.evaluate(async () => ({
    inter: (await document.fonts.load('16px "Inter"')).length > 0,
    mono: (await document.fonts.load('12px "Geist Mono"')).length > 0,
  }));
  expect(loaded).toEqual({ inter: true, mono: true });
});
