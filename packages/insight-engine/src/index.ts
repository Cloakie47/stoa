/**
 * @stoa/insight-engine — multi-agent Polymarket analysis.
 *
 * Entry point: {@link analyzeMarket}. Given a Polymarket URL and the user's
 * USDC balance, runs 4 specialist Claude agents (News, Sentiment, Historical,
 * Market Structure) in parallel, feeds their AgentTraces to a Judge
 * aggregator (Sonnet 4.6), assembles the FullTrace, optionally pins it to
 * Arc Testnet + IPFS, and returns the result.
 *
 * Cost characteristics:
 *   - 4 parallel Haiku/Sonnet calls + 1 Judge call ≈ $0.10-0.30 per analysis
 *     (most cost is Sonnet Judge + Historical's adaptive thinking).
 *   - Prompt caching kicks in on the 2nd+ analysis as long as the system
 *     prompts haven't changed → roughly 90% reduction on cached prefix bytes.
 *
 * Public API:
 *   analyzeMarket(url, balance, opts?) → { trace, cost_usd, pin? }
 *
 * Re-exports for advanced consumers:
 *   - runNewsAgent, runSentimentAgent, runHistoricalAgent,
 *     runMarketStructureAgent, runJudgeAgent (each agent standalone)
 *   - fetchMarketContext, parsePolymarketUrl
 *   - pinTraceOnChain, hashTrace, uploadToIpfs
 *   - Types: AgentTrace, JudgeTrace, FullTrace, MarketContext, Signal
 */

import {
  runHistoricalAgent,
  synthesizeHistoricalFailureTrace,
} from "./agents/historical.js";
import { runJudgeAgent, runJudgeEnsemble } from "./agents/judge.js";
import { runMarketStructureAgent } from "./agents/market_structure.js";
import { runNewsAgent } from "./agents/news.js";
import { runSentimentAgent } from "./agents/sentiment.js";
import { addUsage, emptyUsage } from "./claude.js";
import { fetchMarketContext } from "./polymarket.js";
import {
  hashTrace,
  pinTraceOnChain,
  type PinTraceResult,
} from "./trace-pinning.js";
import type { AgentTrace, FullTrace, MarketContext, Signal } from "./types.js";

export {
  runNewsAgent,
  runSentimentAgent,
  runHistoricalAgent,
  synthesizeHistoricalFailureTrace,
  runMarketStructureAgent,
  runJudgeAgent,
  runJudgeEnsemble,
};
export {
  computeJudgeRecommendation,
  MIN_EDGE_FOR_TRADE,
  DUST_SIZE_USD,
  formatEdgeAbs,
  formatEdgeSigned,
  ENSEMBLE_VARIANTS,
  ENSEMBLE_MODELS,
  type EnsembleVariant,
  type JudgeRecommendation,
} from "./agents/judge.js";
export {
  fetchMarketContext,
  parsePolymarketUrl,
  getOrderbook,
  getPriceHistory,
  summarizeOrderbook,
  NoAnalyzableSubMarketError,
  MODERATE_PRICE_LOW,
  MODERATE_PRICE_HIGH,
} from "./polymarket.js";
export {
  pinTraceOnChain,
  hashTrace,
  uploadToIpfs,
  canonicalizeTraceForHashing,
} from "./trace-pinning.js";
export {
  MODEL_HAIKU,
  MODEL_SONNET,
  MODEL_OPUS,
  estimateCostUsd,
  getClient,
  setClient,
} from "./claude.js";
export type {
  AgentName,
  AgentTrace,
  JudgeTrace,
  JudgeEnsemble,
  JudgeEnsembleRun,
  CalibrationDomain,
  CalibrationAdjustment,
  ReferenceClassConfidence,
  ScenarioWeight,
  RiskBucket,
  FullTrace,
  MarketContext,
  Signal,
  EvidenceItem,
  TokenUsage,
  SubMarketSelection,
} from "./types.js";

