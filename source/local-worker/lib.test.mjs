import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISABLED_FEATURES, LIMITS, PROMPT_PREAMBLE, childEnv, execArgs, failureFromExit, generateToken, isLoopbackHost, loginArgs,
  parseBaseUrl, parseConfig, promptText, reportedUsage, safeCode, schemaText, summarizeEvents, tokenFrom, validateClaim,
} from "./lib.mjs";

const posix = (env = {}, argv = []) => parseConfig({ ABORDER_WORKER_RUNTIME: "/tmp/aborder-worker", ABORDER_CODEX_HOME: "/tmp/aborder-codex", ...env }, argv, "linux");

describe("configuration", () => {
  it("defaults to the local app, low reasoning and every tool feature disabled", () => {
    const config = posix();
    expect(config).toMatchObject({ mode: "watch", baseUrl: "http://localhost:3300", codexBin: null, model: null, reasoning: "low", timeoutSeconds: 540, extraArgs: [] });
    expect(config.disabledFeatures).toEqual(DEFAULT_DISABLED_FEATURES);
    expect(posix({}, ["--once"]).mode).toBe("once");
    expect(posix({}, ["--check"]).mode).toBe("check");
    expect(posix({}, ["--generate-token"]).mode).toBe("generate-token");
  });
  it("lets the Codex command, model, reasoning, features and extra arguments be changed", () => {
    const config = posix({
      ABORDER_CODEX_BIN: "/opt/codex/bin/codex", ABORDER_CODEX_MODEL: "gpt-5.5-codex", ABORDER_CODEX_REASONING: "high",
      ABORDER_CODEX_DISABLE_FEATURES: "shell_tool, apps", ABORDER_CODEX_EXTRA_ARGS: '["--profile","seo"]', ABORDER_CODEX_TIMEOUT_SECONDS: "300",
    });
    expect(config).toMatchObject({ codexBin: "/opt/codex/bin/codex", model: "gpt-5.5-codex", reasoning: "high", disabledFeatures: ["shell_tool", "apps"], extraArgs: ["--profile", "seo"], timeoutSeconds: 300 });
  });
  it.each([
    [{ ABORDER_CODEX_REASONING: "max" }],
    [{ ABORDER_CODEX_EXTRA_ARGS: "--profile seo" }],
    [{ ABORDER_CODEX_EXTRA_ARGS: '["a\\nb"]' }],
    [{ ABORDER_CODEX_DISABLE_FEATURES: "shell tool" }],
    [{ ABORDER_CODEX_TIMEOUT_SECONDS: "900" }],
    [{ ABORDER_CODEX_MODEL: "bad model" }],
    [{ ABORDER_WORKER_RUNTIME: "relative/dir" }],
  ])("refuses invalid settings %#", env => {
    expect(() => posix(env)).toThrow("invalid_config");
  });
  it("refuses unknown flags", () => {
    expect(() => posix({}, ["--publish"])).toThrow("invalid_config");
  });
});

describe("app address", () => {
  it("allows plain HTTP only on this computer", () => {
    expect(parseBaseUrl("http://127.0.0.1:3400/", false)).toBe("http://127.0.0.1:3400");
    expect(parseBaseUrl("http://[::1]:3300", false)).toBe("http://[::1]:3300");
    expect(isLoopbackHost("localhost")).toBe(true);
    for (const url of ["http://seo.example.com", "https://seo.example.com", "ftp://localhost", "http://user:pw@localhost:3300", "http://localhost:3300/?x=1"])
      expect(() => parseBaseUrl(url, false), url).toThrow("invalid_config");
  });
  it("allows a remote app only over HTTPS with an explicit opt-in", () => {
    expect(parseBaseUrl("https://seo.example.com/", true)).toBe("https://seo.example.com");
    expect(() => parseBaseUrl("http://seo.example.com", true)).toThrow("invalid_config");
  });
});

describe("token", () => {
  it("reads the env or a token file and checks its shape", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenFrom({ LOCAL_CONTENT_WORKER_TOKEN: token }, () => "")).toBe(token);
    expect(tokenFrom({ ABORDER_WORKER_TOKEN_FILE: "/secret" }, () => token + "\n")).toBe(token);
    expect(() => tokenFrom({}, () => "")).toThrow("worker_token_missing");
    expect(() => tokenFrom({ LOCAL_CONTENT_WORKER_TOKEN: "short" }, () => "")).toThrow("worker_token_invalid");
    expect(() => tokenFrom({ ABORDER_WORKER_TOKEN_FILE: "/missing" }, () => { throw new Error("ENOENT"); })).toThrow("worker_token_missing");
  });
});

