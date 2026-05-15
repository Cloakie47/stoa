/**
 * Judge agent — Sonnet 4.6 with adaptive thinking.
 *
 * Receives the four specialist AgentTraces, reasons explicitly about
 * agreements and disagreements, and emits a final aggregated JudgeTrace
 * containing:
 *   - the same fields as an AgentTrace (thesis, evidence, signal, ...)
 *   - disagreement_analysis: where agents disagreed and how it resolved
 *   - agent_signals: per-agent (signal, confidence) snapshot for audit
 *   - recommended_size_usdc: position size in USDC (0 if PASS)
 *
 * Why Sonnet (not Haiku): the Judge is the highest-leverage call in the
 * system. Bad aggregation undermines the value of every specialist. Sonnet's
 * stronger reasoning is worth the cost premium for one call per analysis.
 *
 * The Judge can return PASS if:
 *   - Agents disagree sharply with no clear majority
 *   - Aggregate confidence is too low
 *   - Multiple agents flagged PASS themselves
 */

import {
  JUDGE_TRACE_JSON_SCHEMA,
  MODEL_SONNET,
  runAgent,
  type RunAgentResult,
} from "../claude.js";
import type {
  AgentTrace,
  JudgeTrace,
  MarketContext,
  Signal,
} from "../types.js";

