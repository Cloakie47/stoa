/**
 * Market Structure agent test — mocks BOTH the Anthropic client AND the
 * global fetch (since the agent's custom tool hits Polymarket CLOB).
 *
 * Scenario: model calls fetch_market_structure("yes"), gets a mock
 * orderbook back, then emits the final trace.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runMarketStructureAgent } from "../../src/agents/market_structure.js";
import { setClient } from "../../src/claude.js";
import { FIXTURE_CONTEXT, VALID_TRACE_FIELDS } from "../helpers/fixtures.js";
import { makeMockClient } from "../helpers/mock-anthropic.js";

describe("runMarketStructureAgent", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    originalFetch = globalThis.fetch;
    // Stub fetch for Polymarket CLOB endpoints. /book returns a tiny
    // orderbook; /prices-history returns one point.
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/book")) {
        return new Response(
          JSON.stringify({
            market: "test",
            asset_id: "test",
            bids: [
              { price: "0.41", size: "500" },
              { price: "0.40", size: "1000" },
            ],
            asks: [
              { price: "0.45", size: "300" },
              { price: "0.46", size: "800" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/prices-history")) {
        return new Response(
          JSON.stringify({
            history: [
              { t: Math.floor(Date.now() / 1000) - 86_400, p: 0.31 },
              { t: Math.floor(Date.now() / 1000), p: 0.42 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls fetch_market_structure tool then emits the trace", async () => {
    // Sequence: 1st response = tool_use; 2nd response = final trace.
    const { client, createMock } = makeMockClient([
      {
        traceFields: {}, // ignored on tool_use iteration
        toolUseBlocks: [
          {
            id: "toolu_test_1",
            name: "fetch_market_structure",
            input: { side: "yes" },
          },
        ],
        stopReason: "tool_use",
      },
      { traceFields: VALID_TRACE_FIELDS },
    ]);
    setClient(client);

    const { trace } = await runMarketStructureAgent(FIXTURE_CONTEXT);
    expect(trace.agent).toBe("market_structure");
    expect(trace.thesis).toBe(VALID_TRACE_FIELDS.thesis);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("registers the fetch_market_structure custom tool", async () => {
    const { client, createMock } = makeMockClient([
      { traceFields: VALID_TRACE_FIELDS },
    ]);
    setClient(client);

    await runMarketStructureAgent(FIXTURE_CONTEXT);
    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    const tools = request.tools as Array<{ name: string; input_schema?: object }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("fetch_market_structure");
    expect(tools[0]!.input_schema).toBeDefined();
  });

  it("targets Haiku 4.5", async () => {
    const { client, createMock } = makeMockClient([
      { traceFields: VALID_TRACE_FIELDS },
    ]);
    setClient(client);
    await runMarketStructureAgent(FIXTURE_CONTEXT);
    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    expect(request.model).toBe("claude-haiku-4-5");
  });

  it("throws if token_ids are missing from context", async () => {
    const { client } = makeMockClient([{ traceFields: VALID_TRACE_FIELDS }]);
    setClient(client);
    const ctxNoIds = { ...FIXTURE_CONTEXT, token_ids: { yes: undefined, no: undefined } };
    await expect(runMarketStructureAgent(ctxNoIds)).rejects.toThrow(
      /token IDs/,
    );
  });
});
