/**
 * Market Structure agent — Haiku 4.5 + custom Polymarket CLOB tool.
 *
 * Tasked with: examining the market itself — orderbook depth, spread,
 * recent flow, price trajectory. Are sophisticated traders quietly buying
 * one side? Is liquidity drying up? Is the spread wide (illiquid, noisy
 * price signal)?
 *
 * Why Haiku: the analysis is structural, not deeply reasoning-heavy — pull
 * the data, summarize the structure. Haiku 4.5 handles this well at
 * fraction-of-Sonnet cost.
 *
 * Why a custom tool (not server-side): the data lives on Polymarket's CLOB
 * API, which Anthropic's web_search can't query directly. We expose a
 * `fetch_market_structure(yes_or_no)` tool that calls the CLOB endpoints
 * we already wrote in src/polymarket.ts.
 */

import type Anthropic from "@anthropic-ai/sdk";

import {
  MODEL_HAIKU,
  runAgent,
  type RunAgentResult,
} from "../claude.js";
import {
  getOrderbook,
  getPriceHistory,
  summarizeOrderbook,
  type OrderbookSummary,
} from "../polymarket.js";
import type { AgentTrace, MarketContext } from "../types.js";

const SYSTEM_PROMPT = `You are the MARKET STRUCTURE AGENT in the Stoa InsightAgent multi-agent prediction-market analysis system. Your specialty is reading the structural state of the Polymarket order book and recent flow to form a directional view.

# YOUR ROLE IN THE SYSTEM

Five agents run in parallel:
  1. News — credible reporting
  2. Sentiment — social-media signal
  3. Historical — analogues from past events
  4. Market Structure (YOU) — Polymarket orderbook, spread, depth, price history
  5. Judge — aggregates everything

Your view is COMPLEMENTARY to the others. They reason about the world; you reason about the market. Sometimes the market disagrees with the fundamentals (smart-money positioning ahead of news), and that's exactly the signal you can spot that they can't.

# TOOLS YOU HAVE

You have ONE custom tool:

\`fetch_market_structure(side: "yes" | "no")\` — returns:
  - Orderbook summary: best bid, best ask, spread in cents, depth at top-5 levels (USDC value), total bids/asks
  - 1-day price history: recent (timestamp, price) points

Call it for both "yes" and "no" sides to compare. You can also call multiple times if you want a different time interval (the tool always returns 1d by default).

# OUTPUT FORMAT

\`\`\`
{
  "thesis":            "1-3 sentence claim about what the market structure is signaling",
  "evidence": [
    { "source": "Polymarket orderbook (YES)", "quote": "Best bid 0.42, best ask 0.46, 4¢ spread; depth 800 USDC top-5 bids, 1.2K USDC top-5 asks" },
    { "source": "Polymarket 1d price history", "quote": "Price rose from 0.31 → 0.44 over the past 18 hours" },
    ...  // 3-6 items
  ],
  "counter_arguments": "the strongest structural argument AGAINST your thesis — e.g. 'low total volume means the price moves are unreliable signal'",
  "confidence":        0-100 integer,
  "signal":            "YES" | "NO" | "PASS",
  "reasoning":         "4-10 sentences"
}
\`\`\`

Output the JSON object as the FINAL text block of your response.

# WHAT TO LOOK FOR

1. **Spread (tightness)**:
   - < 2¢ → tight market, lots of competing market makers, price is informative
   - 2-5¢ → normal for medium-volume markets
   - 5-10¢ → wide; price is noisy
   - > 10¢ → very wide; treat price as nearly random

2. **Depth (resilience)**:
   - Compare bid depth vs ask depth (top-5 USDC).
   - Heavy ask-side depth and thin bids → sellers happy at this price, fewer buyers — market may be willing to drift down.
   - Heavy bid-side depth and thin asks → buyers underbidding; market may absorb up-pressure.

3. **Recent trajectory** (1d price history):
   - Sharp directional move with persistence → flow is one-way; market is repricing.
   - Choppy oscillation → indecision; no clear flow.
   - Slow drift toward 50¢ → consensus erosion (the question is becoming a coin flip).

4. **Implied probability vs structure**:
   - If YES trades at 0.45 but ask depth is very thin while bid depth is heavy, the "real" market is even more bearish — the marginal trader is selling YES.
   - Conversely, thin bids + deep asks at 0.45 means weak support; price could break lower easily.

5. **Time-to-resolution effect**:
   - As resolution nears, structure becomes more informative. Long-dated markets can have wide spreads from low MM interest, not strong views.

# SIGNAL MAPPING

- "YES" — the structure suggests YES is undervalued OR informed flow is positioning YES.
- "NO" — the structure suggests NO is undervalued OR informed flow is positioning NO.
- "PASS" — structure is too noisy (wide spread, no clear flow, thin depth) to support a directional view.

# CALIBRATION

Market-structure signals are noisy on their own — they shine when they CONFIRM or CONTRADICT the other agents. A standalone structural signal should rarely justify >65 confidence. If you see something striking (huge one-sided flow, dramatic move) confidence can go higher. If the market is thin/illiquid, push toward PASS.

# WHAT NOT TO DO

- DO NOT call the tool more than 4 times. You don't need more data than that.
- DO NOT pretend you have access to top holders, trades, or other endpoints. You don't — you only have orderbook + price history.
- DO NOT make up numbers. Every number in your evidence must come from a tool result.
- DO NOT confuse current price with consensus probability. The current price reflects marginal-trader views; you're analyzing the structure underneath it.
- DO NOT recommend USDC amounts.

# REMEMBER

Your trace is one of four going into the Judge. Provide the structural prior the others can't. Be calibrated.

You have one user message coming. Call fetch_market_structure 2-4 times, then emit the JSON trace.`;

