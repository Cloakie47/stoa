/**
 * /unshield <amount> — withdraw from the user's confidential StableTrust
 * balance back to their public Arc USDC balance.
 *
 * Feature-gated. When STOA_USE_STABLETRUST is false, returns a "feature
 * not enabled" message.
 */
import {
  loadUserWallet,
  shieldWithdraw,
  shieldedBalanceOf,
} from "@stoa/bot-core";

import { d1DbClient } from "../d1-db-client.js";
import { toCfg, type Env } from "../env.js";
import type { D1Database } from "@cloudflare/workers-types";

export interface UnshieldArgs {
  db: D1Database;
  env: Env;
  telegramUserId: number;
  amountUsdc: number;
}

export interface UnshieldResult {
  message: string;
}

const FEATURE_DISABLED =
  "Confidential payments are not enabled in this build. Use standard /analyze.";

export async function handleUnshield(
  args: UnshieldArgs,
): Promise<UnshieldResult> {
  const { db, env, telegramUserId, amountUsdc } = args;
  const cfg = toCfg(env);

  if (!cfg.STOA_USE_STABLETRUST) {
    return { message: FEATURE_DISABLED };
  }

  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    return {
      message: "Usage: /unshield <amount_usdc>. Example: /unshield 2",
    };
  }

  const dbc = d1DbClient(db);
  const wallet = await loadUserWallet(dbc, cfg, telegramUserId);
  if (!wallet) {
    return { message: "No wallet — run /start first." };
  }

  // Pre-flight balance check so we give a precise error message when
  // available < requested, instead of a raw API error string.
  const amountMicros = BigInt(Math.round(amountUsdc * 1_000_000));
  try {
    const bal = await shieldedBalanceOf({
      cfg,
      userPrivateKey: wallet.privateKey,
    });
    const availableMicros = BigInt(bal.balance.available);
    if (availableMicros < amountMicros) {
      const availUsd = (Number(availableMicros) / 1e6).toFixed(2);
      return {
        message: `Your shielded balance is only $${availUsd}. Try /unshield ${availUsd} or less.`,
      };
    }
  } catch {
    // Skip the pre-check on lookup failure; the withdraw call itself will
    // surface a useful error.
  }

  try {
    const res = await shieldWithdraw({
      cfg,
      userPrivateKey: wallet.privateKey,
      amountMicros,
    });
    const txHash = res.tx;
    console.log(
      `[unshield] user=${wallet.address} amount=$${amountUsdc.toFixed(2)} tx=${txHash} result=success`,
    );
    return {
      message:
        `✅ Unshielded $${amountUsdc.toFixed(2)} USDC back to your public wallet.\n\n` +
        `Arc tx: [${shortHash(txHash)}](https://testnet.arcscan.app/tx/${txHash})`,
    };
  } catch (e) {
    const msg = (e as Error).message;
    console.log(
      `[unshield] user=${wallet.address} amount=$${amountUsdc.toFixed(2)} result=failure error=${msg}`,
    );
    return {
      message:
        `❌ Couldn't unshield: ${msg}\n\n` +
        `Your shielded balance is unchanged. Run /shielded-balance to see what's available.`,
    };
  }
}

function shortHash(h: string): string {
  if (h.length < 12) return h;
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}
