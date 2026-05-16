/**
 * /withdraw <to_address> <amount_usdc> — transfer USDC from the user's
 * Base wallet to a specified address.
 *
 * The user's bot-managed wallet on Base pays gas (Base mainnet uses ETH).
 * v0 known limitation: the user must have a small ETH balance on Base
 * to use /withdraw. A future "USDC-only" UX would use Circle Paymaster.
 */
import {
  loadUserWallet,
  readUsdcBalanceBase,
  withdrawUsdcOnBase,
} from "@stoa/bot-core";

import { d1DbClient } from "../d1-db-client.js";
import {
  logWithdrawalFailed,
  logWithdrawalMined,
  logWithdrawalStart,
} from "../db.js";
import { toCfg, type Env } from "../env.js";
import type { D1Database } from "@cloudflare/workers-types";
import type { Address, Hex } from "viem";
import { isAddress } from "viem";

export interface WithdrawArgs {
  db: D1Database;
  env: Env;
  telegramUserId: number;
  toAddress: string;
  amountUsdc: number;
}

export interface WithdrawResult {
  message: string;
  tx_hash: string;
  basescan_url: string;
}

export async function handleWithdraw(args: WithdrawArgs): Promise<WithdrawResult> {
  const { db, env, telegramUserId, toAddress, amountUsdc } = args;
  if (!isAddress(toAddress)) {
    throw new Error(`Invalid recipient address: ${toAddress}`);
  }
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    throw new Error(`Amount must be > 0 USDC, got ${amountUsdc}`);
  }
  const amountMicros = BigInt(Math.round(amountUsdc * 1_000_000));

  const cfg = toCfg(env);
  const dbc = d1DbClient(db);
  const wallet = await loadUserWallet(dbc, cfg, telegramUserId);
  if (!wallet) throw new Error("No wallet — run /start first.");

  const bal = await readUsdcBalanceBase(cfg, wallet.address);
  if (bal < amountMicros) {
    throw new Error(
      `Insufficient Base USDC. Have ${Number(bal) / 1e6}, requested ${amountUsdc}.`,
    );
  }

  const id = await logWithdrawalStart(
    db,
    telegramUserId,
    toAddress,
    Number(amountMicros),
    "base",
  );
  let txHash: Hex;
  try {
    txHash = await withdrawUsdcOnBase({
      cfg,
      userPrivateKey: wallet.privateKey,
      to: toAddress as Address,
      amountMicros,
    });
    await logWithdrawalMined(db, id, txHash);
  } catch (e) {
    await logWithdrawalFailed(db, id, (e as Error).message);
    throw e;
  }

  const message =
    `*Withdrawal sent*\n` +
    `${amountUsdc} USDC → \`${toAddress}\`\n\n` +
    `Base tx: [${txHash.slice(0, 10)}…](https://basescan.org/tx/${txHash})`;

  return {
    message,
    tx_hash: txHash,
    basescan_url: `https://basescan.org/tx/${txHash}`,
  };
}