/**
 * Compute the Kelly criterion optimal-bet fraction given:
 *   - the trade direction (YES / NO / PASS)
 *   - the agent's subjective probability of that direction winning, in [0,1]
 *   - the current Polymarket YES price, in [0,1]
 *
 * For a YES buy at price P with subjective prob p: f* = (p - P) / (1 - P)
 * For a NO buy at price (1-P) with subjective prob (1-P_market_on_yes-direction):
 *   we treat `subjective_prob` as the agent's probability of NO winning, and
 *   the cost of one NO share is (1 - yes_price). Kelly is symmetric:
 *   f* = (p - noPrice) / (1 - noPrice)
 *
 * Returns 0 for PASS, or when the bet has negative expected value (the
 * market price is higher than the subjective probability).
 */
export function computeKellyFraction(args: {
  signal: Signal;
  subjective_probability: number; // 0..1, probability that THIS signal direction wins
  current_yes_price: number; // 0..1
}): number {
  const { signal, subjective_probability: p, current_yes_price: yesPx } = args;
  if (signal === "PASS") return 0;
  if (!Number.isFinite(yesPx) || yesPx <= 0 || yesPx >= 1) return 0;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  if (signal === "YES") {
    const f = (p - yesPx) / (1 - yesPx);
    return Math.max(0, f);
  }
  // NO
  const noPx = 1 - yesPx;
  const f = (p - noPx) / (1 - noPx);
  return Math.max(0, f);
}

export interface AnalyzeMarketOptions {
  /**
   * Budget cap in USD. If the analysis is projected to exceed this, the
   * orchestrator throws BEFORE making the Judge call (which is the
   * most expensive single call).
   * Default: 5.00 (matches the hackathon-phase guardrail).
   */
  budgetCapUsd?: number;
  /**
   * If true (default), pin the FullTrace to Arc Testnet + IPFS. Set false
   * for dry-run analyses where you just want the FullTrace returned without
   * an on-chain side-effect.
   */
  pinOnChain?: boolean;
  /**
   * Pre-fetched context — skips the Polymarket Gamma fetch. Useful for
   * tests where you want to inject a fixed market without hitting the
   * network.
   */
  preFetchedContext?: MarketContext;
}

export interface AnalyzeMarketResult {
  trace: FullTrace;
  /** Same as trace.total_token_usage.estimated_cost_usd, exposed for ergonomics. */
  cost_usd: number;
  /** On-chain + IPFS pin result. Null when pinOnChain was false or pinning failed. */
  pin: PinTraceResult | null;
}

/**
 * Run the full multi-agent analysis pipeline against a Polymarket question.
 */
