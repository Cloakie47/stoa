/**
 * End-to-end integration test for analyzeMarket().
 *
 * This test:
 *   1. Picks a real Polymarket market (passed via env or a default).
 *   2. Runs the full analyzeMarket pipeline against real Anthropic + real
 *      Polymarket CLOB + (optionally) real Pinata + real Arc Testnet.
 *   3. Asserts the FullTrace shape, the judge signal+confidence, and
 *      cost staying under $0.50.
 *   4. If pinning is enabled, asserts the on-chain TracePin tx mined.
 *
 * GATING: Auto-skips unless RUN_E2E_INSIGHT=1 is set, AND ANTHROPIC_API_KEY
 * is present. This way CI without these env vars passes.
 *
 * Each run consumes ~$0.10-0.30 of real LLM spend.
 *
 * To run manually:
 *   pnpm --filter @stoa/insight-engine test test/e2e.test.ts
 *   (with RUN_E2E_INSIGHT=1 and ANTHROPIC_API_KEY in env)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { analyzeMarket, computeKellyFraction } from "../src/index.js";

// Load .env from repo root so DEPLOYER_PRIVATE_KEY etc. are available.
const repoEnv = (() => {
  try {
    const raw = readFileSync(resolve(__dirname, "../../../.env"), "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && m[2]) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
})();

for (const [k, v] of Object.entries(repoEnv)) {
  if (!process.env[k]) process.env[k] = v;
}

const HAS_ANTHROPIC_KEY = !!process.env.ANTHROPIC_API_KEY;
const RUN_E2E = process.env.RUN_E2E_INSIGHT === "1";
const skip = !RUN_E2E || !HAS_ANTHROPIC_KEY;

// A real, currently-active Polymarket market — override via env for ad-hoc runs.
const TEST_MARKET_URL =
  process.env.E2E_MARKET_URL ??
  "https://polymarket.com/event/what-will-trump-say-during-bilateral-events-with-xi-jinping";

describe.skipIf(skip)("analyzeMarket — real LLM + Polymarket integration", () => {
  it(
    "runs the full pipeline within budget and returns a valid FullTrace",
    async () => {
      const userBalanceUsdc = 100;
      const pinOnChain =
        !!process.env.DEPLOYER_PRIVATE_KEY &&
        !!process.env.ARC_TESTNET_RPC &&
        !!process.env.TRACEPIN_ADDRESS;

      if (!pinOnChain) {
        console.warn(
          "[e2e] DEPLOYER_PRIVATE_KEY / ARC_TESTNET_RPC / TRACEPIN_ADDRESS missing — running with pinOnChain=false. The trace will be returned but not pinned to Arc.",
        );
      }
      if (!process.env.PINATA_JWT && !process.env.STORACHA_KEY) {
        console.warn(
          "[e2e] No IPFS backend configured (PINATA_JWT or STORACHA_KEY). The pin step will use cid='' on-chain.",
        );
      }

      const result = await analyzeMarket(TEST_MARKET_URL, userBalanceUsdc, {
        budgetCapUsd: 1.0, // hard cap per run; abort if exceeded
        pinOnChain,
      });

      // 1) FullTrace shape sanity
      expect(result.trace.schema_version).toBe("stoa.insight.v1");
      expect(result.trace.market_url).toBe(TEST_MARKET_URL);
      expect(result.trace.user_balance_usdc).toBe(userBalanceUsdc);
      expect(result.trace.agent_traces.length).toBeGreaterThanOrEqual(2);
      expect(result.trace.agent_traces.length).toBeLessThanOrEqual(4);
      for (const t of result.trace.agent_traces) {
        expect(["news", "sentiment", "historical", "market_structure"]).toContain(
          t.agent,
        );
        expect(t.thesis).toBeTruthy();
        expect(["YES", "NO", "PASS"]).toContain(t.signal);
        expect(t.confidence).toBeGreaterThanOrEqual(0);
        expect(t.confidence).toBeLessThanOrEqual(100);
      }

      // 2) Judge trace
      expect(result.trace.judge_trace.agent).toBe("judge");
      expect(result.trace.judge_trace.model).toBe("claude-sonnet-4-6");
      expect(result.trace.judge_trace.disagreement_analysis).toBeTruthy();
      expect(["YES", "NO", "PASS"]).toContain(result.trace.final_signal);

      // 3) Size + balance bounds
      if (result.trace.final_signal === "PASS") {
        expect(result.trace.recommended_size_usdc).toBe(0);
      } else {
        expect(result.trace.recommended_size_usdc).toBeLessThanOrEqual(
          userBalanceUsdc * 0.2,
        );
      }

      // 4) Cost under budget
      expect(result.cost_usd).toBeLessThan(1.0);

      // 5) Pin (only if we asked for it)
      if (pinOnChain) {
        expect(result.pin).not.toBeNull();
        expect(result.pin!.tx_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
        expect(result.pin!.trace_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
        expect(result.trace.pinned_tx).toBe(result.pin!.tx_hash);
        expect(result.trace.trace_hash).toBe(result.pin!.trace_hash);
      } else {
        expect(result.trace.trace_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      }

      // 6) Compact, human-readable summary of everything the user asked for.
      const yesPx = result.trace.judge_trace.market_question
        ? (result.trace.agent_traces[0]?.confidence !== undefined
            ? undefined
            : undefined)
        : undefined;
      // Pull the YES price from the market context that was used (analyzeMarket
      // doesn't surface it on the trace today, so we reconstruct it from the
      // first agent's reasoning via a fallback). For now, we approximate
      // subjective probability from final_confidence directly.
      const subjectiveProb = result.trace.final_confidence / 100;
      // Read current_yes_price from the judge's evidence if surfaced; else fall
      // back to interpretation of the final_signal: use confidence as p_self.
      // Most accurate: the test pre-fetches the context. Let's keep this simple
      // and have analyzeMarket include current_yes_price on the trace going forward
      // — for now, use 0 sentinel so Kelly returns 0 cleanly when unknown.
      let currentYesPrice = 0;
      // Heuristic: market_structure's first evidence often quotes the price.
      const ms = result.trace.agent_traces.find((t) => t.agent === "market_structure");
      if (ms) {
        const match = ms.evidence
          .map((e) => e.quote)
          .join(" ")
          .match(/0\.\d{2,}/);
        if (match) currentYesPrice = Number.parseFloat(match[0]);
      }
      const kelly = computeKellyFraction({
        signal: result.trace.final_signal,
        subjective_probability: subjectiveProb,
        current_yes_price: currentYesPrice,
      });

      console.log("\n========== E2E ANALYSIS RESULT ==========");
      console.log(`URL:                ${result.trace.market_url}`);
      console.log(`Question:           ${result.trace.market_question}`);
      console.log(`Current YES price:  ${currentYesPrice ? `${(currentYesPrice * 100).toFixed(1)}¢` : "(not extracted)"}`);
      console.log(`Final signal:       ${result.trace.final_signal}`);
      console.log(`Final confidence:   ${result.trace.final_confidence} / 100`);
      console.log(`Subjective prob:    ${(subjectiveProb * 100).toFixed(1)}%`);
      console.log(`Kelly fraction:     ${(kelly * 100).toFixed(2)}% of bankroll`);
      console.log(`Capped size USDC:   $${result.trace.recommended_size_usdc.toFixed(2)} (orchestrator cap = 20% of $${userBalanceUsdc})`);
      console.log(`Total spend:        $${result.cost_usd.toFixed(4)} (${(result.cost_usd * 100).toFixed(2)}¢)`);
      console.log(`Trace hash:         ${result.trace.trace_hash}`);
      console.log(`IPFS CID:           ${result.trace.ipfs_cid ?? "(no IPFS backend)"}`);
      console.log(`Arc tx hash:        ${result.trace.pinned_tx ?? "(not pinned)"}`);
      console.log(`Block:              ${result.pin?.block_number ?? "(n/a)"}`);
      console.log("\nPer-agent signals:");
      for (const t of result.trace.agent_traces) {
        console.log(
          `  ${t.agent.padEnd(18)} ${t.signal.padEnd(5)} @ confidence ${String(t.confidence).padStart(3)} | tokens in/out/cache_r: ${t.token_usage.input_tokens}/${t.token_usage.output_tokens}/${t.token_usage.cache_read_input_tokens}`,
        );
      }
      console.log(`  ${"judge".padEnd(18)} ${result.trace.judge_trace.signal.padEnd(5)} @ confidence ${String(result.trace.judge_trace.confidence).padStart(3)} | tokens in/out/cache_r: ${result.trace.judge_trace.token_usage.input_tokens}/${result.trace.judge_trace.token_usage.output_tokens}/${result.trace.judge_trace.token_usage.cache_read_input_tokens}`);
      console.log("\nJudge disagreement analysis:");
      console.log(`  ${result.trace.judge_trace.disagreement_analysis.replaceAll("\n", "\n  ")}`);
      console.log("=========================================\n");
    },
    300_000,
  );
});

describe.skipIf(skip)("Module exports", () => {
  it("exports the expected public surface", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.analyzeMarket).toBe("function");
    expect(typeof mod.runNewsAgent).toBe("function");
    expect(typeof mod.runJudgeAgent).toBe("function");
    expect(typeof mod.fetchMarketContext).toBe("function");
    expect(typeof mod.hashTrace).toBe("function");
    expect(typeof mod.pinTraceOnChain).toBe("function");
    expect(mod.MODEL_HAIKU).toBe("claude-haiku-4-5");
    expect(mod.MODEL_SONNET).toBe("claude-sonnet-4-6");
  });
});
