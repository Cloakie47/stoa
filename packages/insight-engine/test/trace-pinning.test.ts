import { describe, expect, it } from "vitest";

import {
  canonicalizeTraceForHashing,
  hashTrace,
} from "../src/trace-pinning.js";
import type { FullTrace } from "../src/types.js";

function buildFullTrace(overrides: Partial<FullTrace> = {}): FullTrace {
  return {
    schema_version: "stoa.insight.v1",
    market_url: "https://polymarket.com/market/test",
    market_question: "Will X happen?",
    user_balance_usdc: 100,
    agent_traces: [],
    judge_trace: {
      agent: "judge",
      market_url: "https://polymarket.com/market/test",
      market_question: "Will X happen?",
      thesis: "Yes",
      evidence: [{ source: "test", quote: "test" }],
      counter_arguments: "test",
      confidence: 70,
      signal: "YES",
      reasoning: "test reasoning",
      disagreement_analysis: "n/a",
      agent_signals: {},
      recommended_size_usdc: 10,
      timestamp: "2026-05-15T00:00:00.000Z",
      model: "claude-sonnet-4-6",
      token_usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    final_signal: "YES",
    final_confidence: 70,
    recommended_size_usdc: 10,
    total_token_usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      estimated_cost_usd: 0.001,
    },
    started_at: "2026-05-15T00:00:00.000Z",
    finalized_at: "2026-05-15T00:00:01.000Z",
    ...overrides,
  };
}

describe("canonicalizeTraceForHashing", () => {
  it("produces identical output regardless of key order", () => {
    const t1 = buildFullTrace();
    const t2 = buildFullTrace();
    // Reorder a couple of fields by re-spread:
    const reordered: FullTrace = {
      ...t2,
      market_question: t2.market_question,
      market_url: t2.market_url,
      schema_version: t2.schema_version,
    };
    expect(canonicalizeTraceForHashing(t1)).toBe(
      canonicalizeTraceForHashing(reordered),
    );
  });

  it("excludes trace_hash, ipfs_cid, and pinned_tx so pinning is idempotent", () => {
    const t = buildFullTrace();
    const tWithPin = buildFullTrace({
      trace_hash:
        "0xabcdef0000000000000000000000000000000000000000000000000000000000",
      ipfs_cid: "bafy...",
      pinned_tx:
        "0x1234560000000000000000000000000000000000000000000000000000000000",
    });
    expect(canonicalizeTraceForHashing(t)).toBe(
      canonicalizeTraceForHashing(tWithPin),
    );
  });
});

describe("hashTrace", () => {
  it("returns a 0x-prefixed 32-byte hex string", () => {
    const h = hashTrace(buildFullTrace());
    expect(h).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("is deterministic across calls with identical content", () => {
    expect(hashTrace(buildFullTrace())).toBe(hashTrace(buildFullTrace()));
  });

  it("differs when content differs", () => {
    const a = hashTrace(buildFullTrace());
    const b = hashTrace(buildFullTrace({ final_signal: "NO" }));
    expect(a).not.toBe(b);
  });
});
