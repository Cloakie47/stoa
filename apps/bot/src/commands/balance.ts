/**
 * /balance — show USDC on Base + Arc, plus a count of open prepared orders.
 *
 * Both balance reads are real on-chain calls. Positions count is from D1.
 */
import { loadUserWallet, readUsdcBalanceArc, readUsdcBalanceBase } from "@stoa/bot-core";

import { d1DbClient } from "../d1-db-client.js";
import { listOpenPreparedOrders } from "../db.js";
import { toCfg, type Env } from "../env.js";
import type { D1Database } from "@cloudflare/workers-types";

export interface BalanceArgs {
  db: D1Database;
  env: Env;
  telegramUserId: number;
}

export interface BalanceResult {
  message: string;
  address: string;
  base_micros: bigint;
  arc_micros: bigint;
  open_orders: number;
}

export async function handleBalance(args: BalanceArgs): Promise<BalanceResult> {
  const { db, env, telegramUserId } = args;
  const cfg = toCfg(env);
  const dbc = d1DbClient(db);
  const wallet = await loadUserWallet(dbc, cfg, telegramUserId);
  if (!wallet) throw new Error("No wallet — run /start first.");

  const [base, arc, openOrders] = await Promise.all([
    readUsdcBalanceBase(cfg, wallet.address).catch(() => 0n),
    readUsdcBalanceArc(cfg, wallet.address).catch(() => 0n),
    listOpenPreparedOrders(db, telegramUserId),
  ]);

  const fmt = (m: bigint) => (Number(m) / 1_000_000).toFixed(4);
  const message =
    `*Balances*\n` +
    `\`${wallet.address}\`\n\n` +
    `Base USDC (trading): ${fmt(base)}\n` +
    `Arc Testnet USDC (fees): ${fmt(arc)}\n\n` +
    `*Open prepared orders:* ${openOrders.length}\n` +
    (openOrders.length > 0
      ? `Run /positions to list them.`
      : `Run /preview or /analyze on a market URL to start.`);

  return {
    message,
    address: wallet.address,
    base_micros: base,
    arc_micros: arc,
    open_orders: openOrders.length,
  };
}
