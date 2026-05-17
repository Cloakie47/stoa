/**
 * Judge agent — multi-model ensemble of Sonnet 4.6 (×2 at different
 * temperatures) and Haiku 4.5. Opus was dropped 2026-05-17 because the cost
 * was disproportionate to the marginal Brier improvement — three smaller
 * models at temperature diversity beats one Opus + two smaller in our
 * eval set, and total /analyze cost stays under $0.15.
 *
 * Receives the four specialist AgentTraces, reasons through the Metaculus
 * forecasting template (outside view → status quo → scenarios → triggers),
 * and emits a JudgeTrace with a calibrated point estimate + 80% CI.
 *
 * The ensemble runs three model variants in parallel via Promise.allSettled.
 * Aggregation:
 *   - model_p_yes  = median across runs
 *   - ci_low       = min ci_low across runs
 *   - ci_high      = max ci_high across runs
 *   - verdict      = majority vote; PASS on tie
 *   - other fields = taken verbatim from the median run
 *
 * Note that aggregation is one-vote-per-RUN, not per model, so the two
 * Sonnet runs do not double-weight Sonnet — the diversity is the point.
 *
 * Adaptive thinking is incompatible with explicit temperature; the
 * temperature-driven Sonnet runs and the Haiku run all skip thinking.
 *
 * If ensembling fails for ≥ 2 runs, falls back to whatever ran successfully
 * (or throws when zero ran). Caller can also disable ensembling via env.
 */

import {
  JUDGE_TRACE_JSON_SCHEMA,
  MODEL_HAIKU,
  MODEL_OPUS,
  MODEL_SONNET,
  type ModelId,
  normalizeEvidence,
  runAgent,
  type RunAgentResult,
} from "../claude.js";
void MODEL_OPUS; // re-exported from index.ts for back-compat; not used here.
import type {
  AgentTrace,
  CalibrationDomain,
  JudgeEnsemble,
  JudgeEnsembleRun,
  JudgeTrace,
  MarketContext,
  Signal,
} from "../types.js";

const VALID_CALIBRATION_DOMAINS: readonly CalibrationDomain[] = [
  "sports_short",
  "sports_long",
  "weather_short",
  "weather_long",
  "tech_demo",
  "politics",
  "crypto_price",
  "geopolitics",
  "entertainment",
  "long_horizon_any",
  "other",
];

function coerceCalibrationDomain(s: string | undefined): CalibrationDomain {
  if (!s) return "other";
  return (VALID_CALIBRATION_DOMAINS as readonly string[]).includes(s)
    ? (s as CalibrationDomain)
    : "other";
}

