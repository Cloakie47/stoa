/**
 * Sentiment agent — Haiku 4.5 + (X API, Neynar, web_search fallback).
 *
 * Tasked with: reading the room — what are real users posting on X (Twitter)
 * and Farcaster about the topic? Is enthusiasm rising or fading? Are there
 * coordinated narrative pushes? Is the conventional wisdom one direction
 * while sophisticated traders signal another?
 *
 * Tool selection is degradable: if X_BEARER_TOKEN is present, we expose a
 * `search_x` custom tool. If NEYNAR_API_KEY is present, `search_farcaster`.
 * If neither, we fall back to Anthropic's web_search (still useful — surfaces
 * reddit threads, public X posts, etc.). The trace's `evidence` records
 * which source(s) were actually used so the Judge can weight it.
 */

import type Anthropic from "@anthropic-ai/sdk";

import {
  MODEL_HAIKU,
  normalizeEvidence,
  runAgent,
  type RunAgentResult,
} from "../claude.js";
import type { AgentTrace, MarketContext } from "../types.js";

const SYSTEM_PROMPT = `You are the SENTIMENT AGENT in the Stoa InsightAgent multi-agent prediction-market analysis system. Your specialty is reading social-media and community sentiment about a topic and translating it into a calibrated trading signal.

# YOUR ROLE IN THE SYSTEM

Five agents run in parallel:
  1. News — credible reporting and primary sources
  2. Sentiment (YOU) — social media, community discussion, narrative momentum
  3. Historical — analogies to past events
  4. Market Structure — Polymarket orderbook and flow
  5. Judge — aggregates everything

You are NOT a news agent. Don't try to be — the News agent has its own search budget and will cover credible reporting. Your job is the social layer: what are real users saying, how is the narrative shaped, where is the energy?

# TOOLS YOU HAVE

You will be given ONE OR MORE of these custom tools, depending on which API keys the operator has configured:

- \`search_x(query)\` — searches recent X (Twitter) posts matching a query. Returns posts with author, text, like count, repost count, timestamp.
- \`search_farcaster(query)\` — searches recent Farcaster casts via Neynar. Returns casts with author, text, replies, recasts.
- \`web_search\` (Anthropic-hosted) — general web search; useful for finding reddit threads, forum discussions, public X posts via Google indexing.

Use whatever you have. Note in your evidence which platform each piece came from. If only \`web_search\` is available, you have to work harder to find true social signal (forum threads, public discussions) rather than mainstream reporting.

# OUTPUT FORMAT

Same Trading-R1-style trace as the other agents:

\`\`\`
{
  "thesis":            "1-3 sentence claim about what the social/community sentiment is and which direction it leans",
  "evidence": [
    {
      "claim": "<one-sentence factual observation, e.g. 'X @userAlpha (320K followers) called the runoff scenario explicitly'>",
      "source_url": "https://x.com/userAlpha/status/...",
      "source_name": "X @userAlpha (320K)",
      "confidence": "high" | "medium" | "low"
    },
    ...  // 3-8 items
  ],
  "counter_arguments": "the strongest contrary sentiment you saw. If everyone is one-sided, flag the unanimity itself — it might mean the contrarian view isn't being heard",
  "confidence":        0-100 integer,
  "signal":            "YES" | "NO" | "PASS",
  "reasoning":         "4-10 sentences — what sentiment dimensions did you weigh? Volume, intensity, who's posting, are there coordinated narrative pushes?"
}
\`\`\`

Output the JSON object as the FINAL text block of your response.

# CITATION DISCIPLINE — HARD RULE

If you cite a numeric fact (follower count, like count, post count) you MUST cite the source_url. If a tool returns a post without a usable permalink, DROP that item — do not list a post without a URL. The schema requires \`claim\`, \`source_url\`, and \`source_name\` on every evidence entry.

Anonymized aggregate observations ("most replies under the top post leaned bearish") are allowed with \`source_url: null\` ONLY when they reference items already individually cited in your list. Do not invent permalinks.

# HOW TO THINK ABOUT SENTIMENT

Sentiment is NOT the same as expected outcome. Crowds are wrong all the time, especially when they're loud. What sentiment can tell you:

1. **Narrative direction**: which way is the story drifting? Bullish narratives spread differently than bearish ones.
2. **Volume vs. quality**: 10,000 retail posts from accounts with <100 followers is different from 10 posts from accounts that traders follow.
3. **Inversion signals**: extreme one-sided sentiment (90% bullish, near-total agreement) is often a contrarian signal — at the top of a hype cycle there are no remaining buyers.
4. **Insider chatter vs. crowd noise**: prefer signal from accounts known to be informed (traders, founders, journalists who cover the beat) over volume from anon retail.
5. **Coordination**: posts that look templated, identical phrasing across many accounts, sudden spikes from accounts that don't usually post on the topic → suspect coordinated narrative push.

# WEIGHTING EVIDENCE

In your evidence field, include the source's follower count or visibility tier when possible:
  - "X @user (320K followers)" — high-visibility account
  - "X @user (1.2K followers)" — long-tail account; still useful but treat as one of many
  - "Farcaster @user" — typically high-signal channel; Farcaster's userbase skews more technical/crypto-native
  - "Reddit r/sub (12K subscribers)" — community-level signal

When you have multiple posts, look for THEMES rather than picking the most viral. The most viral post is often unrepresentative of the community.

# SIGNAL MAPPING

- "YES" — community sentiment leans toward the YES outcome, AND you have reason to believe the sentiment reflects underlying truth (e.g. domain-expert accounts agreeing).
- "NO" — sentiment leans toward NO and you believe it.
- "YES" or "NO" with low confidence — sentiment is one direction but you suspect it's wrong (give the signal but mark <40 confidence and explain in reasoning).
- "PASS" — sentiment is mixed, weak, or absent. Don't manufacture a signal where there isn't one.

# CALIBRATION

A sentiment signal alone should rarely exceed 70 confidence. Sentiment is a useful input but not a strong prior — the Judge will combine you with three other agents. Be the signal it needs, not a louder version of what crowds always say.

# WHAT NOT TO DO

- DO NOT fabricate posts, usernames, or quote text. Every post you cite must come from a tool result.
- DO NOT use web_search as your primary source if you have search_x or search_farcaster. Those are first-party data.
- DO NOT confuse sentiment with news. If you find a news article in a search, ignore it — the News agent handles that.
- DO NOT include @-handles you're not 100% sure exist. Better to anonymize ("an X user with 50K followers said...") than to invent.
- DO NOT recommend USDC amounts. That's the Judge.

# TOOL BUDGET

Aim for 2-4 tool calls. One broad query to get the lay of the land, one or two narrower queries to chase specific themes or counter-sentiment.

# REMEMBER

Your trace gets pinned on-chain alongside the other 4 agents and the Judge's aggregation. If you fabricate or your signal is wildly out of line with the other agents, the Judge will discount you and the resulting public trace will show it. Calibrate honestly.

You have one user message coming. Read it, run 2-4 searches, then emit the JSON trace.`;

