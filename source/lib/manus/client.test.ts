import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkKey, createResearch, downloadResearchReport, downloadResearchWorkbook, normalizeResearchInput, readResearch } from "./client";
import { MAX_WORKBOOK_BYTES } from "./workbook-limits";

const transport = vi.fn<typeof fetch>();
const key = "test-only-credential";
const id = "xT_123";
const input = { seeds: ["ceramic mugs"], audience: "UK shoppers", language: "English" };
const documentUrl = "https://private.manuscdn.com/output/123?signature=temporary";
const attachment = { type: "file", filename: "keywords.xlsx", url: documentUrl };
function reply(data: object, status = 200) {
  transport.mockResolvedValueOnce(Response.json(data, { status }));
}
function detail(status: string, background = false) {
  reply({ ok: true, task: { id, status, has_running_background_jobs: background } });
}
function assistant(content: string, attachments: unknown[] = []) {
  return { type: "assistant_message", assistant_message: { content, attachments } };
}

beforeEach(() => {
  transport.mockReset();
  vi.stubGlobal("fetch", transport);
  vi.stubEnv("MANUS_HTTP_PROXY", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Manus keyword research", () => {
  it("normalizes duplicate seeds and rejects unsupported payloads before submission", async () => {
    expect(normalizeResearchInput({ seeds: [" A ", "ａ", "b"], language: "zh-CN" }))
      .toEqual({ seeds: ["A", "b"], audience: "", language: "zh-CN" });
    for (const value of [
      { ...input, seeds: [] }, { ...input, seeds: ["a".repeat(81)] }, { ...input, seeds: Array(21).fill("a") },
      { ...input, audience: "x".repeat(301) }, { ...input, language: "" }, { ...input, prompt: "custom" },
      { ...input, seeds: [key] },
    ]) {
      await expect(createResearch(key, value)).rejects.toMatchObject({ code: "invalid_input", ambiguousSubmission: false });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("creates one private Lite task, clearing account connectors and forwarding only research fields", async () => {
    reply({ ok: true, task_id: id, task_url: "https://example.com/unsafe", share_url: "https://example.com/public" });
    await expect(createResearch(key, input)).resolves.toEqual({ remoteId: id, taskUrl: `https://manus.im/app/${id}` });
    const [[url, options]] = transport.mock.calls;
    expect(String(url)).toBe("https://api.manus.ai/v2/task.create");
    expect(options).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", headers: { "x-manus-api-key": key } });
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({ agent_profile: "lite", share_visibility: "private", interactive_mode: false, clear_connectors: true });
    expect(body.message.content[0].text).toContain(JSON.stringify(input));
    expect(body.message.content[0].text).toContain(".xlsx");
    expect(String(options?.body)).not.toContain(key);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("verifies the key with a single read-only call and returns no account data", async () => {
    vi.stubEnv("OPENAI_HTTP_PROXY", "http://external.example");
    reply({ ok: true, user_id: "123", email: "private@example.org" });
    await expect(checkKey(key)).resolves.toBeUndefined();
    const [[url, options]] = transport.mock.calls;
    expect(String(url)).toBe("https://api.manus.ai/v2/user.me");
    expect(options).toMatchObject({ method: "GET", redirect: "error" });
    expect(options).not.toHaveProperty("dispatcher");
    expect(options?.body).toBeUndefined();
  });

  it("uses a Manus-specific local dispatcher and rejects external proxies before sending", async () => {
    vi.stubEnv("MANUS_HTTP_PROXY", "http://127.0.0.1:7890");
    reply({ ok: true, user_id: "123" });
    await checkKey(key);
    expect(transport.mock.calls[0][1]).toHaveProperty("dispatcher");
    vi.stubEnv("MANUS_HTTP_PROXY", "http://external.example");
    await expect(createResearch(key, input)).rejects.toMatchObject({ code: "network", ambiguousSubmission: false });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "unauthenticated", "unauthorized", false],
    [200, "permission_denied", "forbidden", false],
    [429, "rate_limited", "rate_limited", false],
    [402, "billing", "insufficient_credits", false],
    [503, "internal", "upstream", true],
  ] as const)("sanitizes provider failure %i/%s and classifies submission ambiguity", async (status, providerCode, code, ambiguousSubmission) => {
    reply({ ok: false, error: { code: providerCode, message: key } }, status);
    await expect(createResearch(key, input)).rejects.toMatchObject({ message: code, code, ambiguousSubmission });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("never repeats a submission on lost response, bad JSON, or a secret in the task ID", async () => {
    transport.mockRejectedValueOnce(new Error(key));
    await expect(createResearch(key, input)).rejects.toMatchObject({ message: "network", ambiguousSubmission: true });
    transport.mockResolvedValueOnce(new Response("bad json"));
    await expect(createResearch(key, input)).rejects.toMatchObject({ message: "invalid_response", ambiguousSubmission: true });
    reply({ ok: true, task_id: `echo-${key}` });
    await expect(createResearch(key, input)).rejects.toMatchObject({ message: "invalid_response", ambiguousSubmission: true });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each([["running", false, "running"], ["stopped", true, "running"], ["error", false, "failed"]] as const)(
    "reads task.detail for %s with background=%s", async (status, background, expected) => {
      detail(status, background);
      await expect(readResearch(key, id)).resolves.toMatchObject({ status: expected, files: [] });
      expect(String(transport.mock.calls[0][0])).toBe(`https://api.manus.ai/v2/task.detail?task_id=${id}`);
      expect(transport).toHaveBeenCalledTimes(1);
    }
  );

  it("returns the latest assistant summary and finds signed XLSX output on an older page", async () => {
    detail("stopped");
    reply({ ok: true, task_id: id, messages: [assistant("Summary"), assistant("Older")], has_more: true, next_cursor: "r=2/&x" });
    reply({ ok: true, task_id: id, messages: [assistant("With file", [attachment])] });
    await expect(readResearch(key, id)).resolves.toEqual({
      status: "completed", taskUrl: `https://manus.im/app/${id}`, summary: "Summary", files: [{ name: "keywords.xlsx", url: documentUrl }],
    });
    const url = new URL(String(transport.mock.calls[2][0]));
    expect(url.pathname).toBe("/v2/task.listMessages");
    expect(url.searchParams.get("cursor")).toBe("r=2/&x");
    expect(transport.mock.calls.every(call => String(call[0]).startsWith("https://api.manus.ai/v2/"))).toBe(true);
  });

  it("ignores user messages, credential echoes, unrelated files and untrusted download URLs", async () => {
    detail("waiting");
    reply({
      ok: true, task_id: id, messages: [
        { type: "user_message", user_message: { content: "user input", attachments: [attachment] } },
        assistant(key, [
          { ...attachment, url: "javascript:alert(1)" }, { ...attachment, url: "https://private.manuscdn.com.example.org/bad" },
          { ...attachment, url: "https://fake@private.manuscdn.com/report" }, { ...attachment, url: `${documentUrl}&k=${key}` },
          { ...attachment, filename: "book.xlsm" }, { ...attachment, filename: `${key}.xlsx` },
          { ...attachment, type: "slides" },
        ]),
      ],
    });
    await expect(readResearch(key, id)).resolves.toMatchObject({ status: "waiting", summary: "", files: [] });
  });

  it("refuses task detail or message pages from a different task", async () => {
    reply({ ok: true, task: { status: "stopped", id: "other" } });
    await expect(readResearch(key, id)).rejects.toMatchObject({ code: "invalid_response" });
    detail("stopped");
    reply({ ok: true, task_id: "other", messages: [] });
    await expect(readResearch(key, id)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("downloads the existing task's regional XLSX attachment without forwarding credentials", async () => {
    const url = "https://private-us-east-1.manuscdn.com/output/123?signature=fresh";
    const filename = "美国静态住宅IP_SEO关键词研究.xlsx";
    reply({ ok: true, task_id: id, messages: [assistant("[工作簿](/home/ubuntu/report.xlsx)", [
      { ...attachment, filename: "报告.md" }, { type: "file", filename, path: "/home/ubuntu/report.xlsx", url },
    ])] });
    transport.mockResolvedValueOnce(new Response(Uint8Array.of(80, 75, 3, 4)));
    const downloaded = await downloadResearchWorkbook(key, id);
    expect(downloaded).toEqual({ filename, bytes: Buffer.from([80, 75, 3, 4]) });
    expect(transport.mock.calls.map(([target]) => new URL(String(target)).pathname)).toEqual(["/v2/task.listMessages", "/output/123"]);
    const [[messagesUrl, messagesOptions], [downloadUrl, downloadOptions]] = transport.mock.calls;
    expect(new URL(String(messagesUrl)).searchParams.get("task_id")).toBe(id);
    expect(messagesOptions).toMatchObject({ method: "GET", headers: { "x-manus-api-key": key } });
    expect(String(downloadUrl)).toBe(url);
    expect(downloadOptions).toMatchObject({ method: "GET", redirect: "error", cache: "no-store", credentials: "omit" });
    expect(downloadOptions?.headers).toBeUndefined();
    expect(downloadOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  it("finds a Library-only XLSX on a later page for the same task", async () => {
    reply({ ok: true, task_id: id, messages: [assistant("报告见 /home/ubuntu/report.xlsx")] });
    const artifact = { task_id: id, type: "spreadsheets", file_type: "file", filename: "keywords.xlsx", url: documentUrl };
    reply({ ok: true, data: [{ ...artifact, filename: "notes.csv" }], has_more: true, next_cursor: "page2" });
    reply({ ok: true, data: [artifact] });
    transport.mockResolvedValueOnce(new Response("test bytes"));
    await expect(downloadResearchWorkbook(key, id)).resolves.toMatchObject({ filename: "keywords.xlsx" });
    for (const [target, init] of transport.mock.calls.slice(1, 3)) {
      const url = new URL(String(target));
      expect(url.pathname).toBe("/v2/artifact.list");
      expect(url.searchParams.get("task_id")).toBe(id);
      expect(url.searchParams.get("type")).toBe("spreadsheets");
      expect(init?.method).toBe("GET");
    }
    expect(new URL(String(transport.mock.calls[2][0])).searchParams.get("cursor")).toBe("page2");
  });

  it("never fetches an embedded path, untrusted origin, or user attachment", async () => {
    const attachments = [
      "https://private-us-east-1.manuscdn.com.example.org/file",
      "http://private-us-east-1.manuscdn.com/file",
      "https://private-us-east-1.manuscdn.com:1234/file",
      "blob:https://private.manuscdn.com/report",
      "/home/ubuntu/report.xlsx",
    ].map(url => ({ ...attachment, url }));
    reply({ ok: true, task_id: id, messages: [
      assistant(`Workbook: ${documentUrl}`, attachments),
      { type: "user_message", user_message: { attachments: [attachment] } },
    ] });
    reply({ ok: true, data: [] });
    await expect(downloadResearchWorkbook(key, id)).rejects.toMatchObject({ code: "no_workbook" });
    expect(transport.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/v2/task.listMessages", "/v2/artifact.list"]);
  });

  it("rejects foreign task artifacts before contacting the CDN", async () => {
    reply({ ok: true, task_id: id, messages: [] });
    reply({ ok: true, data: [{ task_id: "different", type: "spreadsheets", file_type: "file", filename: "x.xlsx", url: documentUrl }] });
    await expect(downloadResearchWorkbook(key, id)).rejects.toMatchObject({ code: "invalid_response" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(["declared", "streamed"])("limits %s workbook bytes", async mode => {
    reply({ ok: true, task_id: id, messages: [assistant("Report", [attachment])] });
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        if (mode === "streamed") {
          controller.enqueue(new Uint8Array(MAX_WORKBOOK_BYTES));
          controller.enqueue(Uint8Array.of(0));
        }
      }, cancel,
    });
    const headers = mode === "declared" ? { "Content-Length": String(MAX_WORKBOOK_BYTES + 1) } : undefined;
    transport.mockResolvedValueOnce(new Response(body, { headers }));
    await expect(downloadResearchWorkbook(key, id)).rejects.toMatchObject({ code: "workbook_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("loads a UTF-8 Markdown report using only its task attachment", async () => {
    const url = "https://private-us-east-1.manuscdn.com/summary?sig=temp";
    const filename = "关键词分析.markdown";
    const text = "# 研究报告\n\n| Keyword | Intent |";
    reply({ ok: true, task_id: id, messages: [assistant("", [attachment, { type: "file", filename, url }])], has_more: true });
    transport.mockResolvedValueOnce(new Response(text));
    await expect(downloadResearchReport(key, id)).resolves.toEqual({ filename, text });
    const [[, messageOptions], [reportUrl, reportOptions]] = transport.mock.calls;
    expect(messageOptions?.method).toBe("GET");
    expect(String(reportUrl)).toBe(url);
    expect(reportOptions).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
    expect(reportOptions?.headers).toBeUndefined();
  });

  it("reports a missing Markdown attachment even when the summary contains Markdown links", async () => {
    reply({ ok: true, task_id: id, messages: [assistant("[Read report](/home/ubuntu/output.md)", [attachment])] });
    await expect(downloadResearchReport(key, id)).rejects.toMatchObject({ code: "no_report" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    [Uint8Array.of(0xff), "invalid_response"], [new Uint8Array(256 * 1024 + 1), "report_too_large"],
    [key, "invalid_response"],
  ] as const)("rejects unreadable, oversized or secret-containing reports (%#)", async (body, code) => {
    reply({ ok: true, task_id: id, messages: [assistant("Summary", [{ ...attachment, filename: "report.md" }])] });
    transport.mockResolvedValueOnce(new Response(body));
    await expect(downloadResearchReport(key, id)).rejects.toMatchObject({ code });
  });
});
