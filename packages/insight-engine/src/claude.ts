/**
 * Centralized Anthropic SDK wrapper for the insight-engine.
 *
 * Responsibilities:
 *   1. Apply `cache_control: { type: "ephemeral" }` to the system prompt of
 *      every call, so repeat analyses (and the 5 calls within one analysis
 *      sharing common framing) hit the prompt cache. Min cacheable prefix is
 *      4096 tokens for Haiku 4.5 and 2048 for Sonnet 4.6 — our system prompts
 *      are sized to clear those thresholds.
 *   2. Constrain output to the AgentTrace JSON schema via `output_config.format`.
 *   3. Aggregate token usage (including cache_read/creation) so the orchestrator
 *      can budget-cap real LLM spend.
 *   4. Centralize model IDs + per-model price table so cost accounting lives
 *      in one place.
 */

import Anthropic from "@anthropic-ai/sdk";

import type { AgentTrace, TokenUsage } from "./types.js";

/** Canonical model IDs — never construct date-suffixed variants. */
export const MODEL_HAIKU = "claude-haiku-4-5" as const;
export const MODEL_SONNET = "claude-sonnet-4-6" as const;

export type ModelId = typeof MODEL_HAIKU | typeof MODEL_SONNET;

/** $/1M tokens per model. Used for budget cap estimation. */
const PRICE_USD_PER_1M: Record<
  ModelId,
  { input: number; output: number; cache_write: number; cache_read: number }
> = {
  // Haiku 4.5: $1/$5 base, cache write ~1.25x input, cache read ~0.1x input.
  [MODEL_HAIKU]: { input: 1.0, output: 5.0, cache_write: 1.25, cache_read: 0.1 },
  // Sonnet 4.6: $3/$15 base, cache write ~3.75 (1.25x input), cache read ~0.3 (0.1x input).
  [MODEL_SONNET]: { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.3 },
};

export function estimateCostUsd(model: ModelId, usage: TokenUsage): number {
  const p = PRICE_USD_PER_1M[model];
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_creation_input_tokens * p.cache_write +
      usage.cache_read_input_tokens * p.cache_read) /
    1_000_000
  );
}

export function emptyUsage(): TokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens:
      a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

function extractUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * JSON Schema for one agent's emitted AgentTrace. Used as the
 * `output_config.format` so Claude is constrained to return well-formed
 * structured output rather than free-text-with-JSON-inside.
 *
 * NOTE: keep this in sync with `AgentTrace` in types.ts. The orchestrator
 * fills in `model` + `token_usage` from the response; agents output the rest.
 */
export const AGENT_TRACE_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    thesis: {
      type: "string" as const,
      description: "1-3 sentence core claim summarizing the agent's view.",
    },
    evidence: {
      type: "array" as const,
      description:
        "Supporting evidence — sources, short quotes, and URLs where possible. Aim for 3-8 items.",
      items: {
        type: "object" as const,
        properties: {
          source: { type: "string" as const },
          quote: { type: "string" as const },
          url: { type: "string" as const },
          timestamp: { type: "string" as const },
        },
        required: ["source", "quote"],
        additionalProperties: false,
      },
    },
    counter_arguments: {
      type: "string" as const,
      description:
        "Reasoning that argues AGAINST your thesis. Required — abstaining is not acceptable.",
    },
    confidence: {
      type: "integer" as const,
      description:
        "Self-rated confidence 0-100. (Range is validated client-side; structured-outputs schemas don't accept min/max.)",
    },
    signal: {
      type: "string" as const,
      enum: ["YES", "NO", "PASS"] as const,
      description: "YES = bet yes, NO = bet no, PASS = insufficient signal.",
    },
    reasoning: {
      type: "string" as const,
      description: "Step-by-step reasoning chain (4-10 sentences).",
    },
  },
  required: [
    "thesis",
    "evidence",
    "counter_arguments",
    "confidence",
    "signal",
    "reasoning",
  ],
  additionalProperties: false,
};

/**
 * JSON Schema for the Judge's output. Extends AgentTrace with two extra
 * required fields.
 */