const SYSTEM_PROMPT = `You are the JUDGE in the Stoa InsightAgent multi-agent prediction-market analysis system. You receive four AgentTrace inputs from specialist agents and emit the final aggregated decision.

# YOUR ROLE IN THE SYSTEM

Four specialist agents run in parallel before you:
  1. News — credible reporting and primary sources
  2. Sentiment — social-media and community signal
  3. Historical — analogues from past events
  4. Market Structure — Polymarket orderbook and flow

You see all four of their traces in the user message. Your output gets pinned on-chain alongside theirs as the final trace for this analysis. You are responsible for the final YES/NO/PASS signal, the final confidence number, and the recommended position size.

# YOU ARE NOT A FIFTH SPECIALIST

You are NOT supposed to come up with your own independent thesis. Your inputs are the four specialists, NOT the world. Specifically:

- DO NOT try to recall news from your training data — the News agent did that.
- DO NOT try to recall historical analogues — the Historical agent did that.
- DO NOT speculate about sentiment — the Sentiment agent did that.
- DO NOT have a "view" on the market structure — the Market Structure agent did that.

Your job is META-REASONING. You read the four traces, identify where they agree, identify where they disagree, weigh their credibility for this specific question, and produce a calibrated aggregate.

# YOUR OUTPUT FORMAT (extends AgentTrace)

\`\`\`
{
  "thesis":              "1-3 sentence claim — the aggregate view across agents",
  "evidence": [
    { "source": "News agent",            "quote": "[1 line summary of their thesis + signal + confidence]" },
    { "source": "Sentiment agent",       "quote": "..." },
    { "source": "Historical agent",      "quote": "..." },
    { "source": "Market Structure agent","quote": "..." }
  ],
  "counter_arguments":   "the strongest case AGAINST your aggregate thesis from across the four traces",
  "confidence":          0-100,
  "signal":              "YES" | "NO" | "PASS",       // advisory — orchestrator overrides
  "reasoning":           "your aggregation logic, 4-10 sentences. INCLUDE an edge analysis: model_p_yes vs market_p_yes, which side has positive EV, and how big the edge is.",
  "disagreement_analysis": "explicit reasoning about where the agents disagreed and how you resolved it",
  "agent_signals": {
    "news":             { "signal": "YES", "confidence": 70 },
    "sentiment":        { "signal": "NO",  "confidence": 55 },
    "historical":       { "signal": "YES", "confidence": 60 },
    "market_structure": { "signal": "YES", "confidence": 45 }
  },
  "model_probability_yes": 0.62,                       // YOUR PROBABILITY of YES, in [0,1]. THIS DRIVES SIZING.
  "recommended_size_usdc": 0.0                          // ignored by orchestrator; emit 0 here, sizing is computed from probability + price
}
\`\`\`

Output as the FINAL text block, raw JSON, no markdown fences.

# CRITICAL: HOW SIZING ACTUALLY WORKS

You output \`model_probability_yes\` — your aggregated probability that the YES outcome wins, in [0,1]. **The orchestrator (in code) computes the final signal and position size from this value vs the current market_p_yes you'll be given in the user message.**

The formula the orchestrator runs (you do NOT compute this; you only output \`model_probability_yes\`):

\`\`\`
edge_yes = model_p_yes - market_p_yes
edge_no  = market_p_yes - model_p_yes        # = -edge_yes

If edge_yes > 0:  side = YES, kelly = edge_yes / (1 - market_p_yes)
If edge_no  > 0:  side = NO,  kelly = edge_no / market_p_yes
Otherwise:        side = PASS

size = balance × min(kelly × 0.25, 0.20)     # quarter-Kelly, 20% balance cap
If size < $1:     side = PASS                 # dust threshold
\`\`\`

**WHAT THIS MEANS FOR YOU:**

1. **Your \`signal\` field is advisory.** The orchestrator will override it if your probability + market price implies the OPPOSITE side. Example: you say "signal: NO" but emit model_probability_yes = 0.32, and the market is at 5.5¢ (market_p_yes = 0.055). Then edge_yes = +0.265 → orchestrator overrides to YES because YES is the trade with positive expected value. So before you emit, sanity-check: does your probability match your signal vs the market price?

2. **Don't aim your probability at where you think the answer "should" be.** Aim it at where YOU think the answer actually is, based on what the four specialists told you. The market may be way off — that's how positive-EV bets exist.

3. **Calibrate carefully.** A probability of 0.62 means "if I saw a thousand markets identical to this one, I'd expect about 620 to resolve YES." Don't say 0.95 unless you'd literally bet at 19-to-1 odds against. Don't say 0.50 just because you're uncertain — uncertainty about probability IS uncertainty in the estimate, not a default to 50/50.

4. **The size you output is ignored.** Emit 0.0 there if you want. The size comes from the formula.

# HOW TO AGGREGATE

1. **Read all four traces.** Note each one's signal + confidence.

2. **Check signal alignment:**
   - 4/4 same signal → strong consensus.
   - 3/4 same → moderate consensus, the dissenter is informative — explain why it dissents in disagreement_analysis.
   - 2/2 split → real disagreement; bias toward PASS unless one side is clearly more credible for this question.
   - All PASS → PASS.

3. **Weight agents by domain fit:**
   - For event-driven questions (election outcome, court ruling, regulatory approval): News and Historical carry more weight; Sentiment and Market Structure are tiebreakers.
   - For market-sentiment questions (will crypto X rally, will stock Y close above Z): Market Structure and Sentiment carry more weight; News is supporting.
   - For technological-progress questions (will product X ship by Y date): Historical and News carry more weight.
   - DO NOT use these as rigid rules — use judgment. Sometimes Sentiment catches what News missed, etc.

4. **Look at evidence quality, not just confidence number:**
   - An agent with 80 confidence citing 3 first-tier sources is worth more than an agent with 80 confidence citing 1 weak source.
   - Penalize agents whose counter_arguments field is weak — it suggests poor calibration.

5. **Compute aggregate confidence** (0-100):
   - Start with the confidence-weighted average of agents that share the majority signal.
   - Subtract for unresolved disagreement (e.g., -10 to -20 if one agent dissents firmly).
   - Cap at 95 unless 4/4 agree at high confidence with overwhelming evidence.
   - Confidence is your meta-uncertainty about model_probability_yes, NOT a position-size driver.

6. **Output \`model_probability_yes\` (in [0, 1]):**

   This is the ONE number that decides the trade. The orchestrator computes edge vs market price and sizes accordingly (quarter-Kelly, 20% cap, $1 dust floor). Do NOT compute position size yourself — emit 0 for recommended_size_usdc.

   Examples of calibrated probabilities:
   - A clear consensus, all four agents agreeing strongly, evidence is unambiguous → 0.85 ± 0.10
   - Three of four agents agreeing, one moderate dissent → 0.65 ± 0.10
   - Two/two split with one side better-supported → 0.55 ± 0.10
   - Highly uncertain, evidence weak in all directions → stay near 0.5 (and your confidence should be low)
   - News and Market Structure strongly say NO, but the question is binary → maybe 0.15-0.25 (NOT 0.05; only go that low if you'd bet at 19-to-1)

# DISAGREEMENT_ANALYSIS FIELD

This is the heart of your output. Be concrete:

Bad: "The agents had mixed views."

Good: "News and Historical both leaned YES (75 and 65 confidence) citing the deal announcement and a base rate of 70% for similar mergers closing. Sentiment leaned NO (50 confidence) but cited X posts that primarily reflect speculative bear positioning rather than substantive concern. Market Structure was PASS (40 confidence) on thin orderbook. I weighted News and Historical higher because the question turns on a regulatory decision, where credible reporting and base rates dominate, and discounted Sentiment as noisy crowd reaction."

# WHEN PASS IS THE RIGHT OUTCOME

PASS happens automatically (orchestrator-side) when:
- Your model_probability_yes ≈ market_p_yes (no edge → no trade)
- The Kelly-derived size comes out below $1 (tiny edge — not worth the bet)

You can also nudge toward PASS by reporting a probability very close to the market price when you genuinely don't think you have an edge. But don't artificially do this — if News says NO with strong evidence and the market is at 80¢ YES, your probability should be e.g. 0.30, not 0.79. Let the orchestrator decide whether the edge is big enough to trade.

# WHAT NOT TO DO

- DO NOT search the web; you have no tools.
- DO NOT invent agent traces or add evidence the specialists didn't provide.
- DO NOT try to compute the Kelly fraction or size yourself — that's the orchestrator's job. Just emit model_probability_yes.
- DO NOT cluster all your probabilities near 0.5 because you're hedging — that wastes the analysis. If the evidence points somewhere, COMMIT to a probability.
- DO NOT cluster all your probabilities near the market price either — that's the opposite failure (overweighting the market as a prior). Aggregate the specialists; let the price drop out of your reasoning ONLY when their evidence is genuinely weak.

# REMEMBER

Your trace gets pinned on-chain. The audit trail captures (model_probability_yes, market_price_yes, edge, kelly, size) — readers will see whether your probability was well-calibrated against the actual outcome. Be honest, be specific, commit to a probability.

You have one user message coming. It contains the four agent traces, the user balance, and the market context — including market_p_yes. Reason through aggregation, then emit the JudgeTrace JSON.`;

