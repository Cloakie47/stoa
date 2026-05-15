import { beforeEach, describe, expect, it } from "vitest";

import {
  computeJudgeRecommendation,
  runJudgeAgent,
} from "../../src/agents/judge.js";
import { setClient } from "../../src/claude.js";
import type { AgentTrace } from "../../src/types.js";
import { FIXTURE_CONTEXT, VALID_JUDGE_FIELDS } from "../helpers/fixtures.js";
import { makeMockClient } from "../helpers/mock-anthropic.js";

const fakeAgentTrace = (
  agent: AgentTrace["agent"],
  signal: AgentTrace["signal"],
  confidence: number,
): AgentTrace => ({
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

/**
 * Pure unit tests for `computeJudgeRecommendation`. This is the heart of the
 * Kelly-based sizing — no LLM involved. Six cases covering all branches plus
 * the Starmer case from the original bug report.
 */
describe("computeJudgeRecommendation (Kelly-based sizing)", () => {
  it("(a) positive YES edge → recommends YES with quarter-Kelly size", () => {
    // model thinks 60% YES, market prices 40% YES
    // edge_yes = 0.20, kelly = 0.20 / (1 - 0.40) = 0.3333
    // quarter-kelly = 0.0833, capped to 0.20 → 0.0833
    // size = 100 * 0.0833 = $8.33
    const r = computeJudgeRecommendation({
      model_p_yes: 0.6,
      market_p_yes: 0.4,
      balance: 100,
    });
    expect(r.signal).toBe("YES");
    expect(r.edge_yes).toBeCloseTo(0.2, 5);
    expect(r.kelly_fraction).toBeCloseTo(0.3333, 3);
    expect(r.size_usdc).toBeCloseTo(8.33, 1);
  });

  it("(b) positive NO edge → recommends NO with quarter-Kelly size", () => {
    // model thinks 30% YES, market prices 60% YES
    // edge_no = 0.30, kelly = 0.30 / 0.60 = 0.50
    // quarter-kelly = 0.125, capped to 0.20 → 0.125
    // size = 100 * 0.125 = $12.50
    const r = computeJudgeRecommendation({
      model_p_yes: 0.3,
      market_p_yes: 0.6,
      balance: 100,
    });
    expect(r.signal).toBe("NO");
    expect(r.edge_no).toBeCloseTo(0.3, 5);
    expect(r.kelly_fraction).toBeCloseTo(0.5, 5);
    expect(r.size_usdc).toBeCloseTo(12.5, 1);
  });

  it("(c) zero edge (model == market) → PASS", () => {
    const r = computeJudgeRecommendation({
      model_p_yes: 0.5,
      market_p_yes: 0.5,
      balance: 100,
    });
    expect(r.signal).toBe("PASS");
    expect(r.size_usdc).toBe(0);
    expect(r.edge_yes).toBeCloseTo(0, 9);
    expect(r.edge_no).toBeCloseTo(0, 9);
    expect(r.kelly_fraction).toBe(0);
  });

  it("(d) neither edge positive → PASS (mathematically equivalent to zero edge since edge_no = -edge_yes)", () => {
    // The formula has edge_no = market_p_yes - model_p_yes = -edge_yes, so
    // the only way for BOTH edges to be non-positive is for them to be zero.
    // This test documents that the "else" branch covers that case.
    const r = computeJudgeRecommendation({
      model_p_yes: 0.7,
      market_p_yes: 0.7,
      balance: 100,
    });
    expect(r.signal).toBe("PASS");
    expect(r.size_usdc).toBe(0);
  });

  it("(e) tiny positive edge → PASS due to $1 dust threshold", () => {
    // model_p_yes = 0.49, market_p_yes = 0.48
    // edge_yes = 0.01, kelly = 0.01 / 0.52 = 0.0192
    // quarter-kelly = 0.0048 → size = 100 * 0.0048 = $0.48 → dust → PASS
    const r = computeJudgeRecommendation({
      model_p_yes: 0.49,
      market_p_yes: 0.48,
      balance: 100,
    });
    expect(r.signal).toBe("PASS");
    expect(r.size_usdc).toBe(0);
    // Kelly fraction is still computed so the trace records the (sub-dust) edge.
    expect(r.kelly_fraction).toBeGreaterThan(0);
    expect(r.edge_yes).toBeCloseTo(0.01, 5);
  });

  it(
    "(f) Starmer case (literal spec: model_p_yes=0.32, market_p_yes=0.945) → recommends NO, not PASS",
    () => {
      // NOTE ON SPEC INCONSISTENCY:
      //
      // The user's task description specifies (model_p_yes = 0.32, market_p_yes
      // = 0.945) and asserts it "must return PASS". But under the exact formula
      // also given in the spec, this case yields:
      //   edge_no = 0.945 - 0.32 = +0.625 (a HUGE positive NO edge)
      //   kelly = 0.625 / 0.945 ≈ 0.661
      //   size = 100 × min(0.25 × 0.661, 0.20) = 100 × 0.165 = $16.53
      // → NO with $16.53, not PASS.
      //
      // PASS would happen only if (i) edge were sub-dust, (ii) probabilities
      // were equal, or (iii) an additional gate were added (none specified).
      //
      // We test what the formula PRODUCES rather than what the user spec asks
      // for, and surface the discrepancy in the run report. See test (f2)
      // below for the REAL Starmer numbers from the actual buggy run.
      const r = computeJudgeRecommendation({
        model_p_yes: 0.32,
        market_p_yes: 0.945,
        balance: 100,
      });
      expect(r.signal).toBe("NO");
      expect(r.edge_no).toBeCloseTo(0.625, 5);
      expect(r.kelly_fraction).toBeCloseTo(0.6614, 3);
      expect(r.size_usdc).toBeCloseTo(16.53, 1);
    },
  );

  it("(f2) Starmer REAL numbers (model_p_yes=0.32, market_p_yes=0.055) → recommends YES, replacing the old buggy NO", () => {
    // The actual Starmer run had market_p_yes = 0.055 (5.5¢ YES price), with the
    // buggy old logic recommending $10 NO. Under the new Kelly-aware logic:
    //   edge_yes = 0.32 - 0.055 = +0.265 (positive YES edge)
    //   kelly = 0.265 / (1 - 0.055) = 0.2804
    //   size = 100 × min(0.25 × 0.2804, 0.20) = 100 × 0.0701 = $7.01
    // → YES with $7.01. This is the CORRECT trade — buying YES at 5.5¢ when
    // the aggregated model thinks YES is 32% likely is high positive-EV.
    //
    // The original buggy logic was wrong in BOTH direction AND size — it
    // recommended NO (the negative-EV side) at $10 (a heuristic confidence-
    // band size that ignored market price entirely).
    const r = computeJudgeRecommendation({
      model_p_yes: 0.32,
      market_p_yes: 0.055,
      balance: 100,
    });
    expect(r.signal).toBe("YES");
    expect(r.edge_yes).toBeCloseTo(0.265, 5);
    expect(r.kelly_fraction).toBeCloseTo(0.2804, 3);
    expect(r.size_usdc).toBeCloseTo(7.01, 1);
  });

  it("respects the 20% balance cap when Kelly exceeds it", () => {
    // model = 0.95, market = 0.10 → edge_yes = 0.85, kelly = 0.85/0.90 ≈ 0.944
    // quarter-Kelly = 0.236, BUT capped to 0.20 → size = 100 * 0.20 = $20
    const r = computeJudgeRecommendation({
      model_p_yes: 0.95,
      market_p_yes: 0.1,
      balance: 100,
    });
    expect(r.signal).toBe("YES");
    expect(r.size_usdc).toBe(20);
    // Full Kelly was 0.944, but the cap kicked in.
    expect(r.kelly_fraction).toBeGreaterThan(0.8);
  });

  it("degenerate inputs (probability at boundary or NaN) → PASS", () => {
    expect(computeJudgeRecommendation({ model_p_yes: 0, market_p_yes: 0.5, balance: 100 }).signal).toBe("PASS");
    expect(computeJudgeRecommendation({ model_p_yes: 1, market_p_yes: 0.5, balance: 100 }).signal).toBe("PASS");
    expect(computeJudgeRecommendation({ model_p_yes: 0.5, market_p_yes: 0, balance: 100 }).signal).toBe("PASS");
    expect(computeJudgeRecommendation({ model_p_yes: 0.5, market_p_yes: 1, balance: 100 }).signal).toBe("PASS");
    expect(computeJudgeRecommendation({ model_p_yes: NaN, market_p_yes: 0.5, balance: 100 }).signal).toBe("PASS");
    expect(computeJudgeRecommendation({ model_p_yes: 0.5, market_p_yes: 0.5, balance: 0 }).signal).toBe("PASS");
  });
});

/**
 * Integration tests for runJudgeAgent. These mock the Anthropic client and
 * verify the wiring: the model's model_probability_yes flows through, the
 * orchestrator overrides signal/size from the Kelly formula, and trace fields
 * (edge_yes/edge_no/kelly_fraction/market_price_yes) are populated.
 */
describe("runJudgeAgent (wiring tests)", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("emits a JudgeTrace with derived signal + edge fields from model_probability_yes", async () => {
    // Model says probability YES = 0.62, market is at 0.42 → edge_yes = +0.20
    // kelly = 0.20/0.58 ≈ 0.345, quarter-kelly ≈ 0.086, size = $8.62
    const { client } = makeMockClient([{ traceFields: VALID_JUDGE_FIELDS }]);
    setClient(client);

    const { trace } = await runJudgeAgent({
      context: FIXTURE_CONTEXT, // current_yes_price = 0.42
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
    expect(trace.model_probability_yes).toBe(0.62);
    expect(trace.market_price_yes).toBe(0.42);
    expect(trace.edge_yes).toBeCloseTo(0.2, 4);
    expect(trace.edge_no).toBeCloseTo(-0.2, 4);
    expect(trace.kelly_fraction).toBeGreaterThan(0.3);
    expect(trace.signal).toBe("YES");
    expect(trace.recommended_size_usdc).toBeGreaterThan(5);
    expect(trace.recommended_size_usdc).toBeLessThan(15);
    expect(trace.disagreement_analysis).toBeTruthy();
  });

  it("OVERRIDES the model's signal when probability + price imply the opposite side", async () => {
    // Pathological case: the LLM emits signal="YES" but model_probability_yes
    // = 0.20 while market_p_yes = 0.42. The actual positive-EV trade is NO.
    // The orchestrator must override signal to NO and size accordingly.
    const conflictingFields = {
      ...VALID_JUDGE_FIELDS,
      signal: "YES" as const,
      model_probability_yes: 0.2,
    };
    const { client } = makeMockClient([{ traceFields: conflictingFields }]);
    setClient(client);

    const { trace } = await runJudgeAgent({
      context: FIXTURE_CONTEXT, // 0.42
      userBalanceUsdc: 100,
      agentTraces: [
        fakeAgentTrace("news", "NO", 70),
        fakeAgentTrace("sentiment", "NO", 60),
        fakeAgentTrace("historical", "NO", 75),
        fakeAgentTrace("market_structure", "NO", 65),
      ],
    });

    expect(trace.signal).toBe("NO"); // overridden from model's YES
    expect(trace.recommended_size_usdc).toBeGreaterThan(0);
  });

  it("forces PASS + size=0 when model_probability_yes equals market_p_yes", async () => {
    const noEdgeFields = {
      ...VALID_JUDGE_FIELDS,
      signal: "YES" as const,
      model_probability_yes: 0.42, // exactly market_p_yes
    };
    const { client } = makeMockClient([{ traceFields: noEdgeFields }]);
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
    expect(trace.kelly_fraction).toBe(0);
  });

  it("uses the Judge JSON schema (model_probability_yes required)", async () => {
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
    expect(oc.format.schema.required).toContain("model_probability_yes");
    expect(oc.format.schema.required).toContain("disagreement_analysis");
    expect(oc.format.schema.required).toContain("agent_signals");
  });
});