export const JUDGE_TRACE_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    ...AGENT_TRACE_JSON_SCHEMA.properties,
    disagreement_analysis: {
      type: "string" as const,
      description:
        "Plain-text reasoning about where the 4 agents agreed and disagreed, and how you resolved disagreements.",
    },
    agent_signals: (() => {
      // Named-keys schema for the 4 specialists. Structured outputs disallow
      // `additionalProperties: <object>` — we have to enumerate explicitly.
      const oneAgent = {
        type: "object" as const,
        properties: {
          signal: { type: "string" as const, enum: ["YES", "NO", "PASS"] as const },
          confidence: { type: "integer" as const },
        },
        required: ["signal", "confidence"],
        additionalProperties: false,
      };
      return {
        type: "object" as const,
        description:
          "Per-agent signal snapshot for audit. Always includes news, sentiment, historical, market_structure.",
        properties: {
          news: oneAgent,
          sentiment: oneAgent,
          historical: oneAgent,
          market_structure: oneAgent,
        },
        required: ["news", "sentiment", "historical", "market_structure"],
        additionalProperties: false,
      };
    })(),
    recommended_size_usdc: {
      type: "number" as const,
      description:
        "Recommended position size in USDC. Must be 0 when signal is PASS. (Lower-bound + 20% cap enforced client-side.)",
    },
  },
  required: [
    ...AGENT_TRACE_JSON_SCHEMA.required,
    "disagreement_analysis",
    "agent_signals",
    "recommended_size_usdc",
  ],
  additionalProperties: false,
};

/**
 * Lazy-singleton Anthropic client. Reads ANTHROPIC_API_KEY from env.
 * Throws clear error if missing rather than silently returning 401s.
 */
let cachedClient: Anthropic | null = null;
export function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to the repo's .env file (do not commit) or export it in your shell.",
    );
  }
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

/** Allow tests to inject a mock client without going through env. */
export function setClient(client: Anthropic): void {
  cachedClient = client;
}

/**
 * Retry wrapper around `client.messages.create` that handles transient
 * failures the SDK's built-in retry doesn't:
 *   - 403 Cloudflare-challenge interstitials (returned as HTML, not JSON).
 *     The SDK rejects these as APIError. Seen on WARP↔Cloudflare paths.
 *   - 5xx — SDK already retries these, but only twice; we add one more attempt.
 *
 * 400 (bad request) and 401 (auth) are NEVER retried — caller bug, not transient.
 * Up to 3 attempts total; exponential backoff 2s / 4s.
 */
