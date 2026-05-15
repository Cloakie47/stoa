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
  "signal":              "YES" | "NO" | "PASS",
  "reasoning":           "your aggregation logic, 4-10 sentences",
  "disagreement_analysis": "explicit reasoning about where the agents disagreed and how you resolved it (or why you couldn't, leading to PASS)",
  "agent_signals": {
    "news":             { "signal": "YES", "confidence": 70 },
    "sentiment":        { "signal": "NO",  "confidence": 55 },
    "historical":       { "signal": "YES", "confidence": 60 },
    "market_structure": { "signal": "YES", "confidence": 45 }
  },
  "recommended_size_usdc": 25.0
}
\`\`\`

Output as the FINAL text block, raw JSON, no markdown fences.

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

5. **Compute aggregate confidence:**
   - Start with the confidence-weighted average of agents that share the majority signal.
   - Subtract for unresolved disagreement (e.g., -10 to -20 if one agent dissents firmly).
   - Cap at 80 unless 4/4 agree at high confidence.
   - If aggregate < 50, default to PASS.

6. **Decide recommended_size_usdc:**

   You'll be given the user's balance in USDC. Recommended size is bounded by:
   - PASS signal → 0 USDC, ALWAYS.
   - Confidence < 50 → PASS.
   - Confidence 50-60: 5% of balance (small position).
   - Confidence 60-70: 10% of balance.
   - Confidence 70-80: 15% of balance.
   - Confidence 80+: 20% of balance.
   - Hard cap: NEVER recommend > 20% of balance, regardless of confidence. This is a single bet on a binary outcome; concentration risk dominates.
   - Round to 2 decimal places.

# DISAGREEMENT_ANALYSIS FIELD

This is the heart of your output. Be concrete:

Bad: "The agents had mixed views."

Good: "News and Historical both leaned YES (75 and 65 confidence) citing the deal announcement and a base rate of 70% for similar mergers closing. Sentiment leaned NO (50 confidence) but cited X posts that primarily reflect speculative bear positioning rather than substantive concern. Market Structure was PASS (40 confidence) on thin orderbook. I weighted News and Historical higher because the question turns on a regulatory decision, where credible reporting and base rates dominate, and discounted Sentiment as noisy crowd reaction."

# WHEN TO RETURN PASS

- Aggregate confidence < 50.
- Agents are 2/2 split with no clear way to break the tie.
- All four agents themselves returned PASS.
- The question is too speculative for any signal to be high-conviction.

PASS is a respectable outcome. Better to skip a bad bet than to manufacture a fake one.

# WHAT NOT TO DO

- DO NOT search the web; you have no tools.
- DO NOT invent agent traces or add evidence the specialists didn't provide.
- DO NOT exceed 20% of the user's balance in recommended_size.
- DO NOT set recommended_size > 0 when signal is PASS.
- DO NOT echo the user's balance back as the size — calibrate it to your confidence.
- DO NOT lecture about uncertainty in reasoning — quantify it via your confidence and size numbers.

# REMEMBER

Your trace is the final word. The user (and on-chain audit) will see your reasoning, disagreement_analysis, and final signal. Be honest about where the specialists disagreed; calibrate the size to your confidence; default to PASS when in doubt.

You have one user message coming. It contains the four agent traces, the user balance, and the market context. Reason through aggregation, then emit the JudgeTrace JSON.`;

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
    maxTokens: 8000, // bigger budget for the judge's analysis
    adaptiveThinking: true,
  });

  const trace: JudgeTrace = {
    agent: "judge",
    market_url: input.context.url,
    market_question: input.context.question,
    thesis: result.parsed.thesis as string,
    evidence: result.parsed.evidence as JudgeTrace["evidence"],
    counter_arguments: result.parsed.counter_arguments as string,
    confidence: result.parsed.confidence as number,
    signal: result.parsed.signal as Signal,
    reasoning: result.parsed.reasoning as string,
    disagreement_analysis: result.parsed.disagreement_analysis as string,
    agent_signals: result.parsed.agent_signals as JudgeTrace["agent_signals"],
    recommended_size_usdc: enforceSizeBounds(
      result.parsed.signal as Signal,
      result.parsed.recommended_size_usdc as number,
      input.userBalanceUsdc,
    ),
    timestamp: new Date().toISOString(),
    model: MODEL_SONNET,
    token_usage: result.usage,
  };

  return { trace, cost_usd: result.cost_usd };
}

/**
 * Belt-and-suspenders enforcement of the size rules from the prompt. The
 * Judge is generally well-behaved but we don't trust it with money math —
 * clamp the size to [0, 20% of balance] and zero it on PASS.
 */
function enforceSizeBounds(
  signal: Signal,
  modelSize: number,
  balance: number,
): number {
  if (signal === "PASS") return 0;
  const cap = balance * 0.2;
  const clamped = Math.max(0, Math.min(modelSize, cap));
  return Math.round(clamped * 100) / 100;
}

function renderUserMessage(input: JudgeInput): string {
  const { context, userBalanceUsdc, agentTraces } = input;
  const priceLine =
    context.current_yes_price !== undefined
      ? `Current YES price: ${(context.current_yes_price * 100).toFixed(1)}¢`
      : "Current YES price: unknown";

  const traceBlocks = agentTraces
    .map((t) => renderTraceForJudge(t))
    .join("\n\n");

  return `# Polymarket question

**${context.question}**

Outcomes: ${context.outcomes.join(", ")}
${priceLine}

# User balance

$${userBalanceUsdc.toFixed(2)} USDC available

# Agent traces (the four specialists' outputs)

${traceBlocks}

# Task

Aggregate the four traces. Identify where they agreed and where they disagreed. Weigh the agents by domain fit for THIS question. Emit your JudgeTrace JSON as the final text block, conforming to the schema in your system prompt. Remember: recommended_size_usdc must be 0 when signal is PASS, and never exceed 20% of the user balance.`;
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
