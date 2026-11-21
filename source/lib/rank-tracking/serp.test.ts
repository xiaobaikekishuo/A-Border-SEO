import { describe, expect, it } from "vitest";
import {
  AmbiguousPostError, encodeKeyword, getTask, hasSearchOperator, parsePosted, parseReady, parseTaskGet, postTasks, readSerp, serpTime, taskBody,
} from "./serp";

const credentials = { login: "user@example.com", password: "secret" };
const ok = (tasks: unknown[]) => ({ status_code: 20000, status_message: "Ok.", tasks });
function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (error) { return error; }
  throw new Error("expected an error");
}

function serpResult(items: unknown[], extra: Record<string, unknown> = {}) {
  return { keyword: "rank tracker", datetime: "2026-11-19 08:30:12 +00:00", item_types: items.map(i => (i as { type: string }).type), items, ...extra };
}
const organic = (rank: number, domain: string, path = "/", title = `Title ${rank}`) =>
  ({ type: "organic", rank_group: rank, rank_absolute: rank + 2, domain, url: `https://${domain}${path}`, title });

describe("task bodies", () => {
  it("encodes the characters DataForSEO decodes and asks for the AI Overview only when wanted", () => {
    expect(encodeKeyword("100% c++ tools")).toBe("100%25 c%2B%2B tools");
    const base = { tag: "chk_1", keyword: "c++ ide", language: "en", location: 2840, device: "mobile" as const, depth: 30, aiOverview: false };
    expect(taskBody(base)).toEqual({ keyword: "c%2B%2B ide", location_code: 2840, language_code: "en", device: "mobile", depth: 30, tag: "chk_1" });
    expect(taskBody({ ...base, aiOverview: true })).toMatchObject({ load_async_ai_overview: true });
  });

  it("knows search operators, which are never tracked", () => {
    expect(hasSearchOperator("site:example.com shoes")).toBe(true);
    expect(hasSearchOperator("shoes -intitle:cheap")).toBe(true);
    expect(hasSearchOperator("INURL:blog seo")).toBe(true);
    expect(hasSearchOperator("best seo tools 2026")).toBe(false);
    expect(hasSearchOperator("how to write a site map")).toBe(false);
  });
});

describe("parsePosted", () => {
  it("maps each task to its tag, with its id and cost, and reports tasks not created", () => {
    const body = ok([
      { id: "11191234-1111-0066-0000-aaaaaaaaaaaa", status_code: 20100, status_message: "Task Created.", cost: 0.0018, data: { tag: "b" } },
      { id: "11191234-1111-0066-0000-bbbbbbbbbbbb", status_code: 40501, status_message: "Invalid Field: 'language_code'.", cost: 0, data: { tag: "a" } },
    ]);
    expect(parsePosted(body, ["a", "b", "c"])).toEqual([
      { tag: "a", id: null, cost: 0, error: "DataForSEO did not create the task (40501: Invalid Field: 'language_code'.)" },
      { tag: "b", id: "11191234-1111-0066-0000-aaaaaaaaaaaa", cost: 0.0018, error: null },
      { tag: "c", id: null, cost: 0, error: "DataForSEO did not answer for this task" },
    ]);
  });

  it("ignores tags it did not send and throws for a refused login, an empty balance or a rate limit", () => {
    expect(parsePosted(ok([{ id: "x", status_code: 20100, cost: 1, data: { tag: "other" } }]), ["a"])[0].id).toBeNull();
    expect(thrown(() => parsePosted({ status_code: 40100, status_message: "You are not authorized" }, ["a"]))).toMatchObject({ code: "AUTH", retryable: false });
    expect(thrown(() => parsePosted({ status_code: 40200, status_message: "Payment Required." }, ["a"]))).toMatchObject({ code: "BALANCE" });
    expect(thrown(() => parsePosted({ status_code: 40202, status_message: "Rate limit" }, ["a"]))).toMatchObject({ code: "RATE_LIMIT", retryable: true });
    // A task refused for the balance stops the run like a refused post.
    expect(thrown(() => parsePosted(ok([{ id: "x", status_code: 40200, data: { tag: "a" } }]), ["a"]))).toMatchObject({ code: "BALANCE" });
  });
});

describe("parseReady", () => {
  it("lists finished tasks with their tags", () => {
    const body = ok([{ status_code: 20000, result: [{ id: "t1", tag: "chk_1" }, { id: "t2", tag: null }, { tag: "no id" }] }]);
    expect(parseReady(body)).toEqual([{ id: "t1", tag: "chk_1" }, { id: "t2", tag: null }]);
    expect(parseReady(ok([{ status_code: 20000, result: null }]))).toEqual([]);
  });
});

