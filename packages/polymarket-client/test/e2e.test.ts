/**
 * Live integration test against real Polymarket CLOB.
 *
 * Gating: auto-skips unless RUN_E2E_POLY=1 is set AND DEPLOYER_PRIVATE_KEY
 * is present in env. The test does NOT post any order — it only verifies
 * the read path (getMarket) and the prepare path (prepareOrder builds +
 * signs without submitting). Submitting a real order is operator-gated;
 * see scripts/smoke-test-polymarket.ts and exercise that manually.
 *
 * Costs: $0 in gas (no submission). $0 in LLM (this package makes no LLM
 * calls).
 *
 * Run:
 *   RUN_E2E_POLY=1 pnpm test test/e2e.test.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { StoaPolymarketClient } from "../src/index.js";

const repoEnv = (() => {
  try {
    const raw = readFileSync(resolve(__dirname, "../../../.env"), "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1];
      const val = m[2];
      if (key && val) out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
})();
for (const [k, v] of Object.entries(repoEnv)) {
  if (!process.env[k]) process.env[k] = v;
}

const PK = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined;
const RUN_E2E = process.env.RUN_E2E_POLY === "1";
const skip = !RUN_E2E || !PK;

const FIGURE_F03 =
  "https://polymarket.com/event/of-packages-pushed-by-figures-f03-robots-by-may-21-10-pm-et";

describe.skipIf(skip)("StoaPolymarketClient — live Polymarket integration", () => {
  it(
    "resolves the Figure F03 event URL and reads market data",
    async () => {
      const client = new StoaPolymarketClient({
        privateKey: PK!,
        builderCode: process.env.POLY_BUILDER_CODE,
        polygonRpcUrl: process.env.POLYGON_RPC,
      });
      const market = await client.getMarket(FIGURE_F03);
      expect(market.conditionId).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(market.tokenIds.yes).toBeTruthy();
      expect(market.tokenIds.no).toBeTruthy();
      expect(["0.1", "0.01", "0.001", "0.0001"]).toContain(market.tickSize);
      expect(market.yesOrderbook.bestBid).toBeGreaterThan(0);
      expect(market.yesOrderbook.bestAsk).toBeLessThan(1);
      console.log(
        `[e2e-poly] Resolved: ${market.question} — tick=${market.tickSize}, negRisk=${market.negRisk}, YES_bid=${market.yesOrderbook.bestBid}, YES_ask=${market.yesOrderbook.bestAsk}`,
      );
    },
    60_000,
  );

  it(
    "prepares an order WITHOUT submitting (build + sign only)",
    async () => {
      const client = new StoaPolymarketClient({
        privateKey: PK!,
        builderCode: process.env.POLY_BUILDER_CODE,
        polygonRpcUrl: process.env.POLYGON_RPC,
      });
      const market = await client.getMarket(FIGURE_F03);
      const bestBid = market.yesOrderbook.bestBid;
      if (bestBid === undefined) {
        throw new Error("No best bid on YES side — cannot prepare order.");
      }
      // 5¢ below best bid, floored to the market's tick.
      const tickFloat = Number.parseFloat(market.tickSize);
      const priceFloat = Math.max(
        tickFloat,
        Math.floor((bestBid - 0.05) / tickFloat) * tickFloat,
      );
      const tickDecimals = market.tickSize.split(".")[1]?.length ?? 0;
      const price = Number(priceFloat.toFixed(tickDecimals));
      const size = Number((1 / price).toFixed(2));

      const prepared = await client.prepareOrder({
        tokenId: market.tokenIds.yes!,
        side: "BUY",
        price,
        size,
        tickSize: market.tickSize,
        negRisk: market.negRisk,
      });
      expect(prepared.signedOrder).toBeDefined();
      expect(prepared.summary.full_signature).toMatch(/^0x[0-9a-fA-F]+/);
      expect(prepared.typedData.primaryType).toBe("Order");
      console.log(
        `[e2e-poly] Prepared order at $${price} × ${size} — signed but NOT submitted.`,
      );
    },
    60_000,
  );
});
