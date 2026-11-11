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
    expect(background, `${colorScheme} OS preference`).toBe("rgb(8, 14, 28)");
    expect(scheme).toBe("dark");
    expect(htmlClass).toMatch(/\bdark\b/);
  }
});

test("body text is Inter and mono labels are Geist Mono", async ({ page }) => {
  await page.goto("/login");
  await page.evaluate(() => document.fonts.ready);

  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(bodyFont).toMatch(/^"?Inter"?,/);
  expect(bodyFont).toMatch(/sans-serif$/);

  // The sign-in button label uses mono-button; a mono-label span uses the same family.
  const buttonFont = await page
    .getByRole("button", { name: "Continue with Google" })
    .evaluate((el) => getComputedStyle(el).fontFamily);
  expect(buttonFont).toMatch(/^"?Geist Mono"?,/);

  const labelFont = await page.evaluate(() => {
    const span = document.createElement("span");
    span.className = "mono-label";
    span.textContent = "Label";
    document.body.append(span);
    const family = getComputedStyle(span).fontFamily;
    span.remove();
    return family;
  });
  expect(labelFont).toMatch(/^"?Geist Mono"?,/);
  expect(labelFont).toMatch(/monospace$/);

  // The fonts actually loaded, not just named.
  const loaded = await page.evaluate(() => ({
    inter: document.fonts.check('16px "Inter"'),
    mono: document.fonts.check('12px "Geist Mono"'),
  }));
  expect(loaded).toEqual({ inter: true, mono: true });
});
