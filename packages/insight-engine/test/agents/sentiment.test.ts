import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSentimentAgent } from "../../src/agents/sentiment.js";
import { setClient } from "../../src/claude.js";
import { FIXTURE_CONTEXT, VALID_TRACE_FIELDS } from "../helpers/fixtures.js";
import { makeMockClient } from "../helpers/mock-anthropic.js";

describe("runSentimentAgent", () => {
  let savedX: string | undefined;
  let savedNeynar: string | undefined;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    savedX = process.env.X_BEARER_TOKEN;
    savedNeynar = process.env.NEYNAR_API_KEY;
  });

  afterEach(() => {
    if (savedX === undefined) delete process.env.X_BEARER_TOKEN;
    else process.env.X_BEARER_TOKEN = savedX;
    if (savedNeynar === undefined) delete process.env.NEYNAR_API_KEY;
    else process.env.NEYNAR_API_KEY = savedNeynar;
  });

  it("falls back to web_search alone when no API keys configured", async () => {
    delete process.env.X_BEARER_TOKEN;
    delete process.env.NEYNAR_API_KEY;

    const { client, createMock } = makeMockClient([
      { traceFields: VALID_TRACE_FIELDS },
    ]);
    setClient(client);

    const { trace } = await runSentimentAgent(FIXTURE_CONTEXT);
    expect(trace.agent).toBe("sentiment");

    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    const tools = request.tools as Array<{ type?: string; name: string }>;
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("web_search");
    expect(toolNames).not.toContain("search_x");
    expect(toolNames).not.toContain("search_farcaster");
  });

  it("registers search_x when X_BEARER_TOKEN is set", async () => {
    process.env.X_BEARER_TOKEN = "fake-x-bearer";
    delete process.env.NEYNAR_API_KEY;

    const { client, createMock } = makeMockClient([
      { traceFields: VALID_TRACE_FIELDS },
    ]);
    setClient(client);

    await runSentimentAgent(FIXTURE_CONTEXT);
    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    const tools = request.tools as Array<{ name: string }>;
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("search_x");
    expect(toolNames).toContain("web_search");
  });

  it("registers search_farcaster when NEYNAR_API_KEY is set", async () => {
    delete process.env.X_BEARER_TOKEN;
    process.env.NEYNAR_API_KEY = "fake-neynar-key";

    const { client, createMock } = makeMockClient([
      { traceFields: VALID_TRACE_FIELDS },
    ]);
    setClient(client);

    await runSentimentAgent(FIXTURE_CONTEXT);
    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    const tools = request.tools as Array<{ name: string }>;
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("search_farcaster");
  });

  it("targets Haiku and caches the system prompt", async () => {
    delete process.env.X_BEARER_TOKEN;
    delete process.env.NEYNAR_API_KEY;

    const { client, createMock } = makeMockClient([
      { traceFields: VALID_TRACE_FIELDS },
    ]);
    setClient(client);

    await runSentimentAgent(FIXTURE_CONTEXT);
    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    expect(request.model).toBe("claude-haiku-4-5");
    const system = request.system as Array<{ cache_control?: { type: string } }>;
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
  });
});