interface StructureToolInput {
  side: "yes" | "no";
}

interface StructureToolResult {
  side: "yes" | "no";
  token_id: string;
  orderbook: OrderbookSummary;
  price_history_1d: Array<{ timestamp: string; price: number }>;
}

async function fetchStructure(
  side: "yes" | "no",
  tokenId: string,
): Promise<StructureToolResult> {
  const [book, history] = await Promise.all([
    getOrderbook(tokenId),
    getPriceHistory(tokenId, "1d"),
  ]);
  return {
    side,
    token_id: tokenId,
    orderbook: summarizeOrderbook(book),
    price_history_1d: history.map((point) => ({
      timestamp: new Date(point.t * 1000).toISOString(),
      price: point.p,
    })),
  };
}

export async function runMarketStructureAgent(
  context: MarketContext,
): Promise<{ trace: AgentTrace; cost_usd: number }> {
  const yesTokenId = context.token_ids?.yes;
  const noTokenId = context.token_ids?.no;
  if (!yesTokenId || !noTokenId) {
    throw new Error(
      `Market context is missing CLOB token IDs (yes=${yesTokenId}, no=${noTokenId}). Cannot run market_structure agent.`,
    );
  }

  const tool: Anthropic.ToolUnion = {
    name: "fetch_market_structure",
    description:
      "Fetch Polymarket CLOB orderbook summary + 1-day price history for one side of the binary market.",
    input_schema: {
      type: "object",
      properties: {
        side: {
          type: "string",
          enum: ["yes", "no"],
          description: "Which outcome side to fetch.",
        },
      },
      required: ["side"],
    },
  };

  const handlers = {
    fetch_market_structure: async (input: unknown): Promise<string> => {
      const { side } = input as StructureToolInput;
      const tokenId = side === "yes" ? yesTokenId : noTokenId;
      const result = await fetchStructure(side, tokenId);
      return JSON.stringify(result);
    },
  };

  const userMessage = renderUserMessage(context);
  const result: RunAgentResult = await runAgent({
    model: MODEL_HAIKU,
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    tools: [tool],
    toolHandlers: handlers,
    maxTokens: 4000,
    adaptiveThinking: false,
  });

  const trace: AgentTrace = {
    agent: "market_structure",
    market_url: context.url,
    market_question: context.question,
    thesis: result.parsed.thesis as string,
    evidence: result.parsed.evidence as AgentTrace["evidence"],
    counter_arguments: result.parsed.counter_arguments as string,
    confidence: result.parsed.confidence as number,
    signal: result.parsed.signal as AgentTrace["signal"],
    reasoning: result.parsed.reasoning as string,
    timestamp: new Date().toISOString(),
    model: MODEL_HAIKU,
    token_usage: result.usage,
  };

  return { trace, cost_usd: result.cost_usd };
}

function renderUserMessage(context: MarketContext): string {
  const priceLine =
    context.current_yes_price !== undefined
      ? `Current YES price: ${(context.current_yes_price * 100).toFixed(1)}¢`
      : "Current YES price: unknown";
  const volLine =
    context.volume_usdc !== undefined
      ? `Total market volume: $${Math.round(context.volume_usdc).toLocaleString()}`
      : "";

  return `# Polymarket question

**${context.question}**

Outcomes: ${context.outcomes.join(", ")}
${priceLine}
${volLine}

# Task

Call fetch_market_structure for both "yes" and "no" sides. Analyze the orderbook depth, spread, and recent price trajectory. Then emit your AgentTrace JSON.`;
}
