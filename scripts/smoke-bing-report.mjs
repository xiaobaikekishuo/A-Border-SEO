import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

/** Only the disposable registration-smoke database may run these fixtures. */
export async function runBingReportSmoke({ local, cookie, siteId, dbScript, origin, directory, report, check }) {
  assert.equal(origin, "http://127.0.0.1:18330");
  assert.match(path.basename(directory), /^aborder-registration-smoke-[a-z0-9]+$/);
  const route = `/sites/${siteId}/bing`;
  const englishCookie = cookie + "; aborder-locale=en";
  const quotedId = JSON.stringify(siteId);
  const fixtureId = "bing-report-" + randomBytes(8).toString("hex");
  const foreignKeyword = fixtureId + "-FOREIGN-PRIVATE-QUERY";
  let keyId, foreignUserId, schedulerSaved, seeded = false, browser, page;
  const fixtureDb = source => dbScript(`
    const database = await db.$queryRawUnsafe('SELECT current_database() AS name');
    if (database[0]?.name !== 'fixture') throw new Error('Bing smoke requires the isolated fixture database');
    const ownedSite = await db.site.findUniqueOrThrow({where:{id:${quotedId}}});
    if (ownedSite.domain !== 'example.com') throw new Error('Unexpected Bing fixture site');
    ${source}
  `);
  const assertPage = async (needle, expectedRoute = route) => {
    const response = await local(expectedRoute, undefined, englishCookie);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert(html.includes(needle), `Bing page missing expected state: ${needle}`);
    assert(!html.includes(foreignKeyword));
    return html;
  };

  try {
    const initial = await fixtureDb(`
      console.log(JSON.stringify({keyCount:await db.apiKey.count({where:{userId:ownedSite.userId,provider:'bing'}}),
        bound:ownedSite.bingSite !== null, daily:await db.bingDaily.count({where:{siteId:ownedSite.id}}),
        weekly:await db.bingSearchWeekly.count({where:{siteId:ownedSite.id}})}));
    `);
    assert.deepEqual(initial, { keyCount: 0, bound: false, daily: 0, weekly: 0 });
    await assertPage("Connect Bing Webmaster Tools");
    const unauthenticated = await local(route);
    assert.equal(new URL(unauthenticated.url).pathname, "/login");

    // Prevent the real fixture worker from scheduling a sync while the fake key
    // and property are present. The fake value cannot be decrypted as a key.
    const prepared = await fixtureDb(`
      const scheduler = await db.schedulerState.findUnique({where:{key:'lastRunAt'}});
      await db.schedulerState.upsert({where:{key:'lastRunAt'},create:{key:'lastRunAt',at:new Date(Date.now()+86400000)},
        update:{at:new Date(Date.now()+86400000)}});
      const key=await db.apiKey.create({data:{userId:ownedSite.userId,provider:'bing',encryptedPassword:'FIXTURE_NOT_AN_ENCRYPTED_BING_KEY'}});
      console.log(JSON.stringify({keyId:key.id,schedulerAt:scheduler?.at?.toISOString()??null}));
    `);
    keyId = prepared.keyId; schedulerSaved = prepared.schedulerAt;
    await assertPage("Choose this site&#x27;s Bing property").catch(async () => {
      // React may emit the apostrophe as a literal or a numeric entity.
      const html = await assertPage("Bing property");
      assert(html.includes("Your account connection is saved."));
    });
    await fixtureDb(`await db.site.update({where:{id:ownedSite.id},data:{bingSite:'https://example.com/'}});console.log('{}');`);
    await assertPage("No Bing data in this period");
    check("Bing report protects anonymous access and distinguishes missing key, unbound site, and bound site without data");

    const fixture = await fixtureDb(`
      const today=new Date();today.setUTCHours(0,0,0,0);
      const day=n=>new Date(today.getTime()-n*86400000);
      const daily=[];
      for(let i=1;i<=42;i++) {
        if(i===7)continue;
        daily.push({siteId:ownedSite.id,date:day(i),clicks:i===2?0:10+i%11,impressions:i===2?0:200+i*9,
          crawledPages:20+i%17,inIndex:i===3?null:200+42-i,crawlErrors:i%13===0?1:0,
          blockedByRobots:0,code4xx:i%13===0?1:0,code5xx:0});
      }
      await db.bingDaily.createMany({data:daily});
      const friday=day(1);while(friday.getUTCDay()!==5)friday.setUTCDate(friday.getUTCDate()-1);
      const weekly=[];
      for(let w=0;w<3;w++) {
        const weekEnding=new Date(friday.getTime()-w*7*86400000);
        for(let i=0;i<24;i++) {
          weekly.push({siteId:ownedSite.id,kind:'query',key:'fixture query '+String(i).padStart(2,'0'),weekEnding,
            clicks:i===0?0:1+i,impressions:100+i*20,avgImpressionPosition:i===1?null:2+i/2});
          weekly.push({siteId:ownedSite.id,kind:'page',key:'https://example.com/report-page-'+i,weekEnding,
            clicks:i+2,impressions:80+i*10,avgImpressionPosition:3+i/4});
        }
      }
      await db.bingSearchWeekly.createMany({data:weekly});
      const job=await db.job.create({data:{id:${JSON.stringify(fixtureId)},siteId:ownedSite.id,type:'bing-sync',status:'SUCCEEDED',source:'manual',maxAttempts:1,
        startedAt:new Date(),finishedAt:new Date(),result:{success:true,daysUpserted:daily.length,queriesUpserted:72,pagesUpserted:72}}});
      const foreign=await db.user.create({data:{email:${JSON.stringify(fixtureId + "@fixture.invalid")},name:'Isolated foreign owner'}});
      const other=await db.site.create({data:{userId:foreign.id,domain:'foreign.example.test',bingSite:'https://foreign.example.test/'}});
      await db.bingSearchWeekly.create({data:{siteId:other.id,kind:'query',key:${JSON.stringify(foreignKeyword)},weekEnding:friday,
        clicks:999999,impressions:999999,avgImpressionPosition:1}});
      console.log(JSON.stringify({foreignUserId:foreign.id,foreignSiteId:other.id,dailyRows:daily.length,queryRows:72,pageRows:72,
        zeroDay:day(2).toISOString().slice(0,10),gapDay:day(7).toISOString().slice(0,10)}));
    `);
    seeded = true; foreignUserId = fixture.foreignUserId;
    await assertPage("fixture query 23");
    const denied = await local(`/sites/${fixture.foreignSiteId}/bing`, undefined, englishCookie);
    assert.equal(new URL(denied.url).pathname, "/sites");
    assert(!(await denied.text()).includes(foreignKeyword));
    check("Seeded isolated Bing report renders daily and weekly data; a different owner's report redirects without leaking its private query");

    const { chromium, expect } = await import(new URL("../source/node_modules/@playwright/test/index.mjs", import.meta.url).href);
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
    const separator = cookie.indexOf("=");
    await context.addCookies([
      { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: origin, httpOnly: true, sameSite: "Lax" },
      { name: "aborder-locale", value: "en", url: origin, sameSite: "Lax" },
    ]);
    let externalRequests = 0, mockedSyncRequests = 0;
    await context.route("**/*", async request => {
      const url = new URL(request.request().url());
      if (url.origin !== origin) { externalRequests++; return request.abort("blockedbyclient"); }
      // A mistaken test click can never reach the actual Bing synchronization route.
      if (url.pathname === "/api/bing/sync") {
        mockedSyncRequests++;
        return request.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "isolated_sync_failure" }) });
      }
      if (url.pathname === "/api/bing/sites") return request.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return request.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(origin + route, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Bing reports", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Bing reports", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "28 days", exact: true })).toHaveAttribute("aria-current", "page");
    const clicksChart = page.getByRole("img", { name: /^Daily Bing clicks:/ });
    await expect(clicksChart).toBeVisible();
    assert(await clicksChart.locator("path[data-bing-series]").count() >= 2, "A missing day must create a chart gap");
    await expect(clicksChart.locator("circle title").filter({ hasText: fixture.zeroDay + ": 0" })).toHaveCount(1);
    await expect(clicksChart.locator("circle title").filter({ hasText: fixture.gapDay })).toHaveCount(0);
    const table = page.getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(16);
    await expect(table.getByRole("cell", { name: "fixture query 23", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(table.getByRole("row")).toHaveCount(10);
    await page.getByRole("button", { name: "Previous", exact: true }).click();
    await page.getByRole("searchbox", { name: "Filter Bing queries", exact: true }).fill("query 03");
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(table.getByRole("cell", { name: "fixture query 03", exact: true })).toBeVisible();
    await page.getByRole("searchbox", { name: "Filter Bing queries", exact: true }).fill("");
    await table.getByRole("button", { name: "Avg. position", exact: true }).click();
    // Inspect the real table markup rather than relying on the browser's
    // implicit accessibility role for a sorted <th>.
    await expect(table.locator("thead th").nth(4)).toHaveAttribute("aria-sort", "ascending");
    await expect(table.locator("tbody tr").first().locator("td").first()).toHaveText("fixture query 00");
    await page.getByRole("button", { name: "Pages", exact: true }).click();
    await expect(page.getByRole("searchbox", { name: "Filter Bing pages", exact: true })).toBeVisible();
    await page.getByRole("searchbox", { name: "Filter Bing pages", exact: true }).fill("report-page-4");
    await expect(table.getByRole("cell", { name: "https://example.com/report-page-4", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Keywords", exact: true }).click();
    await page.getByRole("link", { name: "90 days", exact: true }).click();
    await expect(page).toHaveURL(origin + route + "?days=90");
    await expect(page.getByRole("link", { name: "90 days", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("img", { name: /^Daily Bing clicks:/ })).toHaveAttribute("aria-label", /41 reported days/);
    await page.getByRole("group", { name: "Traffic metric", exact: true }).getByRole("button", { name: "Impressions", exact: true }).click();
    await expect(page.getByRole("img", { name: /^Daily Bing impressions:/ })).toBeVisible();
    await page.screenshot({ path: path.join(directory, "bing-report-desktop.png"), fullPage: true });
    check("Isolated Chrome verifies Bing charts, observed zeros versus missing days, 28/90-day navigation, query/page tables, search, sort and pagination");

    await page.getByRole("button", { name: "Sync Bing", exact: true }).click();
    await expect(page.getByText("Sync is paused. Check account access and workspace maintenance status.", { exact: true })).toBeVisible();
    assert.equal(mockedSyncRequests, 1);
    // Persisted partial and failed jobs are seeded locally, never submitted to Bing.
    await fixtureDb(`await db.job.update({where:{id:${JSON.stringify(fixtureId)}},data:{result:{success:true,partial:['crawl','queries']}}});console.log('{}');`);
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByText(/The latest sync did not update:/)).toBeVisible();
    await page.screenshot({ path: path.join(directory, "bing-report-partial.png"), fullPage: true });
    await fixtureDb(`await db.job.update({where:{id:${JSON.stringify(fixtureId)}},data:{status:'FAILED',result:null,errorCode:'KEY_MISSING',lastError:'PRIVATE_FIXTURE_ERROR_DO_NOT_RENDER'}});console.log('{}');`);
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByText("The latest Bing sync failed. Stored data remains visible. Check the connection and try syncing again.", { exact: true })).toBeVisible();
    assert(!(await page.locator("body").innerText()).includes("PRIVATE_FIXTURE_ERROR_DO_NOT_RENDER"));
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileWidth = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    assert(mobileWidth.content <= mobileWidth.viewport + 1, `Bing report overflows the mobile viewport (${mobileWidth.content}/${mobileWidth.viewport})`);
    await page.screenshot({ path: path.join(directory, "bing-report-mobile.png"), fullPage: true });
    await context.addCookies([{ name: "aborder-locale", value: "zh", url: origin, sameSite: "Lax" }]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Bing 报表", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "搜索表现明细", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(directory, "bing-report-zh.png"), fullPage: true });
    assert.equal(externalRequests, 0, "Bing report browser must not attempt any external requests");
    check("Bing report displays stored partial/failed sync states, hides raw errors, handles a mocked sync rejection, fits a 390px viewport and renders Chinese labels");
    report.bing = { isolatedFixtures: true, externalRequests, syncInteraction: "mocked HTTP 503, no Bing API call", ...fixture,
      screenshots: ["bing-report-desktop.png", "bing-report-partial.png", "bing-report-mobile.png", "bing-report-zh.png"] };
  } catch (error) {
    // Only capture the disposable local fixture. No browser cookies or other
    // authentication material is written to these diagnostics.
    if (page && !page.isClosed() && new URL(page.url()).origin === origin) {
      try {
        const diagnostic = {
          pathname: new URL(page.url()).pathname,
          tableHeaders: await page.getByRole("table").locator("th").allTextContents(),
          headings: await page.locator("body h1, body h2, body h3").allTextContents(),
          htmlLanguage: await page.locator("html").getAttribute("lang"),
          sortedHeaders: await page.locator("table th[aria-sort]").evaluateAll(nodes => nodes.map(node => ({
            text: node.textContent, sort: node.getAttribute("aria-sort"),
          }))),
        };
        writeFileSync(path.join(directory, "bing-report-failure.html"), await page.content());
        writeFileSync(path.join(directory, "bing-report-failure.json"), JSON.stringify(diagnostic, null, 2));
        await page.screenshot({ path: path.join(directory, "bing-report-failure.png"), fullPage: true });
        console.error("Isolated Bing page diagnostic: " + JSON.stringify(diagnostic));
      } catch (diagnosticError) {
        console.error("Could not capture isolated Bing page diagnostics: " + diagnosticError.name);
      }
    }
    throw error;
  } finally {
    await browser?.close();
    if (keyId) await fixtureDb(`
      await db.apiKey.deleteMany({where:{id:${JSON.stringify(keyId)},userId:ownedSite.userId,provider:'bing'}});
      await db.site.update({where:{id:ownedSite.id},data:{bingSite:null}});
      ${seeded ? `await db.bingDaily.deleteMany({where:{siteId:ownedSite.id}});await db.bingSearchWeekly.deleteMany({where:{siteId:ownedSite.id}});` : ""}
      await db.job.deleteMany({where:{id:${JSON.stringify(fixtureId)},siteId:ownedSite.id,type:'bing-sync'}});
      ${foreignUserId ? `await db.user.deleteMany({where:{id:${JSON.stringify(foreignUserId)},email:${JSON.stringify(fixtureId + "@fixture.invalid")}}});` : ""}
      ${schedulerSaved ? `await db.schedulerState.update({where:{key:'lastRunAt'},data:{at:new Date(${JSON.stringify(schedulerSaved)})}});`
        : "await db.schedulerState.deleteMany({where:{key:'lastRunAt'}});"}
      console.log('{}');
    `);
  }
}
