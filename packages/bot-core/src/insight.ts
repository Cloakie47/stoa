/**
 * Wrapper around @stoa/insight-engine for use inside bot-core pipelines.
 *
 * The engine reads env via Node's `process.env`. The Worker exposes it via
 * `nodejs_compat`; the analyzer runs on Node natively. We mirror the
 * relevant secrets before each call so the engine's lazy reads find them.
 *
 * We always run with `pinOnChain: false` because trace pinning happens
 * inside `StoaSettler.settle()` (atomically with the payment). The engine
 * just computes the hash; we upload to IPFS via `uploadToIpfs` and hand
 * both to the settle() call ourselves.
 */
import {
  analyzeMarket,
  computeJudgeRecommendation,
  hashTrace,
  uploadToIpfs,
} from "@stoa/insight-engine";
import type {
  CalibrationDomain,
  FullTrace,
  MarketContext,
  Signal,
} from "@stoa/insight-engine";

import { applyCalibration } from "./calibration.js";
import type { BotCoreConfig } from "./config.js";

export interface SingleLLMSummary {
  signal_guess: Signal;
  one_liner: string;
  raw_text: string;
}

export interface FullAnalysis {
  trace: FullTrace;
  trace_hash: `0x${string}`;
  ipfs_cid: string | null;
  cost_usd: number;
}

function plumbEnv(cfg: BotCoreConfig): void {
  globalThis.process ??= { env: {} } as unknown as NodeJS.Process;
  globalThis.process.env ??= {} as NodeJS.ProcessEnv;
  process.env.ANTHROPIC_API_KEY = cfg.ANTHROPIC_API_KEY;
  if (cfg.PINATA_JWT) process.env.PINATA_JWT = cfg.PINATA_JWT;
}

/**
 * Compute hours_to_resolution from the MarketContext.end_date string.
 * Returns undefined when the date is missing or unparseable. We use this
 * to feed the long-horizon damp in the calibration policy.
 */
function hoursToResolution(context: MarketContext): number | undefined {
  if (!context.end_date) return undefined;
  const t = Date.parse(context.end_date);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, (t - Date.now()) / (1000 * 60 * 60));
}

/**
 * Full multi-agent analysis ($0.10–$0.30 in LLM costs typically — paid by
 * the operator's Anthropic key, recouped via the user-paid Stoa fee).
 *
 * Returns the FullTrace + its keccak256 hash + IPFS CID (if Pinata is
 * configured; else null). The caller passes hash + cid to StoaSettler.settle.
 *
 * After the multi-model Judge ensemble settles on a raw aggregate, this
 * function applies the v1.0 calibration policy (see ./calibration.ts) and
 * RECOMPUTES the Kelly sizing on the adjusted probability. Both raw and
 * adjusted probabilities are stored in the trace so the audit log can
 * verify the policy decision after the fact.
 */