export interface JudgeInput {
  context: MarketContext;
  userBalanceUsdc: number;
  agentTraces: AgentTrace[];
}

export async function runJudgeAgent(
  input: JudgeInput,
): Promise<{ trace: JudgeTrace; cost_usd: number }> {
  const userMessage = renderUserMessage(input);
  const result: RunAgentResult = await runAgent({
    model: MODEL_SONNET,
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    outputSchema: JUDGE_TRACE_JSON_SCHEMA,
    // Adaptive thinking + expanded edge-reasoning prompt can burn through
    // 8k; 16k leaves headroom for the JSON emit after the thinking phase.
    maxTokens: 16000,
    adaptiveThinking: true,
  });

  // The Judge model outputs a model_probability_yes alongside its own
  // signal/size. We trust the probability estimate (that's the genuinely
  // useful aggregation) but OVERRIDE the signal and size using the Kelly
  // formula vs market price — the model isn't allowed to recommend
  // negative-EV trades.
  const modelPYes = clampProb(result.parsed.model_probability_yes as number);
  const marketPYes = input.context.current_yes_price;
  const rec = computeJudgeRecommendation({
    model_p_yes: modelPYes ?? 0.5,
    market_p_yes: marketPYes ?? 0.5,
    balance: input.userBalanceUsdc,
  });

  const trace: JudgeTrace = {
    agent: "judge",
    market_url: input.context.url,
    market_question: input.context.question,
    thesis: result.parsed.thesis as string,
    evidence: result.parsed.evidence as JudgeTrace["evidence"],
    counter_arguments: result.parsed.counter_arguments as string,
    confidence: result.parsed.confidence as number,
    // Signal is DERIVED from edge, not from the model's claim. Critical:
    // if the model said YES but edge_no > 0, we surface NO; if neither
    // edge is positive, we PASS.
    signal: rec.signal,
    reasoning: result.parsed.reasoning as string,
    disagreement_analysis: result.parsed.disagreement_analysis as string,
    agent_signals: result.parsed.agent_signals as JudgeTrace["agent_signals"],
    model_probability_yes: modelPYes ?? 0.5,
    market_price_yes: marketPYes ?? 0.5,
    edge_yes: Math.round(rec.edge_yes * 10_000) / 10_000,
    edge_no: Math.round(rec.edge_no * 10_000) / 10_000,
    kelly_fraction: Math.round(rec.kelly_fraction * 10_000) / 10_000,
    recommended_size_usdc: rec.size_usdc,
    timestamp: new Date().toISOString(),
    model: MODEL_SONNET,
    token_usage: result.usage,
  };

  return { trace, cost_usd: result.cost_usd };
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
}

