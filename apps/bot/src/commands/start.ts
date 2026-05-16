/**
 * /start — bootstrap a user. Generates an EOA, encrypts it, stores in D1,
 * returns funding address + disclosure.
 *
 * Idempotent — re-running /start re-sends the funding info but does NOT
 * regenerate the wallet (we never want to overwrite an existing key).
 */
import {
  getOrCreateUserWallet,
  readUsdcBalanceArc,
  readUsdcBalanceBase,
} from "@stoa/bot-core";

import { d1DbClient } from "../d1-db-client.js";
import { markDisclosureAccepted, upsertUser } from "../db.js";
import { toCfg, type Env } from "../env.js";
import type { D1Database } from "@cloudflare/workers-types";

export interface StartArgs {
  db: D1Database;
  env: Env;
  telegramUserId: number;
  telegramUsername: string | null;
}

export interface StartResult {
  message: string;
  address: string;
  arcUsdcMicros: bigint;
  baseUsdcMicros: bigint;
  isNew: boolean;
}

const DISCLOSURE = `
⚠️  *Read before funding* — Stoa v0 custody disclosure

This bot generates a wallet for you and keeps the private key encrypted in
its database. We pay gas to submit your trades; you authorize each payment
via a signature this bot holds on your behalf.

What this means:
• We can move your funds. We won't, but the trust model is custodial.
• Use small amounts. This is a hackathon bot, not a production exchange.
• /withdraw <address> <amount> works any time — your funds are not locked.
• Stoa fees ($0.10 /analyze + $0.20 /confirm) are *non-refundable* in v0.

By using /analyze or /confirm you accept the above.
`.trim();

export async function handleStart(args: StartArgs): Promise<StartResult> {
  const { db, env, telegramUserId, telegramUsername } = args;
  const cfg = toCfg(env);
  const dbc = d1DbClient(db);

  await upsertUser(db, telegramUserId, telegramUsername);

  const isNew =
    (await db
      .prepare("SELECT 1 FROM wallets WHERE telegram_user_id = ?")
      .bind(telegramUserId)
      .first()) === null;

  const wallet = await getOrCreateUserWallet(dbc, cfg, telegramUserId);
  await markDisclosureAccepted(db, telegramUserId);

  const [arcBal, baseBal] = await Promise.all([
    readUsdcBalanceArc(cfg, wallet.address).catch(() => 0n),
    readUsdcBalanceBase(cfg, wallet.address).catch(() => 0n),
  ]);

  const fmt = (m: bigint) => (Number(m) / 1_000_000).toFixed(4);
  const intro = isNew
    ? `Welcome to Stoa. Wallet created.`
    : `Welcome back. Your wallet is ready.`;

  const message =
    `${intro}\n\n` +
    `Your address (same on both chains):\n\`${wallet.address}\`\n\n` +
    `*Balances*\n` +
    `• Arc Testnet USDC (Stoa fees): ${fmt(arcBal)}\n` +
    `• Base USDC (trading): ${fmt(baseBal)}\n\n` +
    `*Funding instructions*\n` +
    `1. For analysis fees: send USDC to your address on Arc Testnet (chain id 5042002).\n` +
    `2. For trading: send USDC to your address on Base (chain id 8453).\n\n` +
    DISCLOSURE;

  return {
    message,
    address: wallet.address,
    arcUsdcMicros: arcBal,
    baseUsdcMicros: baseBal,
    isNew,
  };
}