export async function runFullAnalysis(
  cfg: BotCoreConfig,
  marketUrl: string,
  userBalanceUsdc: number,
  /** Pre-resolved context. Passed through when the pipeline already called
   *  fetchMarketContext separately (e.g. to refuse early on event URLs with
   *  no analyzable sub-markets before charging the fee). */
  preFetchedContext?: MarketContext,
): Promise<FullAnalysis> {
  plumbEnv(cfg);
  const result = await analyzeMarket(marketUrl, userBalanceUsdc, {
    pinOnChain: false,
    preFetchedContext,
  });

  // ── Apply calibration policy ───────────────────────────────────────────
  // The Judge classified the market (its `calibration_adjustment.domain`
  // field); the deterministic policy applies the actual shift here.
  const judge = result.trace.judge_trace;
  const rawPYes = judge.model_probability_yes;
  const market = result.trace.judge_trace.market_price_yes;
  // The ensemble's aggregate signal — set inside aggregateEnsembleRuns from
  // computeJudgeRecommendation(median_p, market_p). Capture it BEFORE any
  // mutation so calibration v1.2's PASS-preservation has a stable input.
  const ensembleSignal = judge.signal;
  const ctx: MarketContext = {
    url: result.trace.market_url,
    slug: "",
    question: result.trace.market_question,
    outcomes: [],
    current_yes_price: market,
    // end_date isn't carried through FullTrace, so the long-horizon check
    // is best-effort. When end_date is missing the policy still picks
    // the right adjustment for the named domains; only `other` short-circuits.
  };
  const hours = hoursToResolution(ctx);
  const domain: CalibrationDomain =
    (judge.calibration_adjustment?.domain as CalibrationDomain | undefined) ??
    "other";
  const cal = applyCalibration({
    raw_p: rawPYes,
    domain,
    market_p: market,
    ensemble_signal: ensembleSignal,
    hours_to_resolution: hours,
    raw_ci_low: judge.ci_low,
    raw_ci_high: judge.ci_high,
    judge_reason: judge.calibration_adjustment?.reason,
  });

  // Re-run Kelly on the CAPPED probability. When the ensemble was PASS,
  // cap === raw_p so the recommendation matches the ensemble's own. When
  // the ensemble was BUY, cap === slope-adjusted p and may strengthen edge.
  const rec = computeJudgeRecommendation({
    model_p_yes: cal.adjusted_p_capped,
    market_p_yes: market,
    balance: userBalanceUsdc,
  });

  // Mutate judge_trace + FullTrace in place so consumers (DB, IPFS, formatter)
  // all see the calibrated values. We keep the RAW prob in calibration_adjustment.
  judge.model_probability_yes = cal.adjusted_p_capped;
  // CI bounds get the same slope transform — otherwise the point estimate can
  // fall outside its own CI (the v1.0 Uzbekistan symptom: P(YES)=0.13 with
  // 80% CI 0.00–0.01). When the gate fires OR the cap fires, applyCalibration
  // returns the raw bounds verbatim, so this is always consistent.
  if (typeof cal.adjusted_ci_low === "number") {
    judge.ci_low = Math.round(cal.adjusted_ci_low * 10_000) / 10_000;
  }
  if (typeof cal.adjusted_ci_high === "number") {
    judge.ci_high = Math.round(cal.adjusted_ci_high * 10_000) / 10_000;
  }
  judge.edge_yes = Math.round(rec.edge_yes * 10_000) / 10_000;
  judge.edge_no = Math.round(rec.edge_no * 10_000) / 10_000;
  judge.kelly_fraction = Math.round(rec.kelly_fraction * 10_000) / 10_000;
  judge.recommended_size_usdc = rec.size_usdc;
  judge.signal = rec.signal;
  judge.recommendation_reason = rec.reason;
  judge.calibration_adjustment = cal.adjustment;

  result.trace.final_signal = rec.signal;
  result.trace.recommended_size_usdc = rec.size_usdc;
  result.trace.final_confidence = judge.confidence;

  console.log(
    `[insight] calibration domain=${domain} raw_p=${rawPYes.toFixed(4)} ` +
      `ensemble=${ensembleSignal} ` +
      `candidate_p=${cal.adjusted_p_yes.toFixed(4)} ` +
      `capped_p=${cal.adjusted_p_capped.toFixed(4)} ` +
      `bps_raw=${cal.adjustment.adjustment_applied} ` +
      `bps_capped=${cal.adjustment.adjustment_applied_capped ?? cal.adjustment.adjustment_applied} ` +
      `override=${cal.calibration_override ?? "-"} ` +
      `final=${rec.signal} size=$${rec.size_usdc.toFixed(2)}`,
  );

  // ── Hash + IPFS pin ────────────────────────────────────────────────────
  const trace_hash = hashTrace(result.trace);
  result.trace.trace_hash = trace_hash;
  let cid: string | null = null;
  try {
    cid = await uploadToIpfs(result.trace);
  } catch (e) {
    console.warn(`[insight] IPFS upload failed: ${(e as Error).message}`);
  }
  if (cid) result.trace.ipfs_cid = cid;
  return {
    trace: result.trace,
    trace_hash,
    ipfs_cid: cid,
    cost_usd: result.cost_usd,
  };
}

/**
 * Free /preview path — single Claude call summarizing the market. Used by
 * the Worker directly (synchronous, fast). No trace pin, no Stoa fee.
 */
export async function runSingleLLMPreview(
  cfg: BotCoreConfig,
  marketUrl: string,
): Promise<SingleLLMSummary> {
  plumbEnv(cfg);
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  const sys =
    "You are a prediction-market analyst. Given a Polymarket-style market " +
    "URL, return a one-paragraph (≤80 words) take on the question: what's " +
    "the most likely outcome, and what's the single strongest piece of " +
    "evidence pushing your guess? End with a one-line tag: SIGNAL=YES, " +
    "SIGNAL=NO, or SIGNAL=PASS.";
  const resp = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 240,
    system: sys,
    messages: [{ role: "user", content: `Market: ${marketUrl}` }],
  });
  const text =
    resp.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();
  const m = /SIGNAL=(YES|NO|PASS)\b/i.exec(text);
  const signal: Signal = m
    ? (m[1]!.toUpperCase() as Signal)
    : ("PASS" as Signal);
  return {
    signal_guess: signal,
    one_liner: text.replace(/SIGNAL=(YES|NO|PASS)\b/i, "").trim(),
    raw_text: text,
  };
}
