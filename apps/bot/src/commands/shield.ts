/**
 * /shield <amount> — move USDC from the user's public Arc balance into their
 * confidential StableTrust balance. Once shielded, /analyze and /confirm
 * fees can be charged confidentially (when STOA_USE_STABLETRUST is on).
 *
 * Feature-gated. When the flag is off the command returns a "feature not
 * enabled" message and does NOT touch the StableTrust client.
 */
import { loadUserWallet, shieldDeposit } from "@stoa/bot-core";

import { d1DbClient } from "../d1-db-client.js";
import { toCfg, type Env } from "../env.js";
import type { D1Database } from "@cloudflare/workers-types";

export interface ShieldArgs {
  db: D1Database;
  env: Env;
  telegramUserId: number;
  amountUsdc: number;
}

export interface ShieldResult {
  message: string;
}

const FEATURE_DISABLED =
  "Confidential payments are not enabled in this build. Use standard /analyze.";

export async function handleShield(args: ShieldArgs): Promise<ShieldResult> {
  const { db, env, telegramUserId, amountUsdc } = args;
  const cfg = toCfg(env);

  if (!cfg.STOA_USE_STABLETRUST) {
    return { message: FEATURE_DISABLED };
  }

  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    return {
      message: "Usage: /shield <amount_usdc>. Example: /shield 5",
    };
  }

  const dbc = d1DbClient(db);
  const wallet = await loadUserWallet(dbc, cfg, telegramUserId);
  if (!wallet) {
    return { message: "No wallet — run /start first." };
  }

  const amountMicros = BigInt(Math.round(amountUsdc * 1_000_000));
  try {
    const res = await shieldDeposit({
      cfg,
      userPrivateKey: wallet.privateKey,
      amountMicros,
    });
    const txHash = res.tx;
    console.log(
      `[shield] user=${wallet.address} amount=$${amountUsdc.toFixed(2)} tx=${txHash} result=success`,
    );
    return {
      message:
        `✅ Shielded $${amountUsdc.toFixed(2)} USDC. Future /analyze and ` +
        `/confirm fees can now be charged confidentially.\n\n` +
        `Confidential tx: [${shortHash(txHash)}](https://testnet.arcscan.app/tx/${txHash})\n\n` +
        `Check your shielded balance: /shielded-balance`,
    };
  } catch (e) {
    const msg = (e as Error).message;
    console.log(
      `[shield] user=${wallet.address} amount=$${amountUsdc.toFixed(2)} result=failure error=${msg}`,
    );
    return {
      message:
        `❌ Couldn't shield: ${msg}\n\n` +
        `Your public USDC balance is unchanged. Try /shield again or use ` +
        `/balance to confirm your Arc USDC.`,
    };
  }
}

function shortHash(h: string): string {
  if (h.length < 12) return h;
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}