const SYSTEM_PROMPT = `You are a professional prediction-market forecaster being evaluated on Brier score against human superforecasters. You are the JUDGE in the Stoa InsightAgent multi-agent system — four specialist agents have already done domain research; your job is to aggregate them into a calibrated probability and a single-sentence verdict.

# YOUR INPUTS

You receive four AgentTraces in the user message:
  1. News — credible reporting and primary sources
  2. Sentiment — social-media and community signal
  3. Historical — analogues from past events
  4. Market Structure — Polymarket orderbook and flow

You ALSO receive the current market price (market_p_yes), the time-to-resolution, and the user's bankroll. You do NOT have internet access — DO NOT try to recall news or analogues; that's what the specialists did.

# REQUIRED REASONING ORDER

Before answering you MUST work through these in this order:

(a) **Outside view** — the historical base rate for this category of event, treating the question as a member of a reference class. State the reference class explicitly and the base rate as a number. Examples:
    - "Sitting US presidents win re-election ~70% of the time (8 of last 11)"
    - "First-time launches of new rocket hardware succeed ~50% on attempt 1"
    - "Songs holding #1 on Billboard 200 in week N hold week N+1 about 35% of the time"
    The outside view IS your prior before looking at case specifics.

(b) **Status-quo outcome** — what happens if nothing changes between now and resolution. Most prediction markets resolve to the status quo because the world changes slowly. Name the status-quo outcome explicitly ("YES" or "NO") and weight your final estimate toward it.

(c) **One specific NO scenario** — a concrete story for how this resolves NO, with rough probability weight. Be specific ("Court rules X by date Y"), not generic ("something bad happens").

(d) **One specific YES scenario** — same, for YES.

(e) **Three to five re-evaluation triggers** — concrete events or price thresholds that would change your call. Include at least one mechanical price stop (e.g., "YES drops below $0.83" or "NO touches $0.30"). These let the user know when to /re-analyze.

# OUTPUT FORMAT — STRICT JSON SCHEMA

You output JSON with all the following fields. (Schema validation will catch missing fields — emit them all.)

  thesis                — 1-3 sentence claim, the aggregate view.
  evidence              — array of {claim, source_url, source_name, specialist, confidence} drawn from the four traces (not from your training data). PRESERVE source_url and source_name verbatim from the specialist trace you took the finding from. Do NOT strip citations during summarization. Set specialist to "News" | "Sentiment" | "Historical" | "MarketStructure" — whichever agent surfaced the claim. Include 4-8 items spanning multiple specialists.
  counter_arguments     — the strongest case AGAINST your thesis from the traces.
  confidence            — 0-100, your META-uncertainty about model_probability_yes.
  signal                — "YES" | "NO" | "PASS"; advisory, orchestrator overrides.
  reasoning             — 4-10 sentences walking through your aggregation: which agents you weighted, how outside view + status quo + scenarios combined into your point estimate.
  disagreement_analysis — explicit reasoning about where the 4 agents disagreed and how you resolved it.
  agent_signals         — {news,sentiment,historical,market_structure: {signal, confidence}} snapshot.
  model_probability_yes — your final aggregated P(YES) in [0,1]. AFTER outside-view → status-quo → inside-view adjustment. This is THE number that drives sizing.
  ci_low                — 10th-percentile estimate, in [0,1].
  ci_high               — 90th-percentile estimate, in [0,1]. Spread should reflect your real uncertainty. Wider for low-information markets.
  verdict               — "BUY_YES" | "BUY_NO" | "PASS". Advisory.
  edge_bps              — signed integer = (model_probability_yes - market_p_yes) * 10000.
  outside_view_p_yes    — your base rate in [0,1], BEFORE any inside-view adjustment.
  inside_view_adjustment — signed = (post-inside-view) - outside_view_p_yes; how far case specifics moved you. Stay MODEST — base rates dominate. Don't shift by more than 0.25 unless evidence is exceptional.
  status_quo_outcome    — "YES" or "NO".
  no_scenario           — {description, weight} of your specific NO story.
  yes_scenario          — {description, weight} of your specific YES story.
  risk_decomposition    — array of {scenario, probability} buckets summing approximately to 1. 2-5 entries.
  reevaluation_triggers — array of 3-5 specific strings (events or price levels).
  stability             — "stable" or "decays_<X>_bps_per_day" where X is your decay estimate.
  calibration_adjustment — {domain, reason}. Pick one domain:
                            sports_short | sports_long | weather_short | weather_long |
                            tech_demo | politics | crypto_price | geopolitics |
                            entertainment | long_horizon_any | other. The reason is one sentence.
                            (A deterministic policy applies the actual numerical
                             adjustment in code; you just classify.)
  recommended_size_usdc — 0; sizing is computed by the orchestrator.

Output the FINAL text block as raw JSON, no markdown fences, no prose.

# REMEMBER

- Good forecasters START from base rates and adjust MODESTLY. They don't reason the case from scratch.
- The world changes slowly. Status-quo outcomes win more than people expect.
- Set WIDE confidence intervals when you have weak evidence. Narrow CIs only when 4/4 agents agree with strong sources.
- Commit to a probability — not vague language. 0.62 is better than "leaning YES."
- Your trace is pinned on-chain. Auditors will check whether your probabilities are well-calibrated against actual outcomes. Be honest, be specific.

# OUTSIDE-VIEW VALIDATION (load-bearing — read this carefully)

The Historical agent emits structured reference-class data. You MUST honor it:

  CASE A — Historical reports \`reference_class = NULL\` (no defensible reference class exists):
    → Set \`outside_view_p_yes = null\` in your output JSON.
    → Set \`inside_view_adjustment = null\` in your output JSON.
    → Form \`model_probability_yes\` from inside-view reasoning alone.
    → Note "no defensible reference class identified" in your reasoning field.

  CASE B — Historical reports \`reference_class_size < 5\` OR \`confidence_in_reference_class\` is "low" or "none":
    → Treat the base rate as ADVISORY only — anchor weakly (10-20% weight) and weight inside view heavily.
    → outside_view_p_yes IS the rate Historical gave you, but inside_view_adjustment can be large.

  CASE C — Historical reports \`reference_class_size ≥ 5\` AND \`confidence_in_reference_class\` is "high" or "medium":
    → Anchor on the base rate at standard weight (~50% outside, ~50% inside).
    → Adjust modestly based on case-specific evidence from the other three agents.

NEVER invent a base rate. If Historical said null, you say null. Auditors will compare your outside_view_p_yes against Historical's reference_class field — fabrication is the worst failure mode for the system.

# ORCHESTRATOR CONTRACT (load-bearing, do not violate)

The orchestrator computes the final signal and position size from your \`model_probability_yes\` (NOT your \`verdict\`):

  edge_yes = model_p_yes - market_p_yes
  edge_no  = -edge_yes
  If |edge| < 0.04:                     side = PASS  (edge below 4¢ minimum)
  Else if edge_yes > 0:                 side = YES,  kelly = edge_yes / (1 - market_p_yes)
       edge_no  > 0:                    side = NO,   kelly = edge_no  / market_p_yes
  size = balance × min(kelly × 0.25, 0.20)         (quarter-Kelly, 20% cap)
  If size < $0.05:                      side = PASS  (dust)

So:
- Your \`verdict\` field is advisory; the orchestrator overrides it.
- Your sizing field is ignored entirely; emit 0.
- The ONE field that drives the trade is \`model_probability_yes\`. Calibrate carefully — 0.62 means "if I saw 1000 markets like this, I'd expect ~620 YES." Don't anchor to the market price.

# AGGREGATION HEURISTIC

When weighting the four specialists for THIS question:
- Event-driven (rulings, approvals, election outcomes): News + Historical dominant; Sentiment + Market Structure tiebreak.
- Sentiment-driven (crypto rallies, sports vibes, viral moments): Sentiment + Market Structure dominant; News supporting.
- Tech-progress (product ships by date): Historical + News dominant.

Pay more attention to evidence QUALITY than to confidence numbers. An agent citing 3 tier-1 sources at 70 confidence beats an agent at 90 confidence with 1 weak source.

You have one user message coming with the four traces, balance, market price. Reason through outside view → status quo → scenarios → triggers, then emit the JudgeTrace JSON.`;