export async function analyzeMarket(
  marketUrl: string,
  userBalanceUsdc: number,
  opts: AnalyzeMarketOptions = {},
): Promise<AnalyzeMarketResult> {
  const { budgetCapUsd = 5.0, pinOnChain = true, preFetchedContext } = opts;
  const startedAt = new Date().toISOString();

  // 1. Market context — slug → Gamma → MarketContext
  const context =
    preFetchedContext ?? (await fetchMarketContext(marketUrl));

  // 2. Fan out the 4 specialists in parallel. They are independent — no
  //    inter-agent communication. Promise.allSettled so one bad agent
  //    doesn't kill the whole analysis.
  const settled = await Promise.allSettled([
    runNewsAgent(context),
    runSentimentAgent(context),
    runHistoricalAgent(context),
    runMarketStructureAgent(context),
  ]);

  const agentTraces: AgentTrace[] = [];
  let runningCost = 0;
  const errors: string[] = [];

  for (const [i, result] of settled.entries()) {
    const agentName = (
      ["news", "sentiment", "historical", "market_structure"] as const
    )[i]!;
    if (result.status === "fulfilled") {
      agentTraces.push(result.value.trace);
      runningCost += result.value.cost_usd;
    } else {
      const err = result.reason as Error;
      const msg = `[${agentName}] ${err?.message ?? String(err)}`;
      errors.push(msg);
      // Always surface failed agents — previously these were swallowed when
      // ≥2 other agents succeeded, making it impossible to debug from logs.
      console.warn(`[analyzeMarket] specialist failed: ${msg}`);
      // Historical-failure has a special path: silently dropping it lets the
      // Judge fabricate an outside view (the v1.1 Cepeda bug). Synthesize a
      // null-reference-class trace so OUTSIDE-VIEW VALIDATION case A fires
      // and the formatter shows "Reference class: insufficient" instead.
      if (agentName === "historical") {
        agentTraces.push(synthesizeHistoricalFailureTrace(context, err));
      }
    }
  }

  // Fail loud if more than half the specialists failed — the Judge can't
  // aggregate one trace usefully.
  if (agentTraces.length < 2) {
    throw new Error(
      `Fewer than 2 specialist agents returned a trace. Errors:\n${errors.join("\n")}`,
    );
  }

  // Budget check BEFORE Judge: if specialists already spent more than half
  // the cap, abort rather than commit to the expensive Sonnet call.
  if (runningCost > budgetCapUsd / 2) {
    throw new Error(
      `Specialists spent $${runningCost.toFixed(4)} > half of budget cap ($${budgetCapUsd}). Aborting before Judge call.`,
    );
  }

  // 3. Judge ensemble — Opus + Sonnet + Haiku in parallel, aggregated
  //    via median model_p_yes + majority verdict. Falls back to single
  //    model if STOA_DISABLE_ENSEMBLE=1 or all but one run fails.
  const ensemble = await runJudgeEnsemble({
    context,
    userBalanceUsdc,
    agentTraces,
  });
  runningCost += ensemble.total_cost_usd;

  if (runningCost > budgetCapUsd) {
    throw new Error(
      `Analysis cost $${runningCost.toFixed(4)} exceeded budget cap of $${budgetCapUsd}. Per-run cost: ${ensemble.runs
        .map((r) => `${r.model}=$${r.cost_usd.toFixed(4)}`)
        .join(", ")}`,
    );
  }

  // 4. Aggregate token usage across all calls
  let totalUsage = emptyUsage();
  for (const t of agentTraces) totalUsage = addUsage(totalUsage, t.token_usage);
  for (const r of ensemble.runs) {
    totalUsage = addUsage(totalUsage, r.trace.token_usage);
  }

  // 5. Build the FullTrace
  const finalSignal: Signal = ensemble.aggregate.signal;
  const fullTrace: FullTrace = {
    schema_version: "stoa.insight.v1",
    market_url: context.url,
    market_question: context.question,
    user_balance_usdc: userBalanceUsdc,
    agent_traces: agentTraces,
    judge_trace: ensemble.aggregate,
    judge_ensemble: ensemble,
    final_signal: finalSignal,
    final_confidence: ensemble.aggregate.confidence,
    recommended_size_usdc: ensemble.aggregate.recommended_size_usdc,
    total_token_usage: {
      ...totalUsage,
      estimated_cost_usd: Math.round(runningCost * 10_000) / 10_000,
    },
    started_at: startedAt,
    finalized_at: new Date().toISOString(),
  };

  // 6. Optionally pin
  let pin: PinTraceResult | null = null;
  if (pinOnChain) {
    try {
      pin = await pinTraceOnChain({ trace: fullTrace });
      fullTrace.trace_hash = pin.trace_hash;
      fullTrace.ipfs_cid = pin.ipfs_cid ?? undefined;
      fullTrace.pinned_tx = pin.tx_hash;
    } catch (e) {
      // Pinning failure is non-fatal — the trace itself is valuable even
      // without an on-chain artifact. Include the hash anyway so consumers
      // get the canonical fingerprint.
      console.warn(
        `[analyzeMarket] On-chain pinning failed: ${(e as Error).message}. Trace returned without pin.`,
      );
      fullTrace.trace_hash = hashTrace(fullTrace);
    }
  } else {
    fullTrace.trace_hash = hashTrace(fullTrace);
  }

  return {
    trace: fullTrace,
    cost_usd: fullTrace.total_token_usage.estimated_cost_usd,
    pin,
  };
}
