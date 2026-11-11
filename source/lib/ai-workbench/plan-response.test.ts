import { describe, expect, it, vi } from "vitest";
import { planRequest, readPlanResponse } from "./plan-response";

const completed = { type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"draft":"review me"}' }] }] } };
const emptyCompleted = { type: "response.completed", response: { status: "completed", output: [] } };
const message = (text = '{"draft":"review me"}', id = "msg_draft") => ({ id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
const added = (id = "msg_draft", output_index = 0) => ({ type: "response.output_item.added", output_index, item: { id, type: "message", role: "assistant", status: "in_progress", content: [] } });
const done = (item = message(), output_index = 0) => ({ type: "response.output_item.done", output_index, item });
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const response = (...values: unknown[]) => new Response(values.map(event).join(""), { headers: { "content-type": "text/event-stream" } });
const noMimeResponse = (...values: unknown[]) => new Response(new TextEncoder().encode(values.map(event).join("")));
describe("ChatGPT plan response boundaries", () => {
  it("reports provider usage before draft JSON validation, never usage embedded in model text", async () => {
    const onUsage = vi.fn();
    const usage = { input_tokens: 100, output_tokens: 30, total_tokens: 130, input_tokens_details: { cached_tokens: 70 }, output_tokens_details: { reasoning_tokens: 10 } };
    await expect(readPlanResponse(response({ ...completed, response: { ...completed.response, usage, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "not JSON" }] }] } }), undefined, onUsage)).rejects.toThrow();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ source: "CHATGPT_RESPONSE", inputTokens: 100, cachedInputTokens: 70, outputTokens: 30, reasoningTokens: 10, totalTokens: 130 });
    onUsage.mockClear();
    await readPlanResponse(response(done(message('{"usage":{"input_tokens":999},"draft":"text"}')), emptyCompleted), undefined, onUsage);
    expect(onUsage).not.toHaveBeenCalled();
  });
  it("captures terminal failure usage without accepting a partial draft or inventing missing usage", async () => {
    for (const type of ["response.failed", "response.incomplete"]) {
      const onUsage = vi.fn();
      await expect(readPlanResponse(response({ type, response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, error: { code: "subscription_sharing_usage_limit_exceeded" } } }), undefined, onUsage)).rejects.toThrow();
      expect(onUsage).toHaveBeenCalledOnce();
    }
    const onUsage = vi.fn();
    await readPlanResponse(response({ ...completed, response: { ...completed.response, usage: { input_tokens: -1 } } }), undefined, onUsage);
    expect(onUsage).not.toHaveBeenCalled();
  });
  it("accepts only complete structured output, including fragmented CRLF frames", async () => {
    const raw = event(completed).replaceAll("\n", "\r\n");
    const body = new ReadableStream({ start(controller) { for (const char of raw) controller.enqueue(new TextEncoder().encode(char)); controller.close(); } });
    expect(await readPlanResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }))).toEqual({ draft: "review me" });
  });
  it("accepts the observed account stream with no MIME and empty terminal output only after complete item payloads", async () => {
    const liveShape = noMimeResponse(
      { type: "response.created", response: { status: "in_progress", output: [] } },
      added(), { type: "response.output_text.delta", delta: '{"draft":' },
      { type: "response.metadata" }, done(), emptyCompleted,
    );
    expect(liveShape.headers.get("content-type")).toBeNull();
    expect(await readPlanResponse(liveShape)).toEqual({ draft: "review me" });
  });
  it("rejects explicit wrong MIME and missing-header bodies that are not complete SSE", async () => {
    for (const mime of ["application/json", "text/plain", "application/octet-stream"]) {
      await expect(readPlanResponse(new Response(event(completed), { headers: { "content-type": mime } }))).rejects.toThrow();
    }
    await expect(readPlanResponse(new Response(new TextEncoder().encode('{"draft":"not SSE"}')))).rejects.toThrow();
  });
  it("never substitutes partial deltas or unfinished items for a complete response", async () => {
    for (const events of [
      [added(), done()],
      [{ type: "response.output_text.delta", delta: '{"draft":"partial"}' }, emptyCompleted],
      [added(), emptyCompleted],
      [added(), completed],
      [done({ ...message(), status: "in_progress" }), emptyCompleted],
    ]) await expect(readPlanResponse(noMimeResponse(...events))).rejects.toThrow();
  });
  it("orders complete payloads by stable output index and rejects duplicate or conflicting identities", async () => {
    const first = message('{"draft":', "msg_first"), second = message('"review me"}', "msg_second");
    expect(await readPlanResponse(response(done(second, 1), done(first, 0), emptyCompleted))).toEqual({ draft: "review me" });
    for (const events of [
      [added(), added()],
      [done(), done()],
      [added(), done(message(undefined, "msg_other"))],
      [done(), done(message(), 1)],
      [done(), added()],
      [done(message(), -1)],
      [done(message(), 128)],
      [done(message(), 0.5)],
    ]) await expect(readPlanResponse(response(...events, emptyCompleted))).rejects.toThrow();
  });
  it("reconciles a populated terminal output with previously completed items", async () => {
    const terminal = (output: unknown[]) => ({ type: "response.completed", response: { status: "completed", output } });
    expect(await readPlanResponse(response(added(), done(), terminal([message()])))).toEqual({ draft: "review me" });
    for (const output of [
      [message('{"draft":"changed"}')],
      [message(undefined, "msg_changed")],
      [{ id: "msg_draft", type: "reasoning" }],
      [message(), message()],
    ]) await expect(readPlanResponse(response(done(), terminal(output)))).rejects.toThrow();
  });
  it("bounds completed payloads even without deltas and rejects incomplete reasoning or refused content", async () => {
    await expect(readPlanResponse(response(done(message("x".repeat(451 * 1024))), emptyCompleted))).rejects.toThrow();
    await expect(readPlanResponse(response(
      { type: "response.output_item.added", output_index: 0, item: { id: "rs_pending", type: "reasoning" } },
      done(message(), 1), emptyCompleted,
    ))).rejects.toThrow();
    await expect(readPlanResponse(response(
      { ...done(), item: { ...message(), content: [{ type: "refusal", refusal: "No" }] } }, emptyCompleted,
    ))).rejects.toThrow();
  });
  it("rejects truncated streams, incomplete output, and non-JSON text", async () => {
    await expect(readPlanResponse(response({ type: "response.output_text.delta", delta: '{"draft":"partial"}' }))).rejects.toThrow("did not complete");
    await expect(readPlanResponse(response({ type: "response.incomplete" }))).rejects.toThrow();
    await expect(readPlanResponse(response({ ...completed, response: { ...completed.response, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "not JSON" }] }] } }))).rejects.toThrow();
  });
  it("does not accept partial output when a quota error arrives later", async () => {
    await expect(readPlanResponse(response({ type: "response.output_text.delta", delta: "hello" }, { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "private upstream details" } } }))).rejects.toThrow("Manage usage");
    await expect(readPlanResponse(response({ type: "error", error: { code: "subscription_sharing_usage_unavailable" } }))).rejects.toThrow("temporarily unavailable");
    await expect(readPlanResponse(noMimeResponse(added(), done(), { type: "error", code: "subscription_sharing_usage_limit_exceeded" }, emptyCompleted))).rejects.toThrow("Manage usage");
  });
  it("rejects tools, refusal, duplicate or post-terminal events", async () => {
    for (const bad of [{ type: "response.output_item.added", item: { type: "function_call" } }, { type: "response.refusal.delta" }]) await expect(readPlanResponse(response(bad, completed))).rejects.toThrow();
    await expect(readPlanResponse(response(completed, completed))).rejects.toThrow();
    await expect(readPlanResponse(response(completed, { type: "response.failed" }))).rejects.toThrow();
  });
  it("bounds streams and discards canceled output", async () => {
    await expect(readPlanResponse(response({ type: "response.output_text.delta", delta: "x".repeat(451 * 1024) }))).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(readPlanResponse(response(completed), controller.signal)).rejects.toThrow();
  });
  it("does not forward upstream error bodies, retry, use tools, or persist responses", async () => {
    await expect(readPlanResponse(new Response("secret diagnostics", { status: 401 }))).rejects.toThrow("Reconnect");
    await expect(readPlanResponse(new Response("secret diagnostics", { status: 500 }))).rejects.toThrow("No automatic retry");
    const request = planRequest("account-model", "evidence", { type: "object" });
    expect(request).toMatchObject({ model: "account-model", store: false, stream: true, input: [{ role: "user" }] });
    for (const key of ["tools", "max_output_tokens", "temperature", "previous_response_id", "background"]) expect(request).not.toHaveProperty(key);
  });
});
