import type { MarketContext } from "../../src/types.js";

/** Reusable MarketContext for agent tests — no network, no Gamma fetch. */
export const FIXTURE_CONTEXT: MarketContext = {
  url: "https://polymarket.com/market/will-the-fed-cut-rates-in-june-2026",
  slug: "will-the-fed-cut-rates-in-june-2026",
  question: "Will the Fed cut rates at its June 2026 meeting?",
  description:
    "Resolves YES if the FOMC announces a target-rate reduction at the June 2026 meeting.",
  outcomes: ["Yes", "No"],
  current_yes_price: 0.42,
  end_date: "2026-06-15T00:00:00Z",
  volume_usdc: 2_500_000,
  token_ids: {
    yes: "1234567890123456789012345678901234567890123456789012345678901234",
    no: "9876543210987654321098765432109876543210987654321098765432109876",
  },
};

/** Sample structured-output JSON an agent might return. */
export const VALID_TRACE_FIELDS = {
  thesis: "Test thesis — placeholder.",
  evidence: [
    {
      source: "Test source",
      quote: "Test quote",
      url: "https://example.com/article",
    },
  ],
  counter_arguments: "Test counter-argument",
  confidence: 65,
  signal: "YES" as const,
  reasoning: "Test reasoning chain.",
};

export const VALID_JUDGE_FIELDS = {
  ...VALID_TRACE_FIELDS,
  disagreement_analysis:
    "News and Historical agreed YES; Sentiment and Market Structure agreed YES at lower confidence.",
  agent_signals: {
    news: { signal: "YES" as const, confidence: 70 },
    sentiment: { signal: "YES" as const, confidence: 55 },
    historical: { signal: "YES" as const, confidence: 60 },
    market_structure: { signal: "YES" as const, confidence: 50 },
  },
  /** Model's probability of YES. Drives the orchestrator's Kelly + sizing. */
  model_probability_yes: 0.62,
  /** Ignored by orchestrator now — the size is derived. Kept for schema compliance. */
  recommended_size_usdc: 0,
};