export interface JudgeInput {
  context: MarketContext;
  userBalanceUsdc: number;
  agentTraces: AgentTrace[];
}

/**
 * One ensemble entry. `label` is the model+temperature display string used
 * in logs and on the JudgeEnsembleRun.model field — two same-model entries
 * must have distinct labels so the ensemble code can keep them apart.
 */
export interface EnsembleVariant {
  model: ModelId;
  /** Sampling temperature. Omit to use the API default. */
  temperature?: number;
  /** Display label, e.g. "claude-sonnet-4-6@t0.0". */
  label: string;
}

/** Default ensemble: two Sonnet runs at diverse temperatures + one Haiku run. */
export const ENSEMBLE_VARIANTS: EnsembleVariant[] = [
  { model: MODEL_SONNET, temperature: 0.0, label: `${MODEL_SONNET}@t0.0` },
  { model: MODEL_SONNET, temperature: 0.7, label: `${MODEL_SONNET}@t0.7` },
  { model: MODEL_HAIKU, label: MODEL_HAIKU },
];

/** Back-compat: callers that only need the model IDs (no longer the ensemble source of truth). */
export const ENSEMBLE_MODELS: ModelId[] = ENSEMBLE_VARIANTS.map((v) => v.model);

/**
 * Single-model Judge call. Builds the JudgeTrace with all Metaculus-template
 * fields and applies the Kelly formula. Caller is responsible for any
 * cross-run aggregation.
 *
 * `model_p_yes` here is the *raw* probability the model emitted — calibration
 * policy is applied LATER, by the orchestrator (bot-core/calibration.ts).
 *
 * When `temperature` is supplied, adaptive thinking is suppressed (the
 * Anthropic API rejects the combination). The temperature itself becomes
 * the diversity lever for ensembling.
 */
