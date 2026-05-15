/**
 * Polymarket smoke test — operator-gated.
 *
 * What this script does:
 *   1. Loads .env (DEPLOYER_PRIVATE_KEY for signing, POLY_BUILDER_CODE for
 *      revenue attribution).
 *   2. Resolves the Figure F.03 robots market URL (same sub-market that the
 *      insight-engine agent analyzed and pinned to Arc).
 *   3. Builds a $1 LIMIT BUY order at 5¢ BELOW the current best bid on the
 *      YES side, so the order sits in the book without filling.
 *   4. Prints the full prepared order struct + EIP-712 typed data for human
 *      review.
 *   5. STOPS. It does NOT auto-submit. The operator reviews, then if approved,
 *      separately calls submitOrder() with the prepared bundle.
 *
 * Run:
 *   pnpm --filter @stoa/polymarket-client smoke:prepare
 *
 * Or directly:
 *   tsx scripts/smoke-test-polymarket.ts
 *
 * Required env vars (in repo-root .env):
 *   DEPLOYER_PRIVATE_KEY   — 0x-prefixed hex (will be the EOA signer)
 *   POLY_BUILDER_CODE      — 32-byte hex (your builder attribution code)
 *   POLYGON_RPC            — optional, defaults to a public Polygon RPC
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StoaPolymarketClient } from "../src/index.js";

const FIGURE_F03_URL =
  "https://polymarket.com/event/of-packages-pushed-by-figures-f03-robots-by-may-21-10-pm-et";

// ── Boot: load .env from repo root ──────────────────────────────────────────

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");
loadDotenv(resolve(repoRoot, ".env"));

function loadDotenv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.warn(`[smoke] No .env at ${path}; relying on shell env.`);
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (key && val && !process.env[key]) {
      process.env[key] = val;
    }
  }
}

// ── Smoke test body ─────────────────────────────────────────────────────────

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  const builderCode = process.env.POLY_BUILDER_CODE;
  if (!pk) {
    fail("DEPLOYER_PRIVATE_KEY missing from .env — required to construct the signer.");
  }
  if (!builderCode) {
    console.warn(
      "[smoke] POLY_BUILDER_CODE missing — orders will have empty builder field (no fee attribution). Continuing for the smoke test, but production must set this.",
    );
  }

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║       Stoa × Polymarket smoke test — PREPARE ONLY            ║");
  console.log("║       (this script DOES NOT submit anything)                  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const client = new StoaPolymarketClient({
    privateKey: pk as `0x${string}`,
    builderCode,
    polygonRpcUrl: process.env.POLYGON_RPC,
  });

  console.log(`Signer address: ${client.signerAddress}`);
  console.log(`Funder address: ${client.funderAddress}`);
  console.log(`Signature type: EOA (0) — smoke-test mode`);
  console.log(`Builder code:   ${builderCode ?? "(none)"}\n`);

  console.log(`Resolving market: ${FIGURE_F03_URL}`);
  const market = await client.getMarket(FIGURE_F03_URL);
  console.log(`\n── Market ───────────────────────────────────────────────────`);
  console.log(`Question:     ${market.question}`);
  console.log(`Slug:         ${market.slug}`);
  console.log(`conditionId:  ${market.conditionId}`);
  console.log(`outcomes:     ${market.outcomes.join(", ")}`);
  console.log(`tickSize:     ${market.tickSize}`);
  console.log(`negRisk:      ${market.negRisk}`);
  console.log(`YES token id: ${market.tokenIds.yes}`);
  console.log(`NO  token id: ${market.tokenIds.no}`);
  console.log(`YES orderbook: best_bid=${market.yesOrderbook.bestBid}  best_ask=${market.yesOrderbook.bestAsk}  mid=${market.yesOrderbook.mid}`);
  console.log(`  top bids: ${JSON.stringify(market.yesOrderbook.topBids)}`);
  console.log(`  top asks: ${JSON.stringify(market.yesOrderbook.topAsks)}`);

  const bestBid = market.yesOrderbook.bestBid;
  if (bestBid === undefined) {
    fail(
      "YES orderbook has no bids — cannot price the smoke test order 5¢ below best bid.",
    );
  }

  // Compute a limit price 5¢ below best bid, rounded DOWN to the market's tick.
  const targetPrice = bestBid - 0.05;
  const tickFloat = Number.parseFloat(market.tickSize);
  if (!Number.isFinite(tickFloat) || tickFloat <= 0) {
    fail(`Unexpected tickSize: ${market.tickSize}`);
  }
  const tickDecimals = decimalsFromTick(market.tickSize);
  const limitPrice = Math.max(
    tickFloat,
    Math.floor(targetPrice / tickFloat) * tickFloat,
  );
  const roundedPrice = Number(limitPrice.toFixed(tickDecimals));

  // Order size: $1 / limit_price = shares to request (since size is in
  // conditional tokens, and 1 token = $1 if it resolves true).
  const size = Number((1 / roundedPrice).toFixed(2));

  console.log(`\n── Order parameters ────────────────────────────────────────`);
  console.log(`Side:         BUY`);
  console.log(`Token (YES):  ${market.tokenIds.yes}`);
  console.log(`Limit price:  $${roundedPrice}  (best bid $${bestBid} − $0.05 → ${targetPrice}, floor to tick ${market.tickSize})`);
  console.log(`Size:         ${size} shares  (= $1 notional at $${roundedPrice})`);
  console.log(`Expected:     order sits in book (won't fill since price < best bid)`);

  const prepared = await client.prepareOrder({
    tokenId: market.tokenIds.yes!,
    side: "BUY",
    price: roundedPrice,
    size,
    tickSize: market.tickSize,
    negRisk: market.negRisk,
  });

  console.log(`\n── Prepared order summary ─────────────────────────────────`);
  for (const [k, v] of Object.entries(prepared.summary)) {
    console.log(`  ${String(k).padEnd(22)} ${String(v)}`);
  }

  console.log(`\n── Raw signed order struct ────────────────────────────────`);
  console.log(JSON.stringify(prepared.signedOrder, null, 2));

  console.log(`\n── EIP-712 typed data (this is what got signed) ───────────`);
  console.log(JSON.stringify(prepared.typedData, null, 2));

  const submit = process.argv.includes("--submit");
  if (!submit) {
    console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║  REVIEW THE ABOVE CAREFULLY. The order is SIGNED but NOT     ║`);
    console.log(`║  POSTED. Re-run with --submit to actually post to CLOB, OR   ║`);
    console.log(`║  call client.submitOrder(prepared) from your own script.     ║`);
    console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
    return;
  }

  // ── --submit branch ──────────────────────────────────────────────────────

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║   --submit FLAG SET — posting to Polymarket CLOB now         ║`);
  console.log(`║   This is a REAL submission on Polygon mainnet.              ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  console.log("[smoke] Calling submitOrder(prepared)...");
  const { orderId, raw } = await client.submitOrder(prepared);
  console.log(`[smoke] ✓ orderId: ${orderId}`);
  console.log(`[smoke] raw CLOB response: ${JSON.stringify(raw, null, 2)}\n`);

  console.log(`[smoke] Querying getOpenOrders({ market: ${market.conditionId} })...`);
  const openOrders = await client.getOpenOrders({ market: market.conditionId });
  console.log(`[smoke] ✓ ${openOrders.length} open order(s) for this market:`);
  for (const o of openOrders) {
    console.log(JSON.stringify(o, null, 2));
  }

  // Polymarket UI URL (the operator wants to see this in the live book).
  const uiMarketUrl = `https://polymarket.com/market/${market.slug}`;
  console.log(`\n── Polymarket UI ──────────────────────────────────────────────`);
  console.log(`Market page:    ${uiMarketUrl}`);
  console.log(`Original event: ${FIGURE_F03_URL}`);
  console.log(`\nNote: CLOB orders do NOT post on-chain at submission. There is no`);
  console.log(`Polygonscan tx hash for the submission itself — only later if it`);
  console.log(`matches and settles. The orderId above is the off-chain CLOB ID.`);
  console.log(`\n[smoke] Order submitted and visible. Not cancelling.`);
}

function decimalsFromTick(tick: string): number {
  // "0.01" → 2, "0.0001" → 4
  const idx = tick.indexOf(".");
  return idx === -1 ? 0 : tick.length - idx - 1;
}

function fail(msg: string): never {
  console.error(`[smoke] FATAL: ${msg}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("\n[smoke] Unhandled error:", err);
  process.exit(1);
});
