import { afterAll,beforeAll,describe,expect,it } from "vitest";
import {createTestDb, type TestDb} from "@/lib/testing/pglite";
import {saveGeoImport,saveGaSnapshot,readGeoWorkspace} from "./store";
import {getReadiness} from "./readiness";
let testDb:TestDb;
beforeAll(async () => {
  testDb=await createTestDb();
  await testDb.db.user.createMany({data:[{id:"owner",email:"geo@local.test"},{id:"other",email:"other@local.test"}]});
  await testDb.db.site.create({data:{id:"geo-a",userId:"owner",domain:"example.com"}});
},120000);
afterAll(async()=>{await testDb?.close()});
const body={kind:"GA4",source:"GA4_CSV",rows:[{day:"2026-11-01",platform:"ChatGPT",path:"/guide",count:13}],processed:1,skipped:0,expectedUpdatedAt:null};
describe("owned aggregate measurements",()=>{
  it("requires site ownership and prevents replacing a newer import or labelling a file as live API data",async()=>{
    const db=testDb.db;
    await expect(readGeoWorkspace(db,"other","geo-a")).rejects.toMatchObject({status:404});
    await expect(saveGeoImport(db,"other","geo-a",body)).rejects.toMatchObject({status:404});
    await expect(saveGeoImport(db,"owner","geo-a",{...body,source:"GA4_API"})).rejects.toThrow();
    const fresh=await saveGeoImport(db,"owner","geo-a",body);
    expect(fresh.snapshots.GA4?.rows[0].count).toBe(13);
    expect(fresh.snapshots.BOT).toBeNull();
    await expect(saveGeoImport(db,"owner","geo-a",body)).rejects.toMatchObject({status:409});
    await expect(saveGeoImport(db,"owner","geo-a",{...body,rows:[{...body.rows[0],path:"/guide?secret=value"}]})).rejects.toThrow();
    const empty=await saveGaSnapshot(db,"owner","geo-a",{rows:[],start:"2026-11-01",end:"2026-11-01",processed:0,skipped:0,notes:[],expectedUpdatedAt:fresh.snapshots.GA4!.updatedAt});
    expect(empty.snapshots.GA4).toMatchObject({source:"GA4_API",rows:[],end:"2026-11-01"});
    await expect(saveGeoImport(db,"owner","geo-a",{...body,expectedUpdatedAt:fresh.snapshots.GA4!.updatedAt})).rejects.toMatchObject({status:409});
  });
  it("scores only saved eligible pages and leaves missing evidence unknown",async()=>{
    const db=testDb.db;
    expect(await getReadiness(db,"geo-a")).toBeNull();
    await db.crawl.create({data:{id:"sample",siteId:"geo-a",status:"COMPLETED",finishedAt:new Date()}});
    await db.auditPage.createMany({data:[
      {crawlId:"sample",url:"https://example.com/a",statusCode:200,title:"A",wordCount:100,h1Count:1,internalLinks:0},
      {crawlId:"sample",url:"https://example.com/private",statusCode:200,indexable:false}
    ]});
    // Title without a description, one H1, 100 words, no internal links: 1 of 4 judged checks passes.
    const readiness=await getReadiness(db,"geo-a");
    expect(readiness).toMatchObject({total:1,sampled:1,sampling:"URL_ORDER",rankedPages:0,score:25});
    expect(readiness!.checks.find(c=>c.key==="HEADING")).toEqual({key:"HEADING",passed:1,applicable:1});
    expect(readiness!.checks.find(c=>c.key==="SNIPPET")).toEqual({key:"SNIPPET",passed:0,applicable:1});
    // No article text or schema was saved, so those checks stay unjudged rather than failed.
    expect(readiness!.checks.filter(c=>c.applicable===0).map(c=>c.key)).toEqual(["SECTIONS","QUESTIONS","FACTS","SCHEMA","AUTHORSHIP"]);
  });
});