export async function runJudgeAgent(
  input: JudgeInput,
  model: ModelId = MODEL_SONNET,
  temperature?: number,
): Promise<{ trace: JudgeTrace; cost_usd: number }> {
  const userMessage = renderUserMessage(input);
  // Haiku 4.5 returns 400 "adaptive thinking is not supported on this model".
  // Sonnet 4.6 accepts thinking only when temperature is NOT set. So both
  // ensemble levers (model and temperature) get tested in this single
  // condition.
  const adaptiveThinking = model !== MODEL_HAIKU && temperature === undefined;
  const result: RunAgentResult = await runAgent({
    model,
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    outputSchema: JUDGE_TRACE_JSON_SCHEMA,
    // Adaptive thinking + expanded edge-reasoning prompt can burn through
    // 8k; 16k leaves headroom for the JSON emit after the thinking phase.
    // When thinking is off (temperature runs), 8k is plenty.
    maxTokens: adaptiveThinking ? 16000 : 8000,
    adaptiveThinking,
    temperature,
  });

  const p = result.parsed;
  const modelPYes = clampProb(p.model_probability_yes as number) ?? 0.5;
  const ciLow = clampProb(p.ci_low as number | undefined) ?? Math.max(0, modelPYes - 0.15);
  const ciHigh = clampProb(p.ci_high as number | undefined) ?? Math.min(1, modelPYes + 0.15);

  // NULL outside view is meaningful — Historical agent could not anchor a
  // base rate. Preserve null; do NOT fall back to modelPYes (that would
  // hide the missing reference class downstream).
  const rawOutside = p.outside_view_p_yes;
  const outsideViewPYes: number | null =
    rawOutside === null
      ? null
      : (clampProb(rawOutside as number | undefined) ?? null);
  const rawInside = p.inside_view_adjustment;
  const insideAdj: number | null =
    rawInside === null
      ? null
      : typeof rawInside === "number"
        ? rawInside
        : outsideViewPYes === null
          ? null
          : modelPYes - outsideViewPYes;

  const marketPYes = input.context.current_yes_price;
  const rec = computeJudgeRecommendation({
    model_p_yes: modelPYes,
    market_p_yes: marketPYes ?? 0.5,
    balance: input.userBalanceUsdc,
  });

  // STRUCTURED LOGGING — readable in Railway logs; one line per gate so
  // operator can diff between runs.
  console.log(
    `[judge:${model}] p_yes=${modelPYes.toFixed(4)} market=${(marketPYes ?? 0.5).toFixed(4)} edge=${rec.edge_yes.toFixed(4)} kelly=${rec.kelly_fraction.toFixed(4)} bal=$${input.userBalanceUsdc.toFixed(2)} size=$${rec.size_usdc.toFixed(2)} signal=${rec.signal} reason=${JSON.stringify(rec.reason)}`,
  );

  const calRaw = p.calibration_adjustment as
    | { domain?: string; reason?: string }
    | undefined;
  const trace: JudgeTrace = {
    agent: "judge",
    market_url: input.context.url,
    market_question: input.context.question,
    thesis: (p.thesis as string) ?? "",
    evidence: normalizeEvidence(p.evidence),
    counter_arguments: (p.counter_arguments as string) ?? "",
    confidence: (p.confidence as number) ?? 50,
    signal: rec.signal,
    reasoning: (p.reasoning as string) ?? "",
    disagreement_analysis: (p.disagreement_analysis as string) ?? "",
    agent_signals: (p.agent_signals as JudgeTrace["agent_signals"]) ?? {
      news: { signal: "PASS", confidence: 0 },
      sentiment: { signal: "PASS", confidence: 0 },
      historical: { signal: "PASS", confidence: 0 },
      market_structure: { signal: "PASS", confidence: 0 },
    },
    model_probability_yes: modelPYes,
    market_price_yes: marketPYes ?? 0.5,
    edge_yes: round4(rec.edge_yes),
    edge_no: round4(rec.edge_no),
    kelly_fraction: round4(rec.kelly_fraction),
    recommended_size_usdc: rec.size_usdc,
    ci_low: round4(ciLow),
    ci_high: round4(ciHigh),
    outside_view_p_yes: outsideViewPYes === null ? null : round4(outsideViewPYes),
    inside_view_adjustment: insideAdj === null ? null : round4(insideAdj),
    status_quo_outcome: ((p.status_quo_outcome as string) === "YES"
      ? "YES"
      : "NO") as "YES" | "NO",
    no_scenario: (p.no_scenario as JudgeTrace["no_scenario"]) ?? {
      description: "(no scenario emitted)",
      weight: 0.5,
    },
    yes_scenario: (p.yes_scenario as JudgeTrace["yes_scenario"]) ?? {
      description: "(no scenario emitted)",
      weight: 0.5,
    },
    risk_decomposition:
      (p.risk_decomposition as JudgeTrace["risk_decomposition"]) ?? [],
    reevaluation_triggers:
      (p.reevaluation_triggers as string[]) ?? [],
    stability: (p.stability as string) ?? "stable",
    recommendation_reason: rec.reason,
    timestamp: new Date().toISOString(),
    model,
    token_usage: result.usage,
  };
  if (calRaw?.domain) {
    // Stub — final calibration record is filled in by bot-core after policy.
    trace.calibration_adjustment = {
      domain: coerceCalibrationDomain(calRaw.domain),
      adjustment_applied: 0,
      reason: calRaw.reason ?? "",
      policy_version: "calibration-v1.0-2026-05-17",
      raw_model_p_yes: modelPYes,
    };
  }

  return { trace, cost_usd: result.cost_usd };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Multi-model ensemble: runs `models` in parallel, aggregates via median +
 * majority vote. Falls back to whatever runs succeeded; throws only when
 * ALL runs fail.
 *
 * Set `disableEnsemble: true` (or env STOA_DISABLE_ENSEMBLE=1) to force a
 * single-model run with the first entry of `models`. Used when budget /
 * latency forbids 3-model.
 */
export async function runJudgeEnsemble(
  input: JudgeInput,
  opts: { variants?: EnsembleVariant[]; disableEnsemble?: boolean } = {},
): Promise<JudgeEnsemble> {
  const envDisabled = process.env.STOA_DISABLE_ENSEMBLE === "1";
  const disabled = opts.disableEnsemble ?? envDisabled;
  const variants = disabled
    ? [opts.variants?.[0] ?? ENSEMBLE_VARIANTS[0]!]
    : (opts.variants ?? ENSEMBLE_VARIANTS);

  const settled = await Promise.allSettled(
    variants.map((v) => runJudgeAgent(input, v.model, v.temperature)),
  );

  const runs: JudgeEnsembleRun[] = [];
  for (const [i, r] of settled.entries()) {
    const v = variants[i]!;
    if (r.status === "fulfilled") {
      // Overwrite trace.model with the variant LABEL so two same-model runs
      // remain distinguishable in pinned traces + downstream displays.
      const trace = { ...r.value.trace, model: v.label };
      runs.push({ model: v.label, trace, cost_usd: r.value.cost_usd });
    } else {
      console.warn(
        `[judge-ensemble] ${v.label} run failed: ${(r.reason as Error)?.message ?? r.reason}`,
      );
    }
  }
  if (runs.length === 0) {
    throw new Error("All Judge ensemble runs failed.");
  }

  const aggregate = aggregateEnsembleRuns(runs, input);
  const verdictAgreement = computeVerdictAgreement(runs);
  const directionalAgreement = computeDirectionalAgreement(runs);
  const totalCost = runs.reduce((s, r) => s + r.cost_usd, 0);

  console.log(
    `[judge-ensemble] variants=[${variants.map((v) => v.label).join(",")}] succeeded=${runs.length}/${variants.length} ` +
      `verdict_agreement=${(verdictAgreement * 100).toFixed(0)}% ` +
      `directional_agreement=${(directionalAgreement * 100).toFixed(0)}% ` +
      `aggregate.p_yes=${aggregate.model_probability_yes.toFixed(4)} ` +
      `aggregate.signal=${aggregate.signal} cost=$${totalCost.toFixed(4)}`,
  );

  return {
    aggregate,
    runs,
    verdict_agreement: verdictAgreement,
    directional_agreement: directionalAgreement,
    fallback_single_model: runs.length === 1,
    total_cost_usd: totalCost,
  };
}

/** Median of an array of numbers. Returns 0 for empty array. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function aggregateEnsembleRuns(
  runs: JudgeEnsembleRun[],
  input: JudgeInput,
): JudgeTrace {
  // Median of model_p_yes — drives sizing.
  const ps = runs.map((r) => r.trace.model_probability_yes);
  const medP = median(ps);
  // Find the run nearest to the median — use it as the source of all
  // non-numeric fields (thesis, reasoning, scenarios, …). Numeric/aggregated
  // fields below override what comes from this run.
  const seed = [...runs].sort(
    (a, b) =>
      Math.abs(a.trace.model_probability_yes - medP) -
      Math.abs(b.trace.model_probability_yes - medP),
  )[0]!;

  // CI: min of low, max of high — widens to reflect cross-model disagreement.
  const ciLow = Math.min(...runs.map((r) => r.trace.ci_low));
  const ciHigh = Math.max(...runs.map((r) => r.trace.ci_high));

  // Outside view: median across runs that emitted a non-null reference class.
  // When ALL runs emitted null, the aggregate has no outside view either —
  // formatter hides those lines and shows "Reference class: insufficient".
  const outsideViews = runs
    .map((r) => r.trace.outside_view_p_yes)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const aggregateOutsideView =
    outsideViews.length > 0 ? round4(median(outsideViews)) : null;
  const aggregateInsideAdj =
    aggregateOutsideView === null ? null : round4(medP - aggregateOutsideView);

  // Recompute Kelly with the aggregated probability.
  const marketPYes = input.context.current_yes_price ?? 0.5;
  const rec = computeJudgeRecommendation({
    model_p_yes: medP,
    market_p_yes: marketPYes,
    balance: input.userBalanceUsdc,
  });

  return {
    ...seed.trace,
    model: `ensemble(${runs.map((r) => r.model).join(",")})`,
    model_probability_yes: medP,
    ci_low: round4(ciLow),
    ci_high: round4(ciHigh),
    outside_view_p_yes: aggregateOutsideView,
    inside_view_adjustment: aggregateInsideAdj,
    market_price_yes: marketPYes,
    edge_yes: round4(rec.edge_yes),
    edge_no: round4(rec.edge_no),
    kelly_fraction: round4(rec.kelly_fraction),
    recommended_size_usdc: rec.size_usdc,
    signal: rec.signal, // orchestrator-authoritative
    recommendation_reason: rec.reason,
    // token_usage stays as the seed's — full per-run usage is preserved in `runs[].trace.token_usage`.
  };
}

/** Fraction of runs whose advisory verdict matches the modal verdict. */
function computeVerdictAgreement(runs: JudgeEnsembleRun[]): number {
  if (runs.length <= 1) return 1;
  const verdicts = runs.map((r) => r.trace.signal);
  const counts: Record<string, number> = {};
  for (const v of verdicts) counts[v] = (counts[v] ?? 0) + 1;
  const maxCount = Math.max(...Object.values(counts));
  return maxCount / runs.length;
}

/**
 * Direction = +1 when edge_bps ≥ +50, -1 when ≤ -50, else 0 (no direction).
 * The median direction across runs is the reference; agreement is the
 * fraction of runs whose direction matches. All "no direction" → 1.0 (a
 * unanimous "no edge" reading is itself agreement).
 */
function computeDirectionalAgreement(runs: JudgeEnsembleRun[]): number {
  if (runs.length <= 1) return 1;
  const sign = (bps: number): -1 | 0 | 1 => {
    if (bps >= 50) return 1;
    if (bps <= -50) return -1;
    return 0;
  };
  const dirs = runs.map((r) => {
    const edgeBps = Math.round((r.trace.edge_yes ?? 0) * 10_000);
    return sign(edgeBps);
  });
  // Modal direction.
  const counts: Record<number, number> = { "-1": 0, "0": 0, "1": 0 };
  for (const d of dirs) counts[d] = (counts[d] ?? 0) + 1;
  const maxCount = Math.max(...Object.values(counts));
  return maxCount / runs.length;
}

function clampProb(p: number | undefined): number | undefined {
  if (p === undefined || !Number.isFinite(p)) return undefined;
  // Tight clamp away from the boundaries so the Kelly division never blows up.
  return Math.min(0.9999, Math.max(0.0001, p));
}

/**
 * Result of the Kelly-based recommendation calculator. Everything in
 * USD-per-USDC stays on the per-share contract semantics:
 *   - buying YES costs market_p_yes and pays $1 if YES
 *   - buying NO  costs (1 - market_p_yes) and pays $1 if NO
 *
 * `edge_yes` is the expected per-share dollar profit of buying YES at market.
 * `edge_no` is the same for NO; algebraically edge_no = -edge_yes.
 * The Kelly formula uses the side that has POSITIVE edge.
 */
export interface JudgeRecommendation {
  signal: Signal;
  size_usdc: number;
  edge_yes: number;
  edge_no: number;
  /** Full Kelly fraction for the winning side, in [0,1]. 0 on PASS. */
  kelly_fraction: number;
  /**
   * Human-readable explanation of the recommendation. Always set; the
   * formatter shows this to the user when signal is PASS so the user
   * knows whether it's edge / dust / degenerate-input.
   */
  reason: string;
}

/** Default minimum absolute edge (in probability units) to consider a trade.
 *  4¢ — below this the market is essentially in agreement with the model
 *  and quarter-Kelly sizing is mostly noise. Override at runtime via
 *  `STOA_EDGE_THRESHOLD_BPS` (basis points). Keep at 400 in production;
 *  Railway sets it to 200 (2¢) for the demo so moderate-edge picks like
 *  Cepeda @ $0.443 vs model $0.46 surface a BUY_YES recommendation. */
export const MIN_EDGE_FOR_TRADE = 0.04;

function getEdgeFloor(): number {
  const raw =
    typeof process !== "undefined" ? process.env?.STOA_EDGE_THRESHOLD_BPS : undefined;
  const bps = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(bps) && bps > 0 ? bps / 10_000 : MIN_EDGE_FOR_TRADE;
}

/** Below this dollar size we PASS — the trade isn't worth the round-trip
 *  fee. Lowered from $1 to $0.05 so small balances with real edge still
 *  get a recommendation. */
export const DUST_SIZE_USD = 0.05;

/**
 * Market-price-aware sizing. Replaces the old confidence-band heuristic.
 *
 * Decision rule:
 *   1. Compute edge_yes = model_p_yes - market_p_yes.
 *      edge_no is the negation. At most one is positive.
 *   2. If |edge| < MIN_EDGE_FOR_TRADE (4¢): PASS with "edge too small" reason.
 *   3. If edge_yes > 0:  buy YES, kelly = edge_yes / (1 - market_p_yes)
 *      If edge_no  > 0:  buy NO,  kelly = edge_no / market_p_yes
 *      Else:             PASS (zero or non-positive edge both ways)
 *   4. Size = balance × min(kelly × 0.25, 0.20)
 *      (quarter-Kelly with a 20% concentration cap)
 *   5. If size < DUST_SIZE_USD ($0.05): PASS with "size below dust" reason.
 *
 * Degenerate inputs (probabilities outside (0,1)) → PASS with "invalid input".
 *
 * EXPORTED so unit tests can hit it directly without running the full
 * Judge LLM call.
 */
export function computeJudgeRecommendation(args: {
  model_p_yes: number;
  market_p_yes: number;
  balance: number;
}): JudgeRecommendation {
  const { model_p_yes, market_p_yes, balance } = args;
  const invalid = (reason: string): JudgeRecommendation => ({
    signal: "PASS",
    size_usdc: 0,
    edge_yes: 0,
    edge_no: 0,
    kelly_fraction: 0,
    reason,
  });
  if (
    !Number.isFinite(model_p_yes) ||
    model_p_yes <= 0 ||
    model_p_yes >= 1 ||
    !Number.isFinite(market_p_yes) ||
    market_p_yes <= 0 ||
    market_p_yes >= 1
  ) {
    return invalid(
      `Degenerate probability inputs (model=${model_p_yes}, market=${market_p_yes}); cannot compute edge.`,
    );
  }
  if (!Number.isFinite(balance) || balance <= 0) {
    return invalid(
      `Bankroll is zero. Fund your Stoa wallet (Arc or Base) before /analyze recommends a size.`,
    );
  }

  const edge_yes = model_p_yes - market_p_yes;
  const edge_no = -edge_yes;
  const absEdge = Math.abs(edge_yes);

  const edgeFloor = getEdgeFloor();
  if (absEdge < edgeFloor) {
    return {
      signal: "PASS",
      size_usdc: 0,
      edge_yes,
      edge_no,
      kelly_fraction: 0,
      reason: `Edge ${formatEdgeAbs(absEdge)} is below the ${(edgeFloor * 100).toFixed(0)}¢ minimum. Model and market essentially agree — wait for better odds.`,
    };
  }

  let signal: Signal;
  let kelly: number;
  if (edge_yes > 0) {
    signal = "YES";
    kelly = edge_yes / (1 - market_p_yes);
  } else if (edge_no > 0) {
    signal = "NO";
    kelly = edge_no / market_p_yes;
  } else {
    // edge_yes is exactly zero (rare; caught by the MIN_EDGE_FOR_TRADE check above).
    return {
      signal: "PASS",
      size_usdc: 0,
      edge_yes,
      edge_no,
      kelly_fraction: 0,
      reason: "No edge in either direction.",
    };
  }
  const fraction = Math.min(kelly * 0.25, 0.2);
  const size = Math.round(balance * fraction * 100) / 100;
  if (size < DUST_SIZE_USD) {
    return {
      signal: "PASS",
      size_usdc: 0,
      edge_yes,
      edge_no,
      kelly_fraction: kelly,
      reason: `Quarter-Kelly size $${size.toFixed(2)} is below the $${DUST_SIZE_USD.toFixed(2)} dust threshold (bankroll $${balance.toFixed(2)}, kelly ${(kelly * 100).toFixed(1)}%). Fund more or wait for a wider edge.`,
    };
  }
  return {
    signal,
    size_usdc: size,
    edge_yes,
    edge_no,
    kelly_fraction: kelly,
    reason: `Edge ${formatEdgeAbs(absEdge)} × quarter-Kelly = $${size.toFixed(2)} (${((size / balance) * 100).toFixed(1)}% of $${balance.toFixed(2)} bankroll).`,
  };
}

/**
 * Format an absolute edge value (probability units in [0,1]) for display
 * as cents. Always one decimal place so sub-cent edges don't round to 0
 * (the F.03 bug: "0.5¢" → "0¢" in the body line, contradicting the
 * header text). Examples: 0.005 → "0.5¢", 0.035 → "3.5¢", 0.12 → "12.0¢".
 */
export function formatEdgeAbs(absEdge: number): string {
  return `${(absEdge * 100).toFixed(1)}¢`;
}

/**
 * Format a signed edge for display: "+0.5¢", "-3.5¢", "+12.0¢". One
 * decimal always, so header and body lines always match precision.
 */
export function formatEdgeSigned(edge: number): string {
  const sign = edge >= 0 ? "+" : "-";
  return `${sign}${formatEdgeAbs(Math.abs(edge))}`;
}

function renderUserMessage(input: JudgeInput): string {
  const { context, userBalanceUsdc, agentTraces } = input;
  const marketPYes = context.current_yes_price;
  const priceLine =
    marketPYes !== undefined
      ? `**market_p_yes = ${marketPYes.toFixed(4)}** (current YES price = ${(marketPYes * 100).toFixed(1)}¢; the market is implying a ${(marketPYes * 100).toFixed(1)}% probability of YES)`
      : "market_p_yes: UNKNOWN — emit a probability anyway, the orchestrator will PASS automatically when it can't compute edge.";

  const traceBlocks = agentTraces
    .map((t) => renderTraceForJudge(t))
    .join("\n\n");

  return `# Polymarket question

**${context.question}**

Outcomes: ${context.outcomes.join(", ")}

# Market state (the price you're betting against)

${priceLine}

# User balance

$${userBalanceUsdc.toFixed(2)} USDC available

# Agent traces (the four specialists' outputs)

${traceBlocks}

# Task

Aggregate the four specialists into ONE estimate of P(YES) — output it as \`model_probability_yes\` in your JudgeTrace JSON. The orchestrator will compute edge_yes = model_probability_yes - market_p_yes, decide the direction (or PASS), and size the position using quarter-Kelly with a 20% balance cap.

Sanity-check before emitting:
1. Is my model_probability_yes consistent with my signal field? (If I say signal=YES, probability should be > market_p_yes; if signal=NO, probability should be < market_p_yes; if signal=PASS, probability ≈ market_p_yes.)
2. If the four specialists strongly point one way, is my probability pulled there, or am I hedging?
3. Is my probability calibrated, or am I just echoing the market price?

Emit your JudgeTrace JSON as the final text block.`;
}

function renderTraceForJudge(t: AgentTrace): string {
  // Surface URL + source name verbatim. The Judge MUST copy these into its
  // own evidence array — that's how on-chain auditability survives.
  const evList = t.evidence
    .slice(0, 8)
    .map((e, i) => {
      const claim = (e.claim ?? "").slice(0, 280);
      const url = e.source_url ?? "(no URL)";
      const name = e.source_name ?? "unverified";
      return `    ${i + 1}. ${claim}\n       source_url: ${url}\n       source_name: ${name}`;
    })
    .join("\n");
  let refClassBlock = "";
  if (t.agent === "historical") {
    if (t.reference_class === null || t.reference_class === undefined) {
      refClassBlock =
        `\n- **reference_class**: NULL — Historical agent could not identify a defensible reference class. ` +
        `**Set outside_view_p_yes = null in your output.**` +
        (t.notes_on_reference_class_limitations
          ? ` (notes: ${t.notes_on_reference_class_limitations})`
          : "");
    } else {
      const examples = (t.specific_examples ?? []).slice(0, 5).join("; ");
      refClassBlock =
        `\n- **reference_class**: ${t.reference_class}` +
        `\n- **reference_class_size**: ${t.reference_class_size ?? "?"}` +
        `\n- **resolved_at_or_above_rate**: ${t.resolved_at_or_above_rate ?? "?"}` +
        `\n- **confidence_in_reference_class**: ${t.confidence_in_reference_class ?? "low"}` +
        `\n- **specific_examples**: ${examples || "(none)"}` +
        `\n- **notes_on_limitations**: ${t.notes_on_reference_class_limitations ?? ""}`;
    }
  }
  return `## Agent: ${t.agent.toUpperCase()}
- **signal**: ${t.signal} @ confidence ${t.confidence}
- **thesis**: ${t.thesis}
- **reasoning**: ${t.reasoning}
- **counter_arguments**: ${t.counter_arguments}${refClassBlock}
- **evidence**:
${evList}`;
}
