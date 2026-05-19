/**
 * Platform-agnostic runtime config for the Stoa bot's business logic. The
 * Worker (apps/bot) and the analyzer (apps/analyzer) both build this struct
 * from their respective env sources (Wrangler bindings vs process.env) and
 * pass it to every bot-core function that needs network/key access.
 *
 * Intentionally a flat record of primitives — no D1 binding, no
 * runtime-specific objects — so the same code runs unchanged in Workers and
 * Node.
 */

export interface BotCoreConfig {
  // Chain RPCs + IDs
  ARC_TESTNET_RPC: string;
  ARC_CHAIN_ID: string;
  BASE_RPC: string;
  BASE_CHAIN_ID: string;

  // Contract addresses
  ARC_USDC: string;
  STOA_SETTLER: string;
  STOA_SPLITTER: string;
  STOA_TRACEPIN: string;
  BASE_USDC: string;

  // Fee amounts in USDC base units (6 decimals)
  STOA_FEE_ANALYZE_USDC: string; // "150000" = $0.15
  STOA_FEE_CONFIRM_USDC: string; // "200000" = $0.20

  // Secrets
  TELEGRAM_BOT_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  WALLET_ENCRYPTION_KEY: string;
  OPERATOR_PRIVATE_KEY: string;
  STOA_RECIPIENT_OPERATOR: string;
  STOA_RECIPIENT_MAINTAINERS: string;
  STOA_RECIPIENT_CANTEEN: string;

  // Optional
  PINATA_JWT?: string;
  LIMITLESS_TOKEN_ID?: string;
  LIMITLESS_TOKEN_SECRET?: string;

  // Fairblock StableTrust confidential payments (experimental, default off).
  // When STOA_USE_STABLETRUST is false, every code path that touches the
  // StableTrust client is unreachable — the bot behaves exactly like the
  // production public-flow baseline. When true, /analyze + /confirm prefer
  // confidential transfers (user → operator) and decouple the TracePin
  // event into a separate operator-signed Arc tx; the 70/20/10 split is
  // skipped in V1 (operator holds the shielded balance, splits batched
  // post-flow).
  STOA_USE_STABLETRUST: boolean;
  FAIRBLOCK_API_URL: string;
  STABLETRUST_ARC_USDC_ADDRESS: string;
  /** Optional. When set, used as the confidential receiver for /analyze
   *  + /confirm fees. When unset, the receiver address is derived from
   *  OPERATOR_PRIVATE_KEY — V1 default. */
  STOA_OPERATOR_STABLETRUST_PRIVATE_KEY?: string;
}

export function feeAnalyzeMicros(cfg: BotCoreConfig): bigint {
  return BigInt(cfg.STOA_FEE_ANALYZE_USDC);
}

export function feeConfirmMicros(cfg: BotCoreConfig): bigint {
  return BigInt(cfg.STOA_FEE_CONFIRM_USDC);
}
