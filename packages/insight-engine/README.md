# @stoa/insight-engine

Multi-agent Polymarket analysis. Four specialist Claude agents (News, Sentiment, Historical, Market Structure) reason about a prediction-market question in parallel; a Sonnet 4.6 Judge aggregates their traces, reasons about disagreement, and returns a calibrated YES/NO/PASS signal plus a recommended position size. The full bundle is hashed, pinned to IPFS, and anchored to Arc Testnet via `TracePin.pinTrace()` for an immutable audit trail.

```
                ┌─ News      (Haiku 4.5 + web_search)   ─┐
                ├─ Sentiment (Haiku 4.5 + X/Neynar)      ─┤
  marketUrl ──▶ ├─ Historical (Sonnet 4.6, no tools)     ─┤──▶ Judge (Sonnet 4.6) ──▶ FullTrace ──▶ Arc + IPFS
                └─ Market Structure (Haiku 4.5 + CLOB)   ─┘
```

## Public API

```ts
import { analyzeMarket } from "@stoa/insight-engine";

const result = await analyzeMarket(
  "https://polymarket.com/market/will-the-fed-cut-rates-in-june-2026",
  100, // user balance in USDC
  { budgetCapUsd: 1.0, pinOnChain: true },
);

result.trace.final_signal;        // "YES" | "NO" | "PASS"
result.trace.final_confidence;    // 0-100
result.trace.recommended_size_usdc;
result.trace.judge_trace.disagreement_analysis;
result.pin?.tx_hash;              // Arc Testnet tx pinning the trace
result.pin?.ipfs_cid;              // IPFS CID of the full JSON
result.cost_usd;                  // total LLM spend for this analysis
```

## Prompt caching

Every system prompt is sized to clear the model's minimum cacheable prefix (4096 tokens for Haiku 4.5, 2048 for Sonnet 4.6) and wrapped with `cache_control: { type: "ephemeral" }`. Re-running an analysis (or running multiple analyses in the same 5-minute window) gets ~90% cost reduction on the cached prefix bytes. Verify via `response.usage.cache_read_input_tokens` — the orchestrator aggregates it in `FullTrace.total_token_usage.cache_read_input_tokens`.

## Required env vars

| Var | Purpose | Required? |
|---|---|---|
| `ANTHROPIC_API_KEY` | All LLM calls | **Yes** for any non-mocked usage |
| `DEPLOYER_PRIVATE_KEY` | Signs `TracePin.pinTrace()` on Arc | Required for `pinOnChain: true` |
| `ARC_TESTNET_RPC` | Arc Testnet RPC URL | Required for `pinOnChain: true` |
| `TRACEPIN_ADDRESS` | Deployed TracePin contract address | Required for `pinOnChain: true` |
| `PINATA_JWT` | Pinata IPFS pinning (preferred path) | Optional — degrades to empty CID on-chain |
| `STORACHA_KEY` + `STORACHA_PROOF` | Storacha (web3.storage) IPFS pinning | Alternative to Pinata |
| `X_BEARER_TOKEN` | X (Twitter) API for Sentiment agent | Optional — falls back to web_search |
| `NEYNAR_API_KEY` | Farcaster API for Sentiment agent | Optional — falls back to web_search |

## Testing

```bash
pnpm test               # mocked unit tests (26 tests, no real spend)
RUN_E2E_INSIGHT=1 pnpm test test/e2e.test.ts   # live LLM run, ~$0.10-0.30
```

The integration test auto-skips unless `RUN_E2E_INSIGHT=1` and `ANTHROPIC_API_KEY` are both set, so CI without keys passes cleanly.

## Cost expectations

| Run type | Approx cost |
|---|---|
| First analysis (cold cache) | $0.15 – $0.30 |
| Repeat analysis within 5 min (warm cache) | $0.02 – $0.05 |
| Most expensive single call | Sonnet 4.6 Judge with adaptive thinking |

The orchestrator enforces `budgetCapUsd` (default $5) and aborts before the Judge call if specialists already spent more than half the cap.
