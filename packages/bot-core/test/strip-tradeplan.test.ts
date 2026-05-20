/**
 * Unit tests for stripTradeplanFromTrace — the redactor that runs before
 * the IPFS pin in confidential mode so that publicly-fetchable trace
 * JSON does not leak the user's bankroll or position size.
 *
 * The function is pure (structuredClone + deletes), so all six tests are
 * trivially deterministic.
 *
 * Fixture strategy: the user-economic fields are the ONLY places in the
 * fixture trace that contain dollar amounts or the literal word
 * "bankroll" — every other field is built from non-economic text. That
 * way assertions 4 + 5 (no "bankroll" / no $XX.XX in JSON.stringify of
 * the stripped trace) prove the redactor reached every nesting level.
 */
import { describe, expect, it } from "vitest";

import { stripTradeplanFromTrace } from "../src/insight.js";
import type {
  AgentTrace,
  FullTrace,
  JudgeEnsemble,
  JudgeEnsembleRun,
  JudgeTrace,
} from "@stoa/insight-engine";

const baseAgent: AgentTrace = {
  agent: "news",
  market_url: "https://polymarket.com/market/example",
  market_question: "Will example resolve YES?",
  thesis: "Recent reporting points to YES.",
  evidence: [],
  counter_arguments: "Sample size is small.",
  confidence: 60,
  signal: "YES",
  reasoning: "Long-form non-economic reasoning here.",
  timestamp: "2026-05-20T00:00:00Z",
  model: "claude-haiku-4-5",
  token_usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

function judgeFixture(
  recommendation_reason: string,
  recommended_size_usdc: number,
  kelly_fraction: number,
): JudgeTrace {
  return {
    ...baseAgent,
    agent: "judge",
    disagreement_analysis: "Agents broadly agreed.",
    agent_signals: {},
    model_probability_yes: 0.62,
    market_price_yes: 0.55,
    edge_yes: 0.07,
    edge_no: -0.07,
    kelly_fraction,
    recommended_size_usdc,
    ci_low: 0.55,
    ci_high: 0.7,
    outside_view_p_yes: null,
    inside_view_adjustment: null,
    status_quo_outcome: "YES",
    no_scenario: { description: "Status quo holds for NO", weight: 0.4 },
    yes_scenario: { description: "Status quo holds for YES", weight: 0.6 },
    risk_decomposition: [],
    reevaluation_triggers: [],
    stability: "stable",
    recommendation_reason,
  };
}

// Substrings that the fixture deliberately embeds inside the
// to-be-stripped fields (recommendation_reason). These exist as
// formatted text inside the fixture, NOT as numeric JSON values, so
// JSON.stringify of the ORIGINAL must contain each one and JSON.stringify
// of the stripped trace must contain none.
const ECONOMIC_SUBSTRINGS = ["bankroll", "$28.94", "$2.10"];

function buildFixture(): FullTrace {
  const aggregate = judgeFixture(
    "Sized at 12% of $28.94 bankroll per Kelly fraction.",
    3.45,
    0.12,
  );
  const run1: JudgeEnsembleRun = {
    model: "claude-sonnet-4-6",
    trace: judgeFixture(
      "Run-1 sized $2.10 of bankroll for diversified exposure.",
      2.1,
      0.073,
    ),
    cost_usd: 0.03,
  };
  const run2: JudgeEnsembleRun = {
    model: "claude-haiku-4-5",
    trace: judgeFixture("Run-2 leaned PASS — no clear edge.", 0, 0),
    cost_usd: 0.01,
  };
  const ensemble: JudgeEnsemble = {
    aggregate,
    runs: [run1, run2],
    verdict_agreement: 1,
    directional_agreement: 1,
    fallback_single_model: false,
    total_cost_usd: 0.04,
  };
  return {
    schema_version: "stoa.insight.v1",
    market_url: "https://polymarket.com/market/example",
    market_question: "Will example resolve YES?",
    user_balance_usdc: 28.94,
    agent_traces: [
      { ...baseAgent, agent: "news" },
      { ...baseAgent, agent: "sentiment" },
    ],
    judge_trace: aggregate,
    judge_ensemble: ensemble,
    final_signal: "YES",
    final_confidence: 62,
    recommended_size_usdc: 3.45,
    total_token_usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      estimated_cost_usd: 0.04,
    },
    started_at: "2026-05-20T00:00:00Z",
    finalized_at: "2026-05-20T00:00:30Z",
  };
}

describe("stripTradeplanFromTrace", () => {
  it("is idempotent — strip twice equals strip once", () => {
    const trace = buildFixture();
    const once = stripTradeplanFromTrace(trace);
    const twice = stripTradeplanFromTrace(once);
    expect(twice).toEqual(once);
  });

  it("preserves non-economic fields used by trace verifiers", () => {
    const stripped = stripTradeplanFromTrace(buildFixture());
    expect(stripped.market_question).toBe("Will example resolve YES?");
    expect(stripped.agent_traces).toHaveLength(2);
    expect(stripped.final_signal).toBe("YES");
    expect(stripped.judge_ensemble?.aggregate.model_probability_yes).toBe(0.62);
    expect(stripped.judge_ensemble?.aggregate.reasoning).toBe(
      "Long-form non-economic reasoning here.",
    );
    expect(stripped.judge_ensemble?.aggregate.thesis).toBe(
      "Recent reporting points to YES.",
    );
  });

  it("removes every economic field at every nesting level", () => {
    const stripped = stripTradeplanFromTrace(buildFixture()) as Record<
      string,
      unknown
    >;
    // Top-level
    expect(stripped).not.toHaveProperty("user_balance_usdc");
    expect(stripped).not.toHaveProperty("recommended_size_usdc");
    // judge_trace mirror
    const jt = stripped.judge_trace as Record<string, unknown>;
    expect(jt).not.toHaveProperty("recommended_size_usdc");
    expect(jt).not.toHaveProperty("kelly_fraction");
    expect(jt).not.toHaveProperty("recommendation_reason");
    // judge_ensemble.aggregate
    const ens = stripped.judge_ensemble as {
      aggregate: Record<string, unknown>;
      runs: Array<{ trace: Record<string, unknown> }>;
    };
    expect(ens.aggregate).not.toHaveProperty("recommended_size_usdc");
    expect(ens.aggregate).not.toHaveProperty("kelly_fraction");
    expect(ens.aggregate).not.toHaveProperty("recommendation_reason");
    // judge_ensemble.runs[]
    for (const run of ens.runs) {
      expect(run.trace).not.toHaveProperty("recommended_size_usdc");
      expect(run.trace).not.toHaveProperty("kelly_fraction");
      expect(run.trace).not.toHaveProperty("recommendation_reason");
    }
  });

  it("serialised stripped trace does not contain the substring 'bankroll'", () => {
    const stripped = stripTradeplanFromTrace(buildFixture());
    const json = JSON.stringify(stripped);
    expect(json).not.toContain("bankroll");
  });

  it("serialised stripped trace contains no $XX.XX dollar amount", () => {
    const stripped = stripTradeplanFromTrace(buildFixture());
    const json = JSON.stringify(stripped);
    expect(json).not.toMatch(/\$\d+\.\d{2}/);
  });

  it("does not mutate the original trace (structuredClone semantics)", () => {
    const original = buildFixture();
    const snapshot = JSON.stringify(original);
    stripTradeplanFromTrace(original);
    expect(JSON.stringify(original)).toBe(snapshot);
    // Sanity: every economic substring still appears in the ORIGINAL.
    for (const s of ECONOMIC_SUBSTRINGS) {
      expect(snapshot).toContain(s);
    }
  });
});
