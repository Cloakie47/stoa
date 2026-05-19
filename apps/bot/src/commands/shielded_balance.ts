/**
 * /shielded-balance — read the user's confidential StableTrust balance.
 *
 * Feature-gated. When STOA_USE_STABLETRUST is false, returns a "feature
 * not enabled" message.
 */
import { loadUserWallet, shieldedBalanceOf } from "@stoa/bot-core";

import { d1DbClient } from "../d1-db-client.js";
import { toCfg, type Env } from "../env.js";
import type { D1Database } from "@cloudflare/workers-types";

export interface ShieldedBalanceArgs {
  db: D1Database;
  env: Env;
  telegramUserId: number;
}

export interface ShieldedBalanceResult {
  message: string;
}

const FEATURE_DISABLED =
  "Confidential payments are not enabled in this build. Use standard /analyze.";

export async function handleShieldedBalance(
  args: ShieldedBalanceArgs,
): Promise<ShieldedBalanceResult> {
  const { db, env, telegramUserId } = args;
  const cfg = toCfg(env);

  if (!cfg.STOA_USE_STABLETRUST) {
    return { message: FEATURE_DISABLED };
  }

  const dbc = d1DbClient(db);
  const wallet = await loadUserWallet(dbc, cfg, telegramUserId);
  if (!wallet) {
    return { message: "No wallet — run /start first." };
  }

  try {
    const bal = await shieldedBalanceOf({
      cfg,
      userPrivateKey: wallet.privateKey,
    });
    const fmt = (s: string) => {
      const n = Number(BigInt(s)) / 1_000_000;
      return n.toFixed(4);
    };
    return {
      message:
        `*Your confidential balance*\n` +
        `\`${wallet.address}\`\n\n` +
        `  Total:     $${fmt(bal.balance.total)}\n` +
        `  Available: $${fmt(bal.balance.available)}\n` +
        `  Pending:   $${fmt(bal.balance.pending)}\n\n` +
        `_Available balance is what /analyze and /confirm draw from._`,
    };
  } catch (e) {
    const msg = (e as Error).message;
    if (/uninit|not.*initial|no.*account/i.test(msg)) {
      return {
        message:
          "You haven't shielded any USDC yet. Use /shield <amount> to enable confidential payments.",
      };
    }
    return {
      message: `❌ Couldn't read shielded balance: ${msg}\n\nFairblock API may be temporarily unavailable. Try again in a moment.`,
    };
  }
}
