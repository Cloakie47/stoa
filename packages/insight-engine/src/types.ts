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
 * Judge trace adds explicit agreement/disagreement analysis on top of
 * the AgentTrace shape.
 */
export interface JudgeTrace extends AgentTrace {
  agent: "judge";
  /** Plain-text reasoning about where the agents agreed and disagreed. */
  disagreement_analysis: string;
  /** Per-agent (signal, confidence) snapshot — used for the audit trail. */
  agent_signals: Record<string, { signal: Signal; confidence: number }>;
  /** Recommended position size in USDC (0 if signal is PASS). */
  recommended_size_usdc: number;
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
