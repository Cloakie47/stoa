/**
 * Trading-R1-style trace schemas.
 *
 * Each specialist agent emits an {@link AgentTrace}. The Judge consumes those
 * and emits a {@link JudgeTrace} (a superset of AgentTrace with explicit
 * disagreement analysis). The full bundle — individual agent traces plus the
 * judge — is pinned to Arc as a {@link FullTrace}.
 *
 * The schemas here are also the JSON-schema source-of-truth used to constrain
 * Claude's `output_config.format` on each agent call — see
 * `src/claude.ts` for how we render them.
 */

export type AgentName =
  | "news"
  | "sentiment"
  | "historical"
  | "market_structure"
  | "judge";

export type Signal = "YES" | "NO" | "PASS";

export interface EvidenceItem {
  /** Free-text source name, e.g. "Reuters", "X @user", "polymarket-orderbook". */
  source: string;
  /** Short quote or extracted fact, max ~300 chars. */
  quote: string;
  /** Optional URL the agent can cite. */
  url?: string;
  /** ISO 8601 timestamp of the source, if known. */
  timestamp?: string;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface AgentTrace {
  agent: AgentName;
  market_url: string;
  market_question: string;
  /** Core 1-3 sentence claim. */
  thesis: string;
  /** Supporting evidence — sources, quotes, and (where possible) URLs. */
  evidence: EvidenceItem[];
  /** Reasoning that argues against the thesis. Required, even if brief. */
  counter_arguments: string;
  /** 0-100 self-rated confidence. */
  confidence: number;
  /** Final per-agent signal. PASS means insufficient signal — abstain. */
  signal: Signal;
  /** Longer-form reasoning chain. */
  reasoning: string;
  /** ISO 8601. */
  timestamp: string;
  /** Model ID used for the call (e.g. claude-haiku-4-5). */
  model: string;
  /** Token usage from response.usage. */
  token_usage: TokenUsage;
}

/**
 * Domain categories used by the deterministic calibration policy in
 * `packages/bot-core/src/calibration.ts`. The Judge classifies the
 * market into one of these; the policy applies the adjustment.
 */
export type CalibrationDomain =
  | "sports_short"
  | "sports_long"
  | "weather_short"
  | "tech_demo"
  | "politics"
  | "crypto_price"
  | "geopolitics"
  | "entertainment"
  | "long_horizon_any"
  | "other";

export interface ScenarioWeight {
  description: string;
  /** Probability weight in [0,1]. Yes + No scenarios needn't sum to 1 — they're illustrative anchors. */
  weight: number;
}

export interface RiskBucket {
  scenario: string;
  probability: number;
}

export interface CalibrationAdjustment {
  domain: CalibrationDomain;
  /** Signed bps shift from raw model_p_yes to final model_p_yes. */
  adjustment_applied: number;
  reason: string;
  /** Policy version pinned in trace; e.g. "calibration-v1.0-2026-05-17". */
  policy_version: string;
  /** The raw model_p_yes the Judge originally emitted, before policy. */
  raw_model_p_yes: number;
}

/**
 * Judge trace adds explicit agreement/disagreement analysis + market-price-
 * aware sizing on top of the AgentTrace shape. Now also carries the
 * Metaculus-template forecasting fields (outside view, status quo,
 * scenarios, re-evaluation triggers) and the calibration record.
 *
 * `signal`, `recommended_size_usdc`, and the edge/kelly fields are
 * DERIVED in code from `model_probability_yes` + `market_price_yes`
 * (via `computeJudgeRecommendation`). The Judge model outputs its own
 * advisory `signal` too, but the orchestrator overrides it so negative-EV
 * trades never get a non-zero size.
 */
export interface JudgeTrace extends AgentTrace {
  agent: "judge";
  disagreement_analysis: string;
  agent_signals: Record<string, { signal: Signal; confidence: number }>;
  /** Aggregated point estimate P(YES) in [0,1]. Drives sizing. */
  model_probability_yes: number;
  /** Market's YES contract price at analysis time, in [0,1]. */
  market_price_yes: number;
  edge_yes: number;
  edge_no: number;
  kelly_fraction: number;
  recommended_size_usdc: number;