describe("claims, prompts and schemas", () => {
  it("accepts a valid claim and no job", () => {
    expect(validateClaim({ job: null })).toBeNull();
    expect(validateClaim({ job: { jobId: "job_1", leaseToken: "l".repeat(32), prompt: "p", outputSchema: { type: "object" } } })).toMatchObject({ provider: "CODEX_LOCAL", jobId: "job_1" });
    expect(validateClaim({ job: { jobId: "j", leaseToken: "l".repeat(32), provider: "CHATGPT_APP", prompt: "", outputSchema: {} } }).provider).toBe("CHATGPT_APP");
  });
  it("refuses malformed claims before Codex runs", () => {
    for (const body of [null, {}, { job: { jobId: "../x", leaseToken: "l".repeat(32) } }, { job: { jobId: "j", leaseToken: "short" } }, { job: { jobId: "j", leaseToken: "l".repeat(32), provider: 3 } }])
      expect(() => validateClaim(body)).toThrow("invalid_claim");
  });
  it("prefixes the safety preamble and bounds the prompt", () => {
    expect(promptText("Draft an outline")).toBe(PROMPT_PREAMBLE + "Draft an outline");
    expect(() => promptText("  ")).toThrow("invalid_prompt");
    expect(() => promptText("x".repeat(LIMITS.promptChars + 1))).toThrow("invalid_prompt");
  });
  it("refuses remote references and oversized schemas", () => {
    expect(schemaText({ type: "object" })).toBe('{"type":"object"}');
    expect(() => schemaText({ $ref: "https://evil.example/schema" })).toThrow("invalid_output_schema");
    expect(() => schemaText({ description: "x".repeat(LIMITS.schemaChars) })).toThrow("invalid_output_schema");
    expect(() => schemaText([])).toThrow("invalid_output_schema");
  });
});

describe("Codex invocation", () => {
  it("runs read-only, ephemeral and tool-free, with the prompt on stdin", () => {
    const args = execArgs(posix({ ABORDER_CODEX_MODEL: "gpt-5.5-codex" }), "/tmp/job-1");
    expect(args.slice(0, 4)).toEqual(["--no-daemon", "--ask-for-approval", "never", "exec"]);
    expect(args).toContain("--ignore-user-config");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain("--ephemeral");
    expect(args[args.indexOf("--output-schema") + 1]).toMatch(/job-1[\\/]schema\.json$/);
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain("mcp_servers={}");
    expect(args.filter(arg => arg === "--disable")).toHaveLength(DEFAULT_DISABLED_FEATURES.length);
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.5-codex");
    expect(args.at(-1)).toBe("-");
    expect(loginArgs().slice(-2)).toEqual(["login", "status"]);
  });
  it("passes an allowlisted environment without API keys", () => {
    const env = childEnv({ PATH: "/usr/bin", HOME: "/home/a", OPENAI_API_KEY: "sk-test", CODEX_API_KEY: "x", AWS_SECRET_ACCESS_KEY: "y" }, posix());
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/a", CODEX_HOME: "/tmp/aborder-codex", TERM: "dumb", NO_PROXY: "localhost,127.0.0.1,::1" });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("CODEX_API_KEY");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });
});

describe("Codex output", () => {
  const line = value => JSON.stringify(value);
  const turn = (items, usage = { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 300, reasoning_output_tokens: 100 }) => [
    line({ type: "thread.started", thread_id: "t" }), line({ type: "turn.started" }),
    ...items.map(type => line({ type: "item.completed", item: { id: "i", type } })),
    line({ type: "turn.completed", usage }),
  ].join("\n");
  it("reports usage for one clean turn", () => {
    const summary = summarizeEvents(turn(["reasoning", "agent_message"]));
    expect(summary).toMatchObject({ completedTurns: 1, invalidEventCount: 0, unexpectedItemTypes: [] });
    expect(summary.usage).toEqual({ source: "CODEX_CLI", inputTokens: 1200, cachedInputTokens: 200, outputTokens: 300, reasoningTokens: 100, totalTokens: 1500 });
  });
  it("flags tool calls, broken lines and extra turns", () => {
    expect(summarizeEvents(turn(["command_execution", "agent_message"])).unexpectedItemTypes).toEqual(["command_execution"]);
    expect(summarizeEvents(turn(["agent_message"]) + "\nnot json").invalidEventCount).toBe(1);
    expect(summarizeEvents(turn(["agent_message"]) + "\n" + line({ type: "turn.started" })).usage).toBeNull();
  });
  it("refuses inconsistent usage", () => {
    expect(reportedUsage({ input_tokens: 10, cached_input_tokens: 11 })).toBeNull();
    expect(reportedUsage({ output_tokens: 1, reasoning_output_tokens: 2 })).toBeNull();
    expect(reportedUsage({ input_tokens: -1 })).toBeNull();
    expect(reportedUsage({})).toBeNull();
    expect(reportedUsage({ output_tokens: 5 })).toEqual({ source: "CODEX_CLI", inputTokens: null, cachedInputTokens: null, outputTokens: 5, reasoningTokens: null, totalTokens: null });
  });
  it("names usage limits and keeps other error text out of the code", () => {
    expect(failureFromExit(0, "")).toBeNull();
    expect(failureFromExit(1, "You've hit your usage limit")).toBe("chatgpt_usage_limit");
    expect(failureFromExit(1, "something else")).toBe("codex_generation_failed");
    expect(safeCode(new Error("generation_timeout"))).toBe("generation_timeout");
    expect(safeCode(new Error("ENOENT: /home/a/secret"))).toBe("generation_failed");
  });
});
