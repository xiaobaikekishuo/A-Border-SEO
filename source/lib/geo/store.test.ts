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
    expect(readiness!.checks.filter(c=>c.applicable===0).map(c=>c.key)).toEqual(["SECTIONS","QUESTIONS","FACTS","SCHEMA","AUTHORSHIP","FRESHNESS","SOURCES","RENDERING"]);
    // Without the GEO evidence of newer crawls, the site entity is not judged either.
    expect(readiness!.entity).toMatchObject({status:null,organization:false});
  });
  it("judges freshness, cited sources, rendering and the site entity from new crawl evidence",async()=>{
    const db=testDb.db;
    // Later than the crawl of the test above, so it is the latest one.
    const finishedAt=new Date(Date.now()+60_000);
    const daysBefore=(n:number)=>new Date(finishedAt.getTime()-n*86_400_000).toISOString().slice(0,10);
    await db.crawl.create({data:{id:"v3",siteId:"geo-a",status:"COMPLETED",finishedAt}});
    const report=(signals:Record<string,unknown>)=>({version:2,parsedBlocks:1,findings:[],entities:[{types:["Organization"]}],signals:{author:false,datePublished:false,dateModified:false,organization:true,product:false,reviews:false,faq:false,...signals}});
    const geo=(over:Record<string,unknown>)=>({version:1,sourceLinks:0,sourceHosts:[],jsShell:false,jsReason:null,textUnits:400,published:null,modified:null,...over});
    await db.auditPage.createMany({data:[
      {crawlId:"v3",url:"https://example.com/",statusCode:200,title:"Home",wordCount:400,h1Count:1,internalLinks:3,
        schemaReport:report({organizationLogo:true,organizationSameAs:2,organizationContact:true}),geoSignals:geo({})},
      {crawlId:"v3",url:"https://example.com/blog/fresh",statusCode:200,title:"Fresh",wordCount:400,h1Count:1,internalLinks:3,
        geoSignals:geo({sourceLinks:2,modified:daysBefore(150)})},
      {crawlId:"v3",url:"https://example.com/blog/stale",statusCode:200,title:"Stale",wordCount:400,h1Count:1,internalLinks:3,
        geoSignals:geo({published:daysBefore(700)})},
      {crawlId:"v3",url:"https://example.com/app",statusCode:200,title:"App",wordCount:3,h1Count:0,internalLinks:0,
        geoSignals:geo({jsShell:true,jsReason:"empty_mount",textUnits:3})},
    ]});
    const readiness=await getReadiness(db,"geo-a");
    const check=(key:string)=>readiness!.checks.find(c=>c.key===key);
    // Two article pages: one updated five months before the crawl and citing sources, one two years old citing none.
    expect(check("FRESHNESS")).toEqual({key:"FRESHNESS",passed:1,applicable:2});
    expect(check("SOURCES")).toEqual({key:"SOURCES",passed:1,applicable:2});
    // Every page of a newer crawl is judged for rendering; the empty app shell fails.
    expect(check("RENDERING")).toEqual({key:"RENDERING",passed:3,applicable:4});
    expect(readiness!.entity).toEqual({status:true,organization:true,logo:true,sameAs:2,contact:true,url:"https://example.com/"});
  });
});
