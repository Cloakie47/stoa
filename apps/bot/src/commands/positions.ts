/**
 * /positions — list the user's open + confirmed prepared orders from D1.
 *
 * v0 reads from D1 only (the prepared_orders table). When the Limitless
 * partner token arrives, this also queries `limitless-client.getOpenOrders`
 * to merge live order state with the D1 audit log.
 */
import { listOpenPreparedOrders, type Env } from "../db.js";
import type { D1Database } from "@cloudflare/workers-types";

export interface PositionsArgs {
  db: D1Database;
  env: Env;
  telegramUserId: number;
}

export interface PositionsResult {
  message: string;
  count: number;
}

export async function handlePositions(
  args: PositionsArgs,
): Promise<PositionsResult> {
  const { db, telegramUserId } = args;
  const rows = await listOpenPreparedOrders(db, telegramUserId);
  if (rows.length === 0) {
    return { message: `No open orders. Run /analyze on a market.`, count: 0 };
  }
  const lines = rows.map((r) => {
    const tag =
      r.signal === "YES" ? "📈 YES" :
      r.signal === "NO" ? "📉 NO" :
      "⏸ PASS";
    const statusEmoji = r.status === "confirmed" ? "✅" : "📋";
    const size = r.size ?? r.recommended_size_usdc ?? 0;
    const conf = r.confidence ? `${(r.confidence * 100).toFixed(0)}%` : "—";
    const orderRef = r.limitless_order_id
      ? `\n  Limitless: \`${r.limitless_order_id}\``
      : "";
    return (
      `${statusEmoji} \`${r.order_id.slice(0, 8)}\` ${tag} (conf ${conf})\n` +
      `  Market: ${r.market_question?.slice(0, 60) ?? r.market_url}\n` +
      `  Size: $${size.toFixed(2)}${orderRef}`
    );
  });
  return {
    message: `*Your positions (${rows.length})*\n\n${lines.join("\n\n")}`,
    count: rows.length,
  };
}
