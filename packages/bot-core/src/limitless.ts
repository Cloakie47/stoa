/**
 * Limitless trade execution — MOCKED in v0.
 *
 * The real implementation will call
 *   `client.delegatedOrders.createOrder({ marketSlug, orderType, onBehalfOf, args })`
 * via @stoa/limitless-client once the partner token is provisioned.
 *
 * For v0 the pipeline:
 *   1. Logs what the call WOULD have been.
 *   2. Returns a deterministic fake orderId of the form `LMTS-MOCK-<hex>`.
 *
 * When the partner token arrives, swap `placeMockOrder` for a real call.
 * Pipeline-code call-sites won't need to change.
 */
import type { BotCoreConfig } from "./config.js";

export interface MockOrderArgs {
  marketSlug: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  subAccountId?: number;
}

export interface MockOrderResult {
  orderId: string;
  mocked: true;
  args: MockOrderArgs;
  placedAt: string;
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function placeMockOrder(
  cfg: BotCoreConfig,
  args: MockOrderArgs,
): Promise<MockOrderResult> {
  void cfg; // kept in signature for symmetry with the real integration
  const orderId = `LMTS-MOCK-${randomId()}`;
  const placedAt = new Date().toISOString();
  console.log(
    `[limitless:mock] would place ${args.side} ${args.size} @ $${args.price} on ${args.marketSlug} (subAcct=${args.subAccountId ?? "—"}) → ${orderId}`,
  );
  return { orderId, mocked: true, args, placedAt };
}
