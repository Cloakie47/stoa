/**
 * News agent unit tests — mocked Anthropic client.
 *
 * Verifies the agent:
 *  1. Calls Anthropic with the web_search tool registered.
 *  2. Pulls the system prompt + sets cache_control on the system block.
 *  3. Constrains output via output_config.format.
 *  4. Returns a well-formed AgentTrace.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { runNewsAgent } from "../../src/agents/news.js";
import { setClient } from "../../src/claude.js";
import { FIXTURE_CONTEXT, VALID_TRACE_FIELDS } from "../helpers/fixtures.js";
import { makeMockClient } from "../helpers/mock-anthropic.js";

describe("runNewsAgent", () => {
  let createMock: ReturnType<typeof makeMockClient>["createMock"];

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { client, createMock: mock } = makeMockClient([
      { traceFields: VALID_TRACE_FIELDS },
    ]);
    setClient(client);
    createMock = mock;
  });

  it("returns a well-formed AgentTrace", async () => {
    const { trace, cost_usd } = await runNewsAgent(FIXTURE_CONTEXT);

    expect(trace.agent).toBe("news");
    expect(trace.market_url).toBe(FIXTURE_CONTEXT.url);
    expect(trace.market_question).toBe(FIXTURE_CONTEXT.question);
    expect(trace.thesis).toBe(VALID_TRACE_FIELDS.thesis);
    expect(trace.signal).toBe("YES");
    expect(trace.confidence).toBe(65);
    expect(trace.evidence).toHaveLength(1);
    expect(trace.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(trace.model).toBe("claude-haiku-4-5");
    expect(trace.token_usage.input_tokens).toBe(100);
    expect(trace.token_usage.output_tokens).toBe(60);
    expect(cost_usd).toBeGreaterThan(0);
  });

  it("registers the web_search tool", async () => {
    await runNewsAgent(FIXTURE_CONTEXT);
    expect(createMock).toHaveBeenCalledOnce();
    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    const tools = request.tools as Array<{ type: string; name: string }>;
    expect(tools).toBeDefined();
    expect(tools.some((t) => t.name === "web_search")).toBe(true);
    expect(tools.some((t) => t.type === "web_search_20260209")).toBe(true);
  });

  it("applies cache_control to the system block", async () => {
    await runNewsAgent(FIXTURE_CONTEXT);
    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    const system = request.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(system).toHaveLength(1);
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]!.text.length).toBeGreaterThan(1000);
  });

  it("constrains output via output_config.format", async () => {
    await runNewsAgent(FIXTURE_CONTEXT);
    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    expect(request.output_config).toBeDefined();
    const oc = request.output_config as { format: { type: string; schema: object } };
    expect(oc.format.type).toBe("json_schema");
    expect(oc.format.schema).toMatchObject({
      type: "object",
      required: expect.arrayContaining([
        "thesis",
        "evidence",
        "counter_arguments",
        "confidence",
        "signal",
      ]),
    });
  });

  it("targets claude-haiku-4-5 (not Sonnet)", async () => {
    await runNewsAgent(FIXTURE_CONTEXT);
    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    expect(request.model).toBe("claude-haiku-4-5");
  });
});
