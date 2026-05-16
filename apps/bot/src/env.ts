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
  };
}

export function feeAnalyzeMicros(env: Env): bigint {
  return BigInt(env.STOA_FEE_ANALYZE_USDC);
}
export function feeConfirmMicros(env: Env): bigint {
  return BigInt(env.STOA_FEE_CONFIRM_USDC);
}
