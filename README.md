# Stoa

Multi-agent prediction-market analysis with on-chain proof and pay-per-call settlement on Circle's Arc Testnet.

## What this repo contains

- **`apps/bot/`** — Cloudflare Worker + grammY Telegram bot. Per-user viem EOAs in D1, `/analyze` + `/confirm` flows. See [`apps/bot/README.md`](apps/bot/README.md).
- **`apps/analyzer/`** — Railway Express service that runs the long pipelines (multi-agent LLM, trace pin, settlement) past the Worker's 30s `waitUntil` cap. Hosts the **x402 facilitator endpoint** for AI agents — see [`apps/analyzer/README.md`](apps/analyzer/README.md).
- **`packages/bot-core/`** — Shared business logic (wallet, Stoa atomic split, insight-engine wrapper, Limitless client, calibration).
- **`packages/insight-engine/`** — 4-specialist + Judge-ensemble Polymarket analyzer (Claude Haiku + Sonnet × 2).
- **`packages/stabletrust-client/`** — Thin Fairblock StableTrust HTTP client for confidential USDC payments on Arc.
- **`contracts/`** — `StoaSettler`, `Splitter`, `TracePin` on Arc Testnet.
- **`docs/`** — V1 architecture notes (confidential payments, wallet management, trace privacy).

## For AI agents — programmatic access via x402

Stoa exposes `POST /api/x402/analyze` on the analyzer service for machine-to-machine use. Pay-per-call USDC on Arc Testnet, no API keys required.

```bash
curl -X POST https://stoa-production-9781.up.railway.app/api/x402/analyze \
  -H "Content-Type: application/json" \
  -d '{"marketUrl": "https://polymarket.com/event/..."}'
# → HTTP 402 with payment instructions

curl -X POST https://stoa-production-9781.up.railway.app/api/x402/analyze \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: 0x<arc_usdc_transfer_tx_hash>" \
  -d '{"marketUrl": "https://polymarket.com/event/..."}'
# → HTTP 200 with verdict + IPFS trace
```

See [`apps/analyzer/README.md#stoa-x402-facilitator-api`](apps/analyzer/README.md#stoa-x402-facilitator-api) for the full reference, and [`apps/analyzer/examples/x402-client.ts`](apps/analyzer/examples/x402-client.ts) for a working TypeScript client.

## Hackathon context

Built for the Agora Agents Hackathon (Arc + Limitless + Polyseer fork). Stack pivot history and architecture decisions live in `NOTES.md` and `docs/`.
