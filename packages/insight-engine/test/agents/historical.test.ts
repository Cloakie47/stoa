import { beforeEach, describe, expect, it } from "vitest";

import { runHistoricalAgent } from "../../src/agents/historical.js";
import { setClient } from "../../src/claude.js";
import { FIXTURE_CONTEXT, VALID_TRACE_FIELDS } from "../helpers/fixtures.js";
import { makeMockClient } from "../helpers/mock-anthropic.js";

describe("runHistoricalAgent", () => {
  let createMock: ReturnType<typeof makeMockClient>["createMock"];

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { client, createMock: mock } = makeMockClient([
      { traceFields: VALID_TRACE_FIELDS },
    ]);
    setClient(client);
    createMock = mock;
  });

  it("returns a well-formed AgentTrace with agent=historical", async () => {
    const { trace } = await runHistoricalAgent(FIXTURE_CONTEXT);
    expect(trace.agent).toBe("historical");
    expect(trace.model).toBe("claude-sonnet-4-6");
    expect(trace.thesis).toBe(VALID_TRACE_FIELDS.thesis);
  });

  it("does NOT register any tools (training-data only)", async () => {
    await runHistoricalAgent(FIXTURE_CONTEXT);
    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    expect(request.tools).toBeUndefined();
  });

  it("enables adaptive thinking", async () => {
    await runHistoricalAgent(FIXTURE_CONTEXT);
    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    expect(request.thinking).toEqual({ type: "adaptive" });
  });

  it("targets Sonnet 4.6, not Haiku", async () => {
    await runHistoricalAgent(FIXTURE_CONTEXT);
    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    expect(request.model).toBe("claude-sonnet-4-6");
  });
});
