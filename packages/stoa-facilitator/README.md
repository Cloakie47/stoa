# @stoa/facilitator

Agentic x402 facilitator that **verifies, splits, and settles payments atomically** on Arc. Forked from [`@oviato/x402-facilitator-hono`](https://github.com/OviatoHQ/x402-facilitator-hono) (Apache 2.0).

## What's different from upstream

Upstream is a generic mountable x402 facilitator. Stoa adds:

1. **Arc Testnet (CCTP V2 domain 26) as a supported chain.** Native USDC, USDC-gas — the standard x402 EVM scheme works once the chain config is registered.
2. **Splitter-routed settlement.** The `POST /settle` path can route the merchant's incoming payment through the [`Splitter`](../../contracts/src/Splitter.sol) contract on Arc, atomically distributing the payment across multiple recipients (operator, end-user, upstream contributor, etc.) in basis-point proportions. Verify, split, and settle are all one transaction.
3. **TracePin attestation hook.** Optional — on successful settlement, the facilitator can pin the off-chain payment-reasoning-trace hash via the [`TracePin`](../../contracts/src/TracePin.sol) contract so the merchant has on-chain commitment to whatever justification accompanied the payment (used by InsightAgent for its Polymarket recommendations).

The mounting, verify, and supported-chains paths remain upstream-compatible — any standard x402 client that targets a Stoa facilitator endpoint can pay without special knowledge of Splitter routing.

## Status

Forked from upstream `main` on 2026-05-14. Splitter routing is **not yet wired**; only the upstream codebase is in place. See parent `NOTES.md` for the active architecture decisions.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/supported` | Lists supported chains and signing schemes |
| `POST` | `/verify` | Validates a payment payload against requirements |
| `POST` | `/settle` | Settles on-chain (Stoa: routes through Splitter when configured) |

## License

Apache 2.0. See `LICENSE` (upstream) and `NOTICE.md` (fork attribution).