describe("readSerp", () => {
  it("finds the site's first organic result, the first ten results and the other result types", () => {
    const items = [
      { type: "featured_snippet", rank_group: 1, rank_absolute: 1, domain: "rival.com", url: "https://rival.com/x" },
      ...Array.from({ length: 12 }, (_, i) => organic(i + 1, i === 6 ? "blog.example.com" : i === 9 ? "www.example.com" : `site${i}.com`, i === 6 ? "/guide" : "/")),
      { type: "people_also_ask", rank_group: 1, rank_absolute: 5 },
    ];
    const reading = readSerp(serpResult(items), ["example.com"], false);
    expect(reading).toMatchObject({ position: 7, absolute: 9, url: "https://blog.example.com/guide", aiOverview: false, aiCited: null });
    expect(reading.features).toEqual(["featured_snippet", "people_also_ask"]);
    expect(reading.top).toHaveLength(10);
    expect(reading.top[0]).toEqual({ rank: 1, domain: "site0.com", url: "https://site0.com/", title: "Title 1" });
    expect(reading.checkedAt?.toISOString()).toBe("2026-11-19T08:30:12.000Z");
  });

  it("reads a page without the site as not ranked", () => {
    const reading = readSerp(serpResult([organic(1, "rival.com"), organic(2, "notexample.com")]), ["example.com"], false);
    expect(reading).toMatchObject({ position: null, absolute: null, url: null });
    expect(reading.top.map(r => r.domain)).toEqual(["rival.com", "notexample.com"]);
  });

  it("checks the AI Overview's references only when it was loaded", () => {
    const overview = {
      type: "ai_overview", asynchronous_ai_overview: false,
      items: [{ type: "ai_overview_element", references: [{ domain: "www.example.com", url: "https://www.example.com/a" }] }],
    };
    expect(readSerp(serpResult([overview, organic(1, "rival.com")]), ["example.com"], true)).toMatchObject({ aiOverview: true, aiCited: true });
    expect(readSerp(serpResult([overview, organic(1, "rival.com")]), ["other.com"], true)).toMatchObject({ aiOverview: true, aiCited: false });
    // Present on the page but not asked to load: unknown.
    expect(readSerp(serpResult([overview]), ["example.com"], false)).toMatchObject({ aiOverview: true, aiCited: null });
    // Asked to load, but the page held only the placeholder.
    expect(readSerp(serpResult([{ type: "ai_overview", asynchronous_ai_overview: true }]), ["example.com"], true)).toMatchObject({ aiOverview: true, aiCited: null });
  });

  it("skips malformed results and odd result types", () => {
    const reading = readSerp(serpResult([
      { type: "organic", rank_group: "x", domain: "example.com", url: "https://example.com/" },
      { type: "organic", rank_group: 2, domain: "example.com" },
      { type: "Bad Type!" },
      organic(3, "example.com", "/ok"),
    ]), ["example.com"], false);
    expect(reading).toMatchObject({ position: 3, url: "https://example.com/ok", features: [] });
    expect(serpTime("2026-11-19T08:30:12Z")).toBeNull();
  });
});

describe("parseTaskGet", () => {
  const task = (status_code: number, result: unknown[] | null = null, status_message = "") => ok([{ id: "t1", status_code, status_message, result }]);

  it("waits for queued tasks, reads finished ones and fails the rest", () => {
    expect(parseTaskGet(task(40602, null, "Task In Queue."), ["example.com"], false)).toEqual({ state: "PENDING" });
    expect(parseTaskGet(task(40601, null, "Task Handed."), ["example.com"], false)).toEqual({ state: "PENDING" });
    const done = parseTaskGet(task(20000, [serpResult([organic(4, "example.com")])]), ["example.com"], false);
    expect(done).toMatchObject({ state: "OK", reading: { position: 4 } });
    expect(parseTaskGet(task(40102, null, "No Search Results."), ["example.com"], false)).toMatchObject({ state: "OK", reading: { position: null, top: [] } });
    expect(parseTaskGet(task(40101, null, "Internal SE Server Error."), ["example.com"], false)).toEqual({ state: "FAILED", error: "DataForSEO task status 40101: Internal SE Server Error." });
  });
});

describe("requests", () => {
  function fetcher(answer: () => Response | Promise<Response>, calls: { url: string; init: RequestInit }[] = []) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return answer();
    }) as typeof fetch;
  }

  it("posts with basic auth and reads the created tasks", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const posted = await postTasks(credentials, [{ tag: "a", keyword: "seo", language: "en", location: 2840, device: "desktop", depth: 10, aiOverview: false }], undefined,
      fetcher(() => Response.json(ok([{ id: "t1", status_code: 20100, cost: 0.0006, data: { tag: "a" } }])), calls));
    expect(posted).toEqual([{ tag: "a", id: "t1", cost: 0.0006, error: null }]);
    expect(calls[0].url).toBe("https://api.dataforseo.com/v3/serp/google/organic/task_post");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("user@example.com:secret").toString("base64")}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual([{ keyword: "seo", location_code: 2840, language_code: "en", device: "desktop", depth: 10, tag: "a" }]);
  });

  it("treats a server error or an unreadable answer to a post as possibly posted", async () => {
    const input = [{ tag: "a", keyword: "seo", language: "en", location: 2840, device: "desktop" as const, depth: 10, aiOverview: false }];
    await expect(postTasks(credentials, input, undefined, fetcher(() => new Response("oops", { status: 502 })))).rejects.toBeInstanceOf(AmbiguousPostError);
    await expect(postTasks(credentials, input, undefined, fetcher(() => new Response("not json", { status: 200 })))).rejects.toBeInstanceOf(AmbiguousPostError);
    await expect(postTasks(credentials, input, undefined, fetcher(() => new Response("", { status: 401 })))).rejects.toMatchObject({ code: "AUTH" });
    await expect(postTasks(credentials, input, undefined, fetcher(() => { throw new TypeError("fetch failed"); }))).rejects.toMatchObject({ code: "API", retryable: true });
  });

  it("refuses more than one post's worth of tasks, and odd task ids", async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ tag: `t${i}`, keyword: "k", language: "en", location: 2840, device: "desktop" as const, depth: 10, aiOverview: false }));
    await expect(postTasks(credentials, many, undefined, fetcher(() => Response.json(ok([]))))).rejects.toThrow("At most 100");
    expect(await getTask(credentials, "../tasks_ready", ["example.com"], false, undefined, fetcher(() => Response.json(ok([]))))).toEqual({ state: "FAILED", error: "Unreadable task id" });
  });
});
