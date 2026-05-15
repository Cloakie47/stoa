import { beforeEach, describe, expect, it } from "vitest";

import { runJudgeAgent } from "../../src/agents/judge.js";
import { setClient } from "../../src/claude.js";
import type { AgentTrace } from "../../src/types.js";
import { FIXTURE_CONTEXT, VALID_JUDGE_FIELDS } from "../helpers/fixtures.js";
import { makeMockClient } from "../helpers/mock-anthropic.js";

const fakeAgentTrace = (agent: AgentTrace["agent"], signal: AgentTrace["signal"], confidence: number): AgentTrace => ({
  agent,
  market_url: FIXTURE_CONTEXT.url,
  market_question: FIXTURE_CONTEXT.question,
  thesis: `${agent} thesis`,
  evidence: [{ source: agent, quote: "evidence" }],
  counter_arguments: `${agent} counter`,
  confidence,
  signal,
  reasoning: `${agent} reasoning`,
  timestamp: new Date().toISOString(),
  model: "claude-haiku-4-5",
  token_usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
});

describe("runJudgeAgent", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("emits a JudgeTrace with disagreement_analysis + agent_signals + size", async () => {
    const { client } = makeMockClient([{ traceFields: VALID_JUDGE_FIELDS }]);
    setClient(client);

    const { trace } = await runJudgeAgent({
      context: FIXTURE_CONTEXT,
      userBalanceUsdc: 100,
      agentTraces: [
        fakeAgentTrace("news", "YES", 70),
        fakeAgentTrace("sentiment", "YES", 55),
        fakeAgentTrace("historical", "YES", 60),
        fakeAgentTrace("market_structure", "YES", 50),
      ],
    });

    expect(trace.agent).toBe("judge");
    expect(trace.model).toBe("claude-sonnet-4-6");
    expect(trace.disagreement_analysis).toBeTruthy();
    expect(trace.agent_signals.news).toEqual({ signal: "YES", confidence: 70 });
    expect(trace.recommended_size_usdc).toBe(15);
  });

  it("zeroes recommended_size_usdc when signal is PASS", async () => {
    const passFields = {
      ...VALID_JUDGE_FIELDS,
      signal: "PASS" as const,
      // Even if model tries to recommend a size, the orchestrator should
      // clamp it to 0 because signal is PASS.
      recommended_size_usdc: 50,
    };
    const { client } = makeMockClient([{ traceFields: passFields }]);
    setClient(client);

    const { trace } = await runJudgeAgent({
      context: FIXTURE_CONTEXT,
      userBalanceUsdc: 100,
      agentTraces: [
        fakeAgentTrace("news", "PASS", 30),
        fakeAgentTrace("sentiment", "PASS", 35),
        fakeAgentTrace("historical", "YES", 40),
        fakeAgentTrace("market_structure", "PASS", 25),
      ],
    });

    expect(trace.signal).toBe("PASS");
    expect(trace.recommended_size_usdc).toBe(0);
  });

  it("clamps recommended_size_usdc to 20% of user balance", async () => {
    const oversizedFields = {
      ...VALID_JUDGE_FIELDS,
      recommended_size_usdc: 999, // model tried to size 999 USDC
    };
    const { client } = makeMockClient([{ traceFields: oversizedFields }]);
    setClient(client);

    const { trace } = await runJudgeAgent({
      context: FIXTURE_CONTEXT,
      userBalanceUsdc: 100,
      agentTraces: [
        fakeAgentTrace("news", "YES", 80),
        fakeAgentTrace("sentiment", "YES", 70),
        fakeAgentTrace("historical", "YES", 75),
        fakeAgentTrace("market_structure", "YES", 60),
      ],
    });

    expect(trace.recommended_size_usdc).toBeLessThanOrEqual(20);
    expect(trace.recommended_size_usdc).toBe(20); // exactly 20% of 100
  });

  it("uses the Judge JSON schema (not the AgentTrace schema)", async () => {
    const { client, createMock } = makeMockClient([
      { traceFields: VALID_JUDGE_FIELDS },
    ]);
    setClient(client);

    await runJudgeAgent({
      context: FIXTURE_CONTEXT,
      userBalanceUsdc: 100,
      agentTraces: [
        fakeAgentTrace("news", "YES", 70),
        fakeAgentTrace("sentiment", "YES", 55),
        fakeAgentTrace("historical", "YES", 60),
        fakeAgentTrace("market_structure", "YES", 50),
      ],
    });

    const [request] = createMock.mock.calls[0]! as [Record<string, unknown>];
    const oc = request.output_config as { format: { schema: { required: string[] } } };
    expect(oc.format.schema.required).toContain("disagreement_analysis");
    expect(oc.format.schema.required).toContain("agent_signals");
    expect(oc.format.schema.required).toContain("recommended_size_usdc");
  });
});