async function createWithRetry(
  client: Anthropic,
  request: Anthropic.MessageCreateParams,
  model: string,
): Promise<Anthropic.Message> {
  let lastErr: unknown;
  const delays = [2_000, 4_000];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (await client.messages.create(request)) as Anthropic.Message;
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      // Don't retry permanent errors.
      if (status === 400 || status === 401 || status === 404) throw err;
      // Anthropic.BadRequestError isn't transient.
      if (err instanceof Anthropic.BadRequestError) throw err;
      // Retry on 403 (Cloudflare challenge), 408, 409, 429, ≥500, or network errors.
      const retriable =
        status === undefined || // network error / fetch threw
        status === 403 ||
        status === 408 ||
        status === 409 ||
        status === 429 ||
        status >= 500;
      if (!retriable || attempt === delays.length) throw err;
      const wait = delays[attempt]!;
      console.warn(
        `[claude] ${model} call failed (${status ?? "network"}); retrying in ${wait / 1000}s (attempt ${attempt + 1}/${delays.length + 1})`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Parameters for {@link runAgent} — the one entry point every agent uses.
 *
 * The agent supplies its system prompt + (optionally) tools + the
 * task-specific user message. The wrapper handles cache_control placement,
 * structured-output constraint, and usage extraction.
 */
export interface RunAgentParams {
  model: ModelId;
  /**
   * The agent's system prompt. Wrapped in a single text block with
   * `cache_control: { type: "ephemeral" }` so the prefix is cached.
   * MUST be sized to clear the model's minimum cacheable prefix.
   */
  systemPrompt: string;
  /** The user-turn message — task-specific (market context, etc.). */
  userMessage: string | Anthropic.ContentBlockParam[];
  /**
   * Optional server-side or custom tools. Server tools (web_search) run on
   * Anthropic's side; custom tools require {@link RunAgentParams.toolHandlers}
   * to execute and feed results back.
   */
  tools?: Anthropic.ToolUnion[];
  /**
   * Map from custom-tool name → handler function. Required when any tool
   * has `type: "custom"`. Server tools don't need a handler entry.
   */
  toolHandlers?: Record<string, (input: unknown) => Promise<string> | string>;
  /**
   * JSON schema the response must conform to. Defaults to AgentTrace; pass
   * the Judge schema when calling the judge.
   */
  outputSchema?: object;
  /**
   * Max tokens for the final response. 4000 is generous for an AgentTrace.
   * Bumped to 8000 for the Judge (extra fields).
   */
  maxTokens?: number;
  /**
   * Enable Sonnet's adaptive thinking. Default false. Pass true for
   * historical + judge agents.
   */
  adaptiveThinking?: boolean;
  /**
   * Max tool-use iterations before bailing. Default 8 — enough for a
   * search-summarize-cite loop without runaway tool calls.
   */
  maxToolIterations?: number;
}

export interface RunAgentResult {
  /** Parsed AgentTrace fields (or JudgeTrace fields, when outputSchema differs). */
  parsed: Omit<AgentTrace, "agent" | "market_url" | "market_question" | "timestamp" | "model" | "token_usage"> &
    Record<string, unknown>;
  usage: TokenUsage;
  /** Estimated USD cost for this single call. */
  cost_usd: number;
}

/**
 * Run one agent: send the prompt+tools to Claude, run the tool-use loop,
 * extract the structured output, return parsed fields + usage.
 *
 * The tool loop:
 *   - If response includes `tool_use` blocks, execute the matching
 *     handlers, append `tool_result` blocks, and re-prompt.
 *   - If `stop_reason === "end_turn"` (or `"refusal"`/`"pause_turn"`), exit.
 *   - Hard-stop at maxToolIterations to avoid pathological loops.
 */
export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const {
    model,
    systemPrompt,
    userMessage,
    tools,
    toolHandlers,
    outputSchema = AGENT_TRACE_JSON_SCHEMA,
    maxTokens = 4000,
    adaptiveThinking = false,
    maxToolIterations = 8,
  } = params;

  const client = getClient();

  // System with cache_control on the last (and only) block — caches `tools` +
  // `system` together since tools render before system.
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        typeof userMessage === "string"
          ? userMessage
          : userMessage,
    },
  ];

  let totalUsage = emptyUsage();
  let lastResponse: Anthropic.Message | null = null;

  for (let iter = 0; iter < maxToolIterations; iter++) {
    // Build request — only include output_config.format on the FINAL call
    // (when no more tools are likely). To keep this simple, we always include
    // the schema; Claude is well-behaved about producing schema-conforming
    // output when there's no further tool to call.
    //
    // (Structured outputs and tool use are compatible; the model will still
    // emit tool_use blocks when needed, then the final text block conforms
    // to the schema.)
    const request: Anthropic.MessageCreateParams = {
      model,
      max_tokens: maxTokens,
      system,
      messages,
      output_config: {
        format: {
          type: "json_schema",
          schema: outputSchema as Record<string, unknown>,
        },
      },
    };

    if (tools && tools.length > 0) {
      request.tools = tools;
    }

    if (adaptiveThinking) {
      request.thinking = { type: "adaptive" };
    }

    let response: Anthropic.Message;
    try {
      response = await createWithRetry(client, request, model);
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError) {
        throw new Error(`Anthropic 400 for ${model}: ${err.message}`);
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error(`Anthropic rate-limited for ${model}: ${err.message}`);
      }
      throw err;
    }

    lastResponse = response;
    totalUsage = addUsage(totalUsage, extractUsage(response.usage));

    // Always echo the assistant turn back into history (required so tool_use
    // ids match tool_result ids on the next turn).
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn" || response.stop_reason === "refusal") {
      break;
    }

    if (response.stop_reason === "pause_turn") {
      // Server-side tool (e.g. web_search) hit its inner iteration cap. Re-send
      // with the same history; the server resumes.
      continue;
    }

    if (response.stop_reason !== "tool_use") {
      // max_tokens or any other terminal state — stop and let the parser
      // handle whatever we got.
      break;
    }

    // Collect custom-tool calls; execute them; feed results back.
    const customToolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (customToolUses.length === 0) {
      // tool_use stop_reason but only server-tool blocks. The next turn is
      // handled server-side; resume.
      continue;
    }

    if (!toolHandlers) {
      throw new Error(
        `Claude requested custom tool(s) [${customToolUses.map((b) => b.name).join(", ")}] but no toolHandlers were provided`,
      );
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of customToolUses) {
      const handler = toolHandlers[toolUse.name];
      if (!handler) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Tool ${toolUse.name} is not registered in this agent.`,
          is_error: true,
        });
        continue;
      }
      try {
        const result = await handler(toolUse.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
      } catch (e) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Tool ${toolUse.name} threw: ${(e as Error).message}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  if (!lastResponse) {
    throw new Error("Tool-use loop exited without any response — should be unreachable");
  }

  // Extract the structured-output JSON from the last response.
  // With output_config.format set, the model emits the JSON as plain text in
  // a final TextBlock. Find the LAST text block (server-tool result blocks
  // can interleave) and parse it.
  const textBlocks = lastResponse.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  if (textBlocks.length === 0) {
    throw new Error(
      `No text block in final response (stop_reason=${lastResponse.stop_reason}). Likely exhausted maxToolIterations.`,
    );
  }
  const lastText = textBlocks[textBlocks.length - 1]!.text;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(lastText) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `Failed to parse structured-output JSON: ${(e as Error).message}\nText was: ${lastText.slice(0, 500)}`,
    );
  }

  return {
    parsed: parsed as RunAgentResult["parsed"],
    usage: totalUsage,
    cost_usd: estimateCostUsd(model, totalUsage),
  };
}
