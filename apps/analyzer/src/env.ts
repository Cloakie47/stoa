/**
 * Typed env loader. Reads from process.env (Railway injects vars from the
 * service's environment settings).
 *
 * Build a BotCoreConfig from env at process start; reject early if a required
 * secret is missing so the service doesn't half-start.
 */
import type { BotCoreConfig } from "@stoa/bot-core";

export interface AnalyzerEnv {
  PORT: number;
  HOST: string;

  // Auth / routing
  BOT_INTERNAL_URL: string; // Worker URL, e.g. https://stoa-bot.stoa-build.workers.dev
  ANALYZER_HMAC_SECRET: string;

  // BotCoreConfig fields (the analyzer uses bot-core just like the Worker)
  cfg: BotCoreConfig;
}

function readRequired(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(
      `[analyzer] missing required env var: ${name}. Set it in Railway dashboard or your local .env.`,
    );
  }
  return v;
}

function readOptional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function loadEnv(): AnalyzerEnv {
  const cfg: BotCoreConfig = {
    ARC_TESTNET_RPC: process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.network",
    ARC_CHAIN_ID: process.env.ARC_CHAIN_ID ?? "5042002",
    BASE_RPC: process.env.BASE_RPC ?? "https://mainnet.base.org",
    BASE_CHAIN_ID: process.env.BASE_CHAIN_ID ?? "8453",
    ARC_USDC: process.env.ARC_USDC ?? "0x3600000000000000000000000000000000000000",
    STOA_SETTLER: readRequired("STOA_SETTLER"),
    STOA_SPLITTER: readRequired("STOA_SPLITTER"),
    STOA_TRACEPIN: readRequired("STOA_TRACEPIN"),
    BASE_USDC: process.env.BASE_USDC ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    STOA_FEE_ANALYZE_USDC: process.env.STOA_FEE_ANALYZE_USDC ?? "150000",
    STOA_FEE_CONFIRM_USDC: process.env.STOA_FEE_CONFIRM_USDC ?? "200000",
    TELEGRAM_BOT_TOKEN: readRequired("TELEGRAM_BOT_TOKEN"),
    ANTHROPIC_API_KEY: readRequired("ANTHROPIC_API_KEY"),
    WALLET_ENCRYPTION_KEY: readRequired("WALLET_ENCRYPTION_KEY"),
    OPERATOR_PRIVATE_KEY: readRequired("OPERATOR_PRIVATE_KEY"),
    STOA_RECIPIENT_OPERATOR: readRequired("STOA_RECIPIENT_OPERATOR"),
    STOA_RECIPIENT_MAINTAINERS: readRequired("STOA_RECIPIENT_MAINTAINERS"),
    STOA_RECIPIENT_CANTEEN: readRequired("STOA_RECIPIENT_CANTEEN"),
    PINATA_JWT: readOptional("PINATA_JWT"),
    LIMITLESS_TOKEN_ID: readOptional("LIMITLESS_TOKEN_ID"),
    LIMITLESS_TOKEN_SECRET: readOptional("LIMITLESS_TOKEN_SECRET"),
  };

  return {
    PORT: Number.parseInt(process.env.PORT ?? "3000", 10),
    HOST: process.env.HOST ?? "0.0.0.0",
    BOT_INTERNAL_URL: readRequired("BOT_INTERNAL_URL"),
    ANALYZER_HMAC_SECRET: readRequired("ANALYZER_HMAC_SECRET"),
    cfg,
  };
}
