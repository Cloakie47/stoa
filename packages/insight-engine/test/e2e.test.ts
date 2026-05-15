/**
 * End-to-end integration test for analyzeMarket().
 *
 * Default behavior: queries the Polymarket Gamma API to find a NON-RESOLVED
 * highest-volume market closing 3-14 days out (YES price 0.05-0.95), then
 * runs the full pipeline against it. Override via E2E_MARKET_URL.
 *
 * GATING: Auto-skips unless RUN_E2E_INSIGHT=1 is set AND ANTHROPIC_API_KEY is
 * present. CI without these env vars passes cleanly.
 *
 * Each run consumes ~$0.10-0.30 of real LLM spend.
 *
 * Usage:
 *   RUN_E2E_INSIGHT=1 pnpm test test/e2e.test.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  analyzeMarket,
  computeKellyFraction,
  fetchMarketContext,
} from "../src/index.js";
import type { MarketContext } from "../src/types.js";

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

interface GammaMarketSearchResult {
  slug: string;
  question: string;
  endDateIso?: string;
  endDate?: string;
  outcomePrices?: string | string[];
  outcomes?: string | string[];
  volumeNum?: number;
  volume24hrNum?: number;
  active?: boolean;
  closed?: boolean;
}

/**
 * Query Gamma for an active, non-resolved binary market closing 3-14 days
 * from now with YES price between 0.05 and 0.95. Sort by 24h volume
 * descending and return the URL of the top match.
 *
 * We ask Gamma for a generous sample (limit=100, active=true, closed=false,
 * end_date_min/max bounded). Gamma supports these filters per the docs.
 */
async function findNonResolvedTestMarket(): Promise<string> {
  const nowMs = Date.now();
  const minEnd = new Date(nowMs + 3 * 86_400_000).toISOString();
  const maxEnd = new Date(nowMs + 14 * 86_400_000).toISOString();
  const params = new URLSearchParams({
    active: "true",
    closed: "false",
    limit: "100",
    order: "volume24hr",
    ascending: "false",
    end_date_min: minEnd,
    end_date_max: maxEnd,
  });
  const url = `https://gamma-api.polymarket.com/markets?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Gamma /markets filter query returned ${res.status} (URL: ${url})`,
    );
  }
  const body = (await res.json()) as GammaMarketSearchResult[];
  const candidates: Array<{ raw: GammaMarketSearchResult; yesPrice: number }> = [];
  for (const m of body) {
    if (!m.active || m.closed) continue;
    if (!m.slug) continue;
    // Parse outcomePrices to filter by current YES price range.
    let prices: number[] = [];
    if (typeof m.outcomePrices === "string") {
      try {
        const parsed = JSON.parse(m.outcomePrices) as unknown;
        if (Array.isArray(parsed)) {
          prices = parsed.map((p) =>
            typeof p === "string" ? Number.parseFloat(p) : (p as number),
          );
        }
      } catch {
        continue;
      }
    } else if (Array.isArray(m.outcomePrices)) {
      prices = m.outcomePrices.map((p) =>
        typeof p === "string" ? Number.parseFloat(p) : (p as number),
      );
    }
    if (prices.length < 2) continue;
    const yesPrice = prices[0]!;
    if (!Number.isFinite(yesPrice)) continue;
    if (yesPrice < 0.05 || yesPrice > 0.95) continue;
    candidates.push({ raw: m, yesPrice });
  }
  if (candidates.length === 0) {
    throw new Error(
      `No non-resolved markets matched filters (3-14d to close, YES price 0.05-0.95). Sampled ${body.length} markets.`,
    );
  }
  // Sort by 24h volume desc.
  candidates.sort(
    (a, b) => (b.raw.volume24hrNum ?? 0) - (a.raw.volume24hrNum ?? 0),
  );
  const picked = candidates[0]!;
  const pickedUrl = `https://polymarket.com/market/${picked.raw.slug}`;
  console.log(
    `[e2e] Auto-picked non-resolved market: "${picked.raw.question}" — slug=${picked.raw.slug}, YES=${(picked.yesPrice * 100).toFixed(1)}¢, 24h_vol=$${Math.round(picked.raw.volume24hrNum ?? 0).toLocaleString()}, ends=${picked.raw.endDateIso ?? picked.raw.endDate}`,
  );
  console.log(
    `[e2e] (${candidates.length} candidates matched; runners-up: ${candidates.slice(1, 4).map((c) => `"${c.raw.question.slice(0, 40)}…" @ ${(c.yesPrice * 100).toFixed(0)}¢`).join(", ")})`,
  );
  return pickedUrl;
}

