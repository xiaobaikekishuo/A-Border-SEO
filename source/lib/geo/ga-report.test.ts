import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentError } from "@/lib/content-planner/http";

const calls = vi.hoisted(() => ({fetch:vi.fn(),auth:vi.fn(),owned:vi.fn(),save:vi.fn()}));
vi.mock("@/lib/google/google-fetch",() => ({googleFetch:calls.fetch}));
vi.mock("@/lib/auth",() => ({auth:calls.auth}));
vi.mock("@/lib/db",() => ({db:{}}));
vi.mock("@/lib/geo/store",() => ({ownedGeoSite:calls.owned,saveGaSnapshot:calls.save}));
import { GA_SCOPE, gaAccessCategory, summarizeGaPages, summarizeGaReport } from "./ga-report";
import { POST } from "@/app/api/sites/[siteId]/geo/ga4/route";
const origin = "http://localhost:3300";
const ctx = {params:Promise.resolve({siteId:"site"})};
const input = {start:"2026-10-01",end:"2026-10-28",propertyId:"12345",code:"single-use",expectedUpdatedAt:null};
const dims = ["date","hostName","sessionSource","landingPage"];
const success = () => Response.json({access_token:"fixture-only",scope:GA_SCOPE});
function records(data:string[][],counts:number[]) {
  return {dimensionHeaders:dims.map(name=>({name})),metricHeaders:[{name:"sessions"}],
    rowCount:data.length, rows:data.map((cells,i)=>({dimensionValues:cells.map(value=>({value})),metricValues:[{value:String(counts[i])}]}))
  };
}
function request(customOrigin=origin, header="XmlHttpRequest") {
  return new Request(origin + "/api/sites/site/geo/ga4",{method:"POST",headers:{
    "Content-Type":"application/json",origin:customOrigin,"X-Requested-With":header
  }, body:JSON.stringify(input)});
}
beforeEach(() => {vi.resetAllMocks();calls.auth.mockResolvedValue({user:{id:"u"}});calls.owned.mockResolvedValue({id:"site",domain:"example.com"});
  vi.stubEnv("GOOGLE_CLIENT_ID","test");vi.stubEnv("GOOGLE_CLIENT_SECRET","fixture-secret");});
afterEach(() => vi.unstubAllEnvs());

