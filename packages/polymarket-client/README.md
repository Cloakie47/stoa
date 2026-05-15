# @stoa/polymarket-client

Thin TypeScript wrapper around [`@polymarket/clob-client-v2`](https://www.npmjs.com/package/@polymarket/clob-client-v2). Exposes a stable surface for InsightAgent's order-placement layer and isolates the smoke-test "prepare but don't submit" path from real submission.

## Public API

```ts
import { StoaPolymarketClient } from "@stoa/polymarket-client";

const client = new StoaPolymarketClient({
  privateKey: process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`,
  builderCode: process.env.POLY_BUILDER_CODE,         // bytes32 hex
  polygonRpcUrl: process.env.POLYGON_RPC,             // optional
  // signatureType: SignatureTypeV2.EOA,              // default — smoke-test path
  // signatureType: SignatureTypeV2.POLY_1271,        // production — deposit-wallet path
});

const market = await client.getMarket(
  "https://polymarket.com/event/of-packages-pushed-by-figures-f03-robots-by-may-21-10-pm-et",
);
//   ↑ resolves the URL through Gamma, picks highest-volume sub-market for /event/ URLs,
//     and returns conditionId + tokenIds + tickSize + negRisk + orderbook snapshots.

const prepared = await client.prepareOrder({
  tokenId: market.tokenIds.yes!,
  side: "BUY",
  price: 0.30,                           // limit price (must respect tickSize)
  size: 3.33,                            // shares (1 share = $1 if it resolves true)
  tickSize: market.tickSize,
  negRisk: market.negRisk,
});
//   ↑ Builds + signs the order. Does NOT submit. Returns:
//     - prepared.signedOrder    — feeds directly into submitOrder()
//     - prepared.typedData      — reconstructed EIP-712 for human review
//     - prepared.summary        — printable summary with signature placeholder

// ... operator reviews `prepared.summary` and `prepared.typedData` ...

const { orderId } = await client.submitOrder(prepared);
//   ↑ Calls postOrder on the L2-authed client. Auto-provisions API creds
//     via createOrDeriveApiKey() on first use.

const trades = await client.getBuilderTrades({ after: new Date("2026-05-15") });
//   ↑ All trades attributed to the configured builderCode. Stoa's revenue feed.

await client.cancelOrder(orderId);
//   ↑ Cancels a previously-posted order.
```

## Signature modes

| Mode | Const | When |
|---|---|---|
| EOA | `SignatureTypeV2.EOA` (0) | Smoke test, manual signing, single-user demos. Funder = signer address. |
| POLY_1271 | `SignatureTypeV2.POLY_1271` (3) | **Production InsightAgent**: bot owns a smart-contract deposit wallet that validates orders via ERC-1271. Funder = the deposit-wallet address. |

The current Phase 4 smoke test uses **EOA** for simplicity. Phase 5 (autonomous bot) switches to **POLY_1271** once the deposit-wallet factory is wired.

## Smoke test

`scripts/smoke-test-polymarket.ts` resolves the same Figure F.03 market the insight-engine agent analyzed, builds a $1 limit order at 5¢ below best bid, and prints the full order struct + EIP-712 typed data. **It does not submit.**

```bash
pnpm --filter @stoa/polymarket-client smoke:prepare
```

The operator inspects the output, confirms the field values match expectations, and only then calls `submitOrder(prepared)` from a follow-up script.

## Testing

```bash
pnpm test                                # 10 mocked unit tests (no IO)
RUN_E2E_POLY=1 pnpm test test/e2e.test.ts   # live read + prepare against real Polymarket (no submission)
```

The integration test does NOT post orders. Submission is operator-only.

## Required env vars

| Var | Purpose | Required? |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | EOA signer | **Yes** for any non-mocked usage |
| `POLY_BUILDER_CODE` | Fee attribution | Strongly recommended (orders without it earn nothing) |
| `POLYGON_RPC` | Polygon RPC URL | Optional (defaults to viem's public transport) |