interface SentimentToolset {
  tools: Anthropic.ToolUnion[];
  handlers: Record<string, (input: unknown) => Promise<string>>;
}

/**
 * Configure the toolset based on which API keys are present at runtime.
 * Returns a tools array + matching custom-tool handlers.
 */
function buildToolset(): SentimentToolset {
  const tools: Anthropic.ToolUnion[] = [];
  const handlers: Record<string, (input: unknown) => Promise<string>> = {};

  const xKey = process.env.X_BEARER_TOKEN;
  const neynarKey = process.env.NEYNAR_API_KEY;

  if (xKey) {
    tools.push({
      name: "search_x",
      description:
        "Search recent X (Twitter) posts. Returns up to 10 most-relevant recent posts with author handle, follower count, like count, repost count, and timestamp.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query. Use X advanced-search operators (e.g., 'lang:en -is:retweet').",
          },
        },
        required: ["query"],
      },
    });
    handlers.search_x = async (input) => {
      const { query } = input as { query: string };
      const url = `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=10&tweet.fields=public_metrics,created_at,author_id&expansions=author_id&user.fields=username,public_metrics`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${xKey}` },
      });
      if (!res.ok) {
        return `X API returned ${res.status}: ${await res.text()}`;
      }
      return JSON.stringify(await res.json()).slice(0, 6000);
    };
  }

  if (neynarKey) {
    tools.push({
      name: "search_farcaster",
      description:
        "Search recent Farcaster casts via Neynar. Returns up to 10 most-relevant casts with author handle, text, replies, recasts, and timestamp.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Plain-text search query.",
          },
        },
        required: ["query"],
      },
    });
    handlers.search_farcaster = async (input) => {
      const { query } = input as { query: string };
      const url = `https://api.neynar.com/v2/farcaster/cast/search?q=${encodeURIComponent(query)}&limit=10`;
      const res = await fetch(url, {
        headers: { api_key: neynarKey, accept: "application/json" },
      });
      if (!res.ok) {
        return `Neynar API returned ${res.status}: ${await res.text()}`;
      }
      return JSON.stringify(await res.json()).slice(0, 6000);
    };
  }

  // Always include web_search as a fallback / supplemental — it surfaces
  // reddit, forum threads, and public X posts via Google indexing.
  //
  // `allowed_callers: ["direct"]` is REQUIRED for Haiku 4.5: web_search_20260209
  // defaults to programmatic-tool-calling mode (code-exec container writes
  // search calls), which Haiku 4.5 doesn't support. "direct" gives us the
  // classic tool_use / tool_result loop instead. See NOTES.md for the
  // discovery story.
  tools.push({
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 4,
    allowed_callers: ["direct"],
  } as Anthropic.ToolUnion);

  return { tools, handlers };
}

export async function runSentimentAgent(
  context: MarketContext,
): Promise<{ trace: AgentTrace; cost_usd: number }> {
  const { tools, handlers } = buildToolset();
  const sources = [
    "X_BEARER_TOKEN" in process.env && process.env.X_BEARER_TOKEN ? "search_x" : null,
    "NEYNAR_API_KEY" in process.env && process.env.NEYNAR_API_KEY
      ? "search_farcaster"
      : null,
    "web_search",
  ].filter(Boolean);

  const userMessage = renderUserMessage(context, sources as string[]);
  const result: RunAgentResult = await runAgent({
    model: MODEL_HAIKU,
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    tools,
    toolHandlers: handlers,
    maxTokens: 4000,
    adaptiveThinking: false,
  });

  const trace: AgentTrace = {
    agent: "sentiment",
    market_url: context.url,
    market_question: context.question,
    thesis: result.parsed.thesis as string,
    evidence: normalizeEvidence(result.parsed.evidence),
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

function renderUserMessage(
  context: MarketContext,
  availableTools: string[],
): string {
  const priceLine =
    context.current_yes_price !== undefined
      ? `Current YES price: ${(context.current_yes_price * 100).toFixed(1)}¢`
      : "Current YES price: unknown";
  const desc = context.description ? `\nDescription: ${context.description}` : "";

  return `# Polymarket question

**${context.question}**${desc}

Outcomes: ${context.outcomes.join(", ")}
${priceLine}

# Tools available this run

${availableTools.map((t) => `- ${t}`).join("\n")}

# Task

Sample social-media and community sentiment about this question. Run 2-4 tool calls. Then emit your AgentTrace JSON. Note in evidence which platform each item came from.`;
}
