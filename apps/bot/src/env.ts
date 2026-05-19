/**
 * Typed env binding for the Stoa bot.
 *
 * Wrangler injects bindings (D1) + vars + secrets into the Worker's env
 * argument. The shape below mirrors wrangler.toml's [vars] section plus the
 * documented secret names (set via `wrangler secret put NAME`).
 *
 * The bot-core library consumes a flat `BotCoreConfig` (no D1 binding); the
 * `toCfg(env)` helper below projects the Worker Env onto that shape.
 */
import type { BotCoreConfig } from "@stoa/bot-core";
import type { D1Database } from "@cloudflare/workers-types";

export interface Env {
  // D1 binding (Worker-only — not used by bot-core directly)
  DB: D1Database;

  // [vars] from wrangler.toml — non-secret
  ARC_TESTNET_RPC: string;
  ARC_CHAIN_ID: string;
  BASE_RPC: string;
  BASE_CHAIN_ID: string;
  ARC_USDC: string;
  STOA_SETTLER: string;
  STOA_SPLITTER: string;
  STOA_TRACEPIN: string;
  BASE_USDC: string;
  STOA_FEE_ANALYZE_USDC: string;
  STOA_FEE_CONFIRM_USDC: string;

  // Secrets — required
  TELEGRAM_BOT_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  WALLET_ENCRYPTION_KEY: string;
  OPERATOR_PRIVATE_KEY: string;
  STOA_RECIPIENT_OPERATOR: string;
  STOA_RECIPIENT_MAINTAINERS: string;
  STOA_RECIPIENT_CANTEEN: string;

  // Analyzer (Railway service) — Worker POSTs /jobs/* here when /analyze or
  // /confirm fires, and signs requests with ANALYZER_HMAC_SECRET. The
  // analyzer signs its /internal/db/* calls back to the Worker with the
  // same secret.
  ANALYZER_URL: string;
  ANALYZER_HMAC_SECRET: string;

  // Secrets — optional
  TELEGRAM_WEBHOOK_SECRET?: string;
  PINATA_JWT?: string;
  LIMITLESS_TOKEN_ID?: string;
  LIMITLESS_TOKEN_SECRET?: string;
  TEST_USER_TG_ID?: string;
  TEST_USER_PRIVATE_KEY?: string;

  // ── Fairblock StableTrust (experimental, default off) ────────────────────
  // The Worker reads STOA_USE_STABLETRUST + FAIRBLOCK_API_URL +
  // STABLETRUST_ARC_USDC_ADDRESS from [vars] in wrangler.toml.
  // STOA_OPERATOR_STABLETRUST_PRIVATE_KEY is an optional secret — when
  // unset, the V1 default derives the confidential receiver from
  // OPERATOR_PRIVATE_KEY. The Worker uses the flag to gate /shield,
  // /unshield, and /shielded-balance commands; the actual confidential
  // fee charging happens in the Railway analyzer.
  STOA_USE_STABLETRUST?: string;
  FAIRBLOCK_API_URL?: string;
  STABLETRUST_ARC_USDC_ADDRESS?: string;
  STOA_OPERATOR_STABLETRUST_PRIVATE_KEY?: string;
  /** Optional. Deployed StableTrust contract address override. Set when
   *  Fairblock has deployed StableTrust on chain ARC_CHAIN_ID but has not
   *  yet added it to their server-side registry. */
  STABLETRUST_ARC_CONTRACT_ADDRESS?: string;
}

/**
 * Project the Worker's typed Env onto the platform-agnostic BotCoreConfig
 * shape that bot-core consumes. Drops the D1 binding + the
 * analyzer-routing-only fields.
 */
export function toCfg(env: Env): BotCoreConfig {
  return {
    ARC_TESTNET_RPC: env.ARC_TESTNET_RPC,
    ARC_CHAIN_ID: env.ARC_CHAIN_ID,
    BASE_RPC: env.BASE_RPC,
    BASE_CHAIN_ID: env.BASE_CHAIN_ID,
    ARC_USDC: env.ARC_USDC,
    STOA_SETTLER: env.STOA_SETTLER,
    STOA_SPLITTER: env.STOA_SPLITTER,
    STOA_TRACEPIN: env.STOA_TRACEPIN,
    BASE_USDC: env.BASE_USDC,
    STOA_FEE_ANALYZE_USDC: env.STOA_FEE_ANALYZE_USDC,
    STOA_FEE_CONFIRM_USDC: env.STOA_FEE_CONFIRM_USDC,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    WALLET_ENCRYPTION_KEY: env.WALLET_ENCRYPTION_KEY,
    OPERATOR_PRIVATE_KEY: env.OPERATOR_PRIVATE_KEY,
    STOA_RECIPIENT_OPERATOR: env.STOA_RECIPIENT_OPERATOR,
    STOA_RECIPIENT_MAINTAINERS: env.STOA_RECIPIENT_MAINTAINERS,
    STOA_RECIPIENT_CANTEEN: env.STOA_RECIPIENT_CANTEEN,
    PINATA_JWT: env.PINATA_JWT,
    LIMITLESS_TOKEN_ID: env.LIMITLESS_TOKEN_ID,
    LIMITLESS_TOKEN_SECRET: env.LIMITLESS_TOKEN_SECRET,
    STOA_USE_STABLETRUST: /^(true|1|yes)$/i.test(
      (env.STOA_USE_STABLETRUST ?? "").trim(),
    ),
    FAIRBLOCK_API_URL:
      env.FAIRBLOCK_API_URL && env.FAIRBLOCK_API_URL.length > 0
        ? env.FAIRBLOCK_API_URL
        : "https://stabletrust-api.fairblock.network",
    STABLETRUST_ARC_USDC_ADDRESS:
      env.STABLETRUST_ARC_USDC_ADDRESS &&
      env.STABLETRUST_ARC_USDC_ADDRESS.length > 0
        ? env.STABLETRUST_ARC_USDC_ADDRESS
        : env.ARC_USDC,
    STOA_OPERATOR_STABLETRUST_PRIVATE_KEY:
      env.STOA_OPERATOR_STABLETRUST_PRIVATE_KEY,
    STABLETRUST_ARC_CONTRACT_ADDRESS:
      env.STABLETRUST_ARC_CONTRACT_ADDRESS &&
      env.STABLETRUST_ARC_CONTRACT_ADDRESS.length > 0
        ? env.STABLETRUST_ARC_CONTRACT_ADDRESS
        : undefined,
  };
}

export function feeAnalyzeMicros(env: Env): bigint {
  return BigInt(env.STOA_FEE_ANALYZE_USDC);
}
export function feeConfirmMicros(env: Env): bigint {
  return BigInt(env.STOA_FEE_CONFIRM_USDC);
}