  // ── Metaculus-template forecasting fields (added 2026-05-17) ───────────
  /** 10th-percentile estimate of P(YES). */
  ci_low: number;
  /** 90th-percentile estimate of P(YES). */
  ci_high: number;
  /** Historical base rate before any case-specific adjustment. */
  outside_view_p_yes: number;
  /** Signed: final_inside_view_p_yes - outside_view_p_yes. */
  inside_view_adjustment: number;
  /** What happens if nothing changes between now and resolution. */
  status_quo_outcome: "YES" | "NO";
  no_scenario: ScenarioWeight;
  yes_scenario: ScenarioWeight;
  risk_decomposition: RiskBucket[];
  /** Specific events / price thresholds that would change the call. */
  reevaluation_triggers: string[];
  /** Free-text: "stable" or "decays_<X>_bps_per_day". */
  stability: string;
  /** Calibration policy record (set after policy is applied). */
  calibration_adjustment?: CalibrationAdjustment;
  /** Always set — explanation of the recommendation (size or PASS reason). */
  recommendation_reason: string;
}

/**
 * One run inside a Judge ensemble — same fields as JudgeTrace plus the
 * model identifier and any per-model cost.
 */
export interface JudgeEnsembleRun {
  model: string;
  trace: JudgeTrace;
  cost_usd: number;
}

/**
 * Aggregated ensemble output. `aggregate` is what downstream code uses
 * for sizing; `runs` is preserved verbatim in the FullTrace for audit.
 */
export interface JudgeEnsemble {
  /** Aggregated point estimate — median model_p_yes across runs. */
  aggregate: JudgeTrace;
  /** The individual runs that fed the aggregate. */
  runs: JudgeEnsembleRun[];
  /** Fraction of runs whose advisory verdict matched the majority, 0-1. */
  agreement: number;
  /** True when only 1 judge ran (ensembling disabled or fallback). */
  fallback_single_model: boolean;
  /** Sum of cost_usd across runs. */
  total_cost_usd: number;
}

/**
 * The full bundle that gets pinned. Includes:
 *  - One AgentTrace per specialist (4 total)
 *  - The Judge's aggregated trace
 *  - Pinning metadata (hash, IPFS CID, Arc tx hash)
 *  - Aggregate cost accounting
 */
export interface FullTrace {
  /** Schema version — bump when the trace shape changes incompatibly. */
  schema_version: "stoa.insight.v1";
  market_url: string;
  market_question: string;
  user_balance_usdc: number;
  agent_traces: AgentTrace[];
  judge_trace: JudgeTrace;
  /** Full ensemble record (all runs + aggregation). Optional for back-compat
   *  with the single-judge code path; `judge_trace` always mirrors `aggregate`. */
  judge_ensemble?: JudgeEnsemble;
  final_signal: Signal;
  final_confidence: number;
  recommended_size_usdc: number;
  /** Keccak256 of the canonical JSON of this trace (with hash/cid/tx blanked). */
  trace_hash?: `0x${string}`;
  /** IPFS CID returned by web3.storage. */
  ipfs_cid?: string;
  /** Arc Testnet tx hash from TracePin.pinTrace(). */
  pinned_tx?: `0x${string}`;
  total_token_usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    estimated_cost_usd: number;
  };
  /** ISO 8601, when the orchestrator started. */
  started_at: string;
  /** ISO 8601, when the FullTrace was finalized (before pinning). */
  finalized_at: string;
}

/**
 * Minimal market context the orchestrator extracts and passes to every agent.
 * Agents may fetch more via their own tools.
 */
export interface MarketContext {
  url: string;
  slug: string;
  question: string;
  /** Optional description from CLOB metadata. */
  description?: string;
  /** Outcomes — e.g. ["Yes", "No"] for binary markets. */
  outcomes: string[];
  /** Current best ask price for YES outcome, in dollars (0-1). */
  current_yes_price?: number;
  /** Resolution date or end date, if known. */
  end_date?: string;
  /** Total cumulative volume in USDC. */
  volume_usdc?: number;
  /** Trailing 24h volume in USDC, when Gamma exposes it. */
  volume_24h_usdc?: number;
  /** CTF conditionId — needed by the data-api /trades endpoint. */
  condition_id?: string;
  /** Raw CLOB token IDs for YES/NO — needed for orderbook queries. */
  token_ids?: { yes?: string; no?: string };
}
