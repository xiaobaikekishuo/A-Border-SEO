import { expect, test } from "@playwright/test";
import { build } from "esbuild";

// Mount the real client components with the app's locale provider and Next links.
// Every browser request is intercepted. onStart records only its local payload.
let script: string;
test.beforeAll(async () => {
  const bundle = await build({
    absWorkingDir: process.cwd(), bundle: true, write: false, platform: "browser", format: "iife",
    outfile: "report-preview.js", jsx: "automatic", loader: { ".css": "local-css" },
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import { useState } from "react";
      import { createRoot } from "react-dom/client";
      import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
      import { I18nProvider } from "./lib/i18n/client";
      import { ReportTask, ReportActions } from "./components/ai-workbench/report-task";
      const siteId = "report-fixture";
      const url = "https://paper.test/guide";
      const sources = [{ref:"performance:1", source:"performance", url}, {ref:"alerts:1", source:"alerts", url:null}];
      const actions = [{title:"Review mobile rendering", reason:"Slow mobile sample", nextStep:"Compare images", verify:"Retest", evidenceRefs:["performance:1"]}];
      function Harness() {
        const [submissions, setSubmissions] = useState([]);
        return <AppRouterContext.Provider value={{refresh(){}}}>
          <I18nProvider initialLocale={document.documentElement.lang === "zh" ? "zh" : "en"}>
            <ReportTask siteId={siteId} scope="weekly" disabled={false} busy={false} rejectedRevision={null}
              onStart={async payload => setSubmissions(s => [...s, payload])} />
            <output data-testid="submissions">{JSON.stringify(submissions)}</output>
            <ReportActions siteId={siteId} sources={sources} actions={actions}/>
          </I18nProvider>
        </AppRouterContext.Provider>;
      }
      createRoot(document.getElementById("root")).render(<Harness/>);
    ` },
  });
  script = bundle.outputFiles.find(f => f.path.endsWith(".js"))!.text;
});

for (const language of ["zh", "en"] as const) {
  test(`report preview reads evidence before one explicit generation in ${language}`, async ({ page }) => {
    const zh = language === "zh";
    const origin = "http://127.0.0.1:3210";
    const path = "/api/sites/report-fixture/assistant/action-evidence?scope=weekly";
    const revision = "b".repeat(64);
    const observed: string[] = [];
    let hasData = false;
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && url.pathname === "/report-fixture") {
        await route.fulfill({ contentType: "text/html", body: `<html lang="${language}"><body><div id="root"></div></body></html>` });
        return;
      }
      observed.push(route.request().method() + " " + url.origin + url.pathname + url.search);
      if (url.href !== origin + path || route.request().method() !== "GET") { await route.abort(); return; }
      await route.fulfill({ json: { site: { id: "report-fixture", domain: "paper.test" }, scope: "weekly", revision, hasData,
        period: { start: "2026-11-09", end: "2026-11-15", previousStart: "2026-11-02", previousEnd: "2026-11-08" },
        sections: [{ source: "performance", rows: hasData ? [{ kind: "performanceSample", url: "https://paper.test/guide", lcpSeconds: 3.5, inpMs: null }] : [] }] } });
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin + "/report-fixture");
    await page.addScriptTag({ content: script });
    await expect.poll(() => page.locator("h2").count().then(n => errors.length ? errors.join("\n") : n)).toBe(1);
    const generate = page.getByRole("button", { name: zh ? "使用账号额度生成" : "Generate with my account" });
    const submissions = page.getByTestId("submissions");
    await expect(page.getByRole("heading", { name: zh ? "本周行动清单" : "Weekly action list" })).toBeVisible();
    await expect(page.getByText(zh ? "暂无记录" : "No saved data", { exact: true })).toBeVisible();
    await expect(generate).toBeDisabled();
    await expect(submissions).toHaveText("[]");
    hasData = true;
    await page.getByRole("button", { name: zh ? "刷新依据" : "Refresh evidence" }).click();
    await expect(generate).toBeEnabled();
    await page.locator("summary").click();
    await expect(page.getByText("performance:1", { exact: true })).toBeVisible();
    await expect(page.getByText(zh ? "未知" : "Unknown", { exact: true })).toBeVisible();
    await expect(page.getByText("3.5", { exact: true })).toBeVisible();
    await page.getByRole("textbox").fill("Prioritize mobile");
    await expect(submissions).toHaveText("[]");
    await generate.click();
    await expect(submissions).not.toHaveText("[]");
    expect(JSON.parse(await submissions.innerText())).toEqual([{ title: zh ? "本周行动清单" : "Weekly action list", instructions: "Prioritize mobile",
      language: zh ? "zh-CN" : "en", actionScope: "weekly", evidenceRevision: revision }]);
    const links = page.locator("ol li a");
    await expect(links).toHaveCount(2);
    await expect(links.first()).toHaveAttribute("href", "/sites/report-fixture/vitals");
    await expect(links.last()).toHaveAttribute("href", "/sites/report-fixture/assistant?url=https%3A%2F%2Fpaper.test%2Fguide");
    expect(observed).toEqual(["GET " + origin + path, "GET " + origin + path]);
  });
}