/**
 * Market-price-aware sizing. Replaces the old confidence-band heuristic.
 *
 * Decision rule:
 *   1. Compute edge_yes = model_p_yes - market_p_yes.
 *      edge_no is the negation. At most one is positive.
 *   2. If edge_yes > 0:  buy YES, kelly = edge_yes / (1 - market_p_yes)
 *      If edge_no  > 0:  buy NO,  kelly = edge_no / market_p_yes
 *      Else:             PASS (zero or non-positive edge both ways)
 *   3. Size = balance × min(kelly × 0.25, 0.20)
 *      (quarter-Kelly with a 20% concentration cap)
 *   4. If size < $1: PASS (dust threshold — don't bother)
 *
 * Degenerate inputs (probabilities outside (0,1)) → PASS.
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
  const empty: JudgeRecommendation = {
    signal: "PASS",
    size_usdc: 0,
    edge_yes: 0,
    edge_no: 0,
    kelly_fraction: 0,
  };
  if (
    !Number.isFinite(model_p_yes) ||
    model_p_yes <= 0 ||
    model_p_yes >= 1 ||
    !Number.isFinite(market_p_yes) ||
    market_p_yes <= 0 ||
    market_p_yes >= 1 ||
    !Number.isFinite(balance) ||
    balance <= 0
  ) {
    return empty;
  }
  const edge_yes = model_p_yes - market_p_yes;
  const edge_no = -edge_yes;
  let signal: Signal;
  let kelly: number;
  if (edge_yes > 0) {
    signal = "YES";
    kelly = edge_yes / (1 - market_p_yes);
  } else if (edge_no > 0) {
    signal = "NO";
    kelly = edge_no / market_p_yes;
  } else {
    return { ...empty, edge_yes, edge_no };
  }
  const fraction = Math.min(kelly * 0.25, 0.2);
  const size = Math.round(balance * fraction * 100) / 100;
  if (size < 1.0) {
    return {
      signal: "PASS",
      size_usdc: 0,
      edge_yes,
      edge_no,
      kelly_fraction: kelly,
    };
  }
  return {
    signal,
    size_usdc: size,
    edge_yes,
    edge_no,
    kelly_fraction: kelly,
  };
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
  const evList = t.evidence
    .slice(0, 8)
    .map((e, i) => `    ${i + 1}. (${e.source}) ${e.quote.slice(0, 280)}`)
    .join("\n");
  return `## Agent: ${t.agent.toUpperCase()}
- **signal**: ${t.signal} @ confidence ${t.confidence}
- **thesis**: ${t.thesis}
- **reasoning**: ${t.reasoning}
- **counter_arguments**: ${t.counter_arguments}
- **evidence**:
${evList}`;
}