describe.skipIf(skip)("analyzeMarket — real LLM + Polymarket integration", () => {
  it(
    "runs the full pipeline within budget and returns a valid FullTrace",
    async () => {
      const userBalanceUsdc = 100;

      // Pick market: env override > auto-pick.
      const marketUrl =
        process.env.E2E_MARKET_URL ?? (await findNonResolvedTestMarket());

      // Pre-fetch context so we have current_yes_price for Kelly without
      // string-matching the agents' evidence. analyzeMarket will use the
      // same context when passed via opts.preFetchedContext.
      const context: MarketContext = await fetchMarketContext(marketUrl);

      const pinOnChain =
        !!process.env.DEPLOYER_PRIVATE_KEY &&
        !!process.env.ARC_TESTNET_RPC &&
        !!process.env.TRACEPIN_ADDRESS;
      if (!pinOnChain) {
        console.warn(
          "[e2e] DEPLOYER_PRIVATE_KEY / ARC_TESTNET_RPC / TRACEPIN_ADDRESS missing — running with pinOnChain=false.",
        );
      }
      if (!process.env.PINATA_JWT && !process.env.STORACHA_KEY) {
        console.warn(
          "[e2e] No IPFS backend configured. Pin step will use cid='' on-chain.",
        );
      }

      const result = await analyzeMarket(marketUrl, userBalanceUsdc, {
        budgetCapUsd: 1.0,
        pinOnChain,
        preFetchedContext: context,
      });

      // Basic shape assertions
      expect(result.trace.schema_version).toBe("stoa.insight.v1");
      expect(result.trace.market_url).toBe(marketUrl);
      expect(result.trace.agent_traces.length).toBeGreaterThanOrEqual(2);
      expect(result.trace.judge_trace.agent).toBe("judge");
      expect(["YES", "NO", "PASS"]).toContain(result.trace.final_signal);
      expect(result.cost_usd).toBeLessThan(1.0);
      if (pinOnChain) {
        expect(result.pin).not.toBeNull();
        expect(result.pin!.tx_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      }

      // Identify failed agents (the ones missing from the trace).
      const expectedAgents = ["news", "sentiment", "historical", "market_structure"] as const;
      const presentAgents = new Set(result.trace.agent_traces.map((t) => t.agent));
      const failedAgents = expectedAgents.filter((a) => !presentAgents.has(a));

      const subjectiveProb = result.trace.final_confidence / 100;
      const currentYesPrice = context.current_yes_price ?? 0;
      const kelly = computeKellyFraction({
        signal: result.trace.final_signal,
        subjective_probability: subjectiveProb,
        current_yes_price: currentYesPrice,
      });

      console.log("\n========== E2E ANALYSIS RESULT ==========");
      console.log(`URL:                ${result.trace.market_url}`);
      console.log(`Question:           ${result.trace.market_question}`);
      console.log(
        `Current YES price:  ${currentYesPrice ? `${(currentYesPrice * 100).toFixed(1)}¢` : "(unknown)"}`,
      );
      console.log(`Final signal:       ${result.trace.final_signal}`);
      console.log(
        `Final confidence:   ${result.trace.final_confidence} / 100`,
      );
      console.log(`Subjective prob:    ${(subjectiveProb * 100).toFixed(1)}%`);
      console.log(`Kelly fraction:     ${(kelly * 100).toFixed(2)}% of bankroll`);
      console.log(
        `Capped size USDC:   $${result.trace.recommended_size_usdc.toFixed(2)} (orchestrator cap = 20% of $${userBalanceUsdc})`,
      );
      console.log(
        `Total spend:        $${result.cost_usd.toFixed(4)} (${(result.cost_usd * 100).toFixed(2)}¢)`,
      );
      console.log(`Trace hash:         ${result.trace.trace_hash}`);
      console.log(
        `IPFS CID:           ${result.trace.ipfs_cid ?? "(no IPFS backend)"}`,
      );
      console.log(
        `Arc tx hash:        ${result.trace.pinned_tx ?? "(not pinned)"}`,
      );
      console.log(`Block:              ${result.pin?.block_number ?? "(n/a)"}`);

      console.log("\nPer-agent signals + token usage:");
      for (const t of result.trace.agent_traces) {
        console.log(
          `  ${t.agent.padEnd(18)} ${t.signal.padEnd(5)} @ ${String(t.confidence).padStart(3)} | in=${String(t.token_usage.input_tokens).padStart(7)} out=${String(t.token_usage.output_tokens).padStart(5)} cache_r=${String(t.token_usage.cache_read_input_tokens).padStart(5)}`,
        );
      }
      console.log(
        `  ${"judge".padEnd(18)} ${result.trace.judge_trace.signal.padEnd(5)} @ ${String(result.trace.judge_trace.confidence).padStart(3)} | in=${String(result.trace.judge_trace.token_usage.input_tokens).padStart(7)} out=${String(result.trace.judge_trace.token_usage.output_tokens).padStart(5)} cache_r=${String(result.trace.judge_trace.token_usage.cache_read_input_tokens).padStart(5)}`,
      );

      if (failedAgents.length > 0) {
        console.log(
          `\nFAILED AGENTS (no trace returned): ${failedAgents.join(", ")}`,
        );
        console.log(
          "  (Check the [analyzeMarket] specialist failed: ... warnings above for root cause.)",
        );
      } else {
        console.log("\nAll 4 specialists returned traces. ✓");
      }

      console.log("\nJudge disagreement analysis:");
      console.log(
        `  ${result.trace.judge_trace.disagreement_analysis.replaceAll("\n", "\n  ")}`,
      );
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