describe("GA4 read-only report",()=>{
  it("returns a fixed actionable category for a disabled service without persisting or disclosing Google's raw fields",async()=>{
    calls.auth.mockResolvedValue({user:{id:"diagnostic-test"}});
    calls.fetch.mockResolvedValueOnce(success()).mockResolvedValueOnce(Response.json({error:{
      message:"private details for fixture-property",
      details:[{"@type":"type.googleapis.com/google.rpc.ErrorInfo",domain:"googleapis.com",reason:"SERVICE_DISABLED",metadata:{service:"analyticsdata.googleapis.com",consumer:"private-project"}}],
    }},{status:403}));
    const res = await POST(request(),ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({error:"GA_API_DISABLED"});
    expect(calls.save).not.toHaveBeenCalled();
  });
  it("distinguishes exact provider reasons and keeps unrecognized, spoofed or oversized errors generic",async()=>{
    const info = {"@type":"type.googleapis.com/google.rpc.ErrorInfo", domain:"googleapis.com",reason:"ACCESS_TOKEN_SCOPE_INSUFFICIENT"};
    const classify = (error:object) => gaAccessCategory(Response.json({error},{status:403}));
    expect(await classify({details:[info]})).toBe("GA_SCOPE_INSUFFICIENT");
    expect(await classify({details:[{...info,metadata:{service:"other.googleapis.com"}}]})).toBe("GA_ACCESS");
    expect(await classify({details:[{...info,domain:"untrusted.example"}]})).toBe("GA_ACCESS");
    expect(await classify({message:"User does not have sufficient permissions for this property. Details omitted."})).toBe("GA_PROPERTY_ACCESS");
    expect(await classify({message:"Unclassified 403, text mentions SERVICE_DISABLED"})).toBe("GA_ACCESS");
    expect(await classify({message:"User does not have sufficient permissions for this property." + "x".repeat(33000)})).toBe("GA_ACCESS");
    expect(await gaAccessCategory(new Response("invalid JSON",{status:403}))).toBe("GA_ACCESS");
    expect(await gaAccessCategory(new Response("",{status:404}))).toBe("GA_PROPERTY_NOT_FOUND");
  });
  it("checks the session, same-origin popup header and site ownership before using the one-use code",async()=>{
    expect((await POST(request("https://elsewhere.example"),ctx)).status).toBe(403);
    expect((await POST(request(origin,""),ctx)).status).toBe(403);
    calls.owned.mockRejectedValueOnce(new ContentError("Unknown site",404));
    expect((await POST(request(),ctx)).status).toBe(404);
    calls.auth.mockResolvedValue(null);
    expect((await POST(request(),ctx)).status).toBe(401);
    expect(calls.fetch).not.toHaveBeenCalled(); expect(calls.save).not.toHaveBeenCalled();
  });
  it("requests the selected hostname, dates and exact known session sources and only persists normalized aggregates",async()=>{
    calls.fetch.mockResolvedValueOnce(success()).mockResolvedValueOnce(Response.json({...records([
      ["20261003","example.com","chatgpt.com","/help?secret=fixture"],
      ["20261003","example.com","chat.openai.com","/help"]],[4,7]),metadata:{subjectToThresholding:true}}));
    expect((await POST(request(),ctx)).status).toBe(200);
    const [url, options] = calls.fetch.mock.calls[1];
    expect(url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/12345:runReport");
    const report = JSON.parse(options.body);
    expect(report.dateRanges).toEqual([{startDate:input.start,endDate:input.end}]);
    expect(report.dimensionFilter.andGroup.expressions).toContainEqual({filter:{fieldName:"hostName",stringFilter:{matchType:"EXACT",value:"example.com",caseSensitive:false}}});
    expect(report.dimensionFilter.andGroup.expressions[1].filter.inListFilter.values).toContain("chatgpt.com");
    const saved = calls.save.mock.calls[0][3];
    expect(saved.rows).toEqual([{day:"2026-10-03",platform:"ChatGPT",path:"/help",count:11}]);
    expect(saved.notes.join(" ")).toContain("thresholding"); expect(saved.expectedUpdatedAt).toBeNull();
    expect(JSON.stringify(saved)).not.toMatch(/single-use|fixture|access_token/);
  });
  it("retains the previous snapshot if an empty report cannot be tied to observed host activity",async()=>{
    calls.fetch.mockResolvedValueOnce(success()).mockResolvedValueOnce(Response.json(records([],[]))).mockResolvedValueOnce(Response.json({rowCount:0}));
    const res = await POST(request(),ctx);
    expect(res.status).toBe(422);expect(await res.json()).toEqual({error:"GA_NO_HOST_DATA"});expect(calls.save).not.toHaveBeenCalled();
  });
  it("permits an observed empty result if GA confirms sessions on the selected hostname",async()=>{
    calls.fetch.mockResolvedValueOnce(success()).mockResolvedValueOnce(Response.json(records([],[])))
      .mockResolvedValueOnce(Response.json({rows:[{dimensionValues:[{value:"example.com"}],metricValues:[{value:"15"}]}]}));
    expect((await POST(request(),ctx)).status).toBe(200);
    expect(calls.save.mock.calls[0][3]).toMatchObject({processed:0,rows:[],start:input.start,end:input.end});
  });
  it("rejects scopes for Search Console only",async()=>{
    calls.fetch.mockResolvedValueOnce(Response.json({access_token:"secret-fixture",scope:"webmasters.readonly"}));
    const res = await POST(request(),ctx);
    expect(res.status).toBe(403);expect(await res.json()).toEqual({error:"GA_SCOPE"});expect(calls.fetch).toHaveBeenCalledTimes(1);
  });
  it("reports unavailable data instead of saving an incomplete period or cross-host data",()=>{
    const bad = records([["20261010","other.example","chatgpt","/"]],[2]);
    expect(()=>summarizeGaReport(bad,"example.com",input.start,input.end,"123")).toThrow("GA_RESPONSE");
    expect(()=>summarizeGaReport({...bad,rowCount:50001},"example.com",input.start,input.end,"123")).toThrow("GA_LIMIT");
  });
  it("adds up paged results and rejects pages that do not match the reported total",()=>{
    const first = {...records([["20261010","example.com","chatgpt.com","/a"]],[2]), rowCount:2};
    const second = {...records([["20261011","example.com","claude.ai","/a"]],[3]), rowCount:2};
    expect(summarizeGaPages([first,second],"example.com",input.start,input.end,"123")).toMatchObject({processed:2, rows:[{day:"2026-10-10",platform:"ChatGPT",path:"/a",count:2},{day:"2026-10-11",platform:"Claude",path:"/a",count:3}]});
    expect(()=>summarizeGaPages([first],"example.com",input.start,input.end,"123")).toThrow("GA_RESPONSE");
    expect(()=>summarizeGaPages([first,{...second,rowCount:3}],"example.com",input.start,input.end,"123")).toThrow("GA_RESPONSE");
  });
});
