/**
 * Storage abstraction used by bot-core. The Worker (apps/bot) provides a D1
 * implementation; the analyzer (apps/analyzer) provides an HTTP-proxy
 * implementation that calls back into the Worker's /internal endpoints.
 *
 * All shapes mirror the D1 schema in `apps/bot/migrations/0001_init.sql`.
 * Keeping them flat + JSON-serializable so the HTTP-proxy path can wire-
 * format them without bespoke marshalling.
 */

export interface WalletRow {
  telegram_user_id: number;
  address: string;
  pk_ciphertext_b64: string;
  created_at: string;
}

export interface PreparedOrderRow {
  order_id: string;
  telegram_user_id: number;
  market_url: string;
  market_slug: string | null;
  market_question: string | null;
  token_id: string | null;
  side: string | null;
  price: number | null;
  size: number | null;
  recommended_size_usdc: number | null;
  signal: string | null;
  confidence: number | null;
  trace_hash: string | null;
  ipfs_cid: string | null;
  pinned_tx: string | null;
  analyze_settle_tx: string | null;
  confirm_settle_tx: string | null;
  limitless_order_id: string | null;
  status: string;
  created_at: string;
  confirmed_at: string | null;
}

export type InsertPreparedOrderRow = Pick<
  PreparedOrderRow,
  | "order_id"
  | "telegram_user_id"
  | "market_url"
  | "market_slug"
  | "market_question"
  | "token_id"
  | "side"
  | "price"
  | "size"
  | "recommended_size_usdc"
  | "signal"
  | "confidence"
  | "trace_hash"
  | "ipfs_cid"
  | "pinned_tx"
  | "analyze_settle_tx"
>;

/**
 * Minimum surface bot-core needs to run /analyze and /confirm pipelines.
 *
 * Methods that mutate are fire-and-forget (return void). Methods that read
 * return the row or null. Errors throw — callers handle them at the pipeline
 * boundary, where they convert into Telegram error messages.
 */
export interface DbClient {
  // Wallets
  getWallet(telegramUserId: number): Promise<WalletRow | null>;
  insertWallet(
    telegramUserId: number,
    address: string,
    pkCiphertextB64: string,
  ): Promise<void>;

  // Prepared orders
  insertPreparedOrder(row: InsertPreparedOrderRow): Promise<void>;
  getPreparedOrder(orderId: string): Promise<PreparedOrderRow | null>;
  markOrderConfirmed(
    orderId: string,
    confirmSettleTx: string,
    limitlessOrderId: string,
  ): Promise<void>;

  // Fee charges (audit log for $0.10 / $0.20 micropayments)
  logFeeChargeStart(
    telegramUserId: number,
    command: "analyze" | "confirm",
    amountUsdcMicro: number,
    relatedOrderId: string | null,
  ): Promise<number>;
  logFeeChargeMined(feeId: number, txHash: string): Promise<void>;
  logFeeChargeFailed(feeId: number, errorMsg: string): Promise<void>;

  // Trace pins
  recordTracePin(
    telegramUserId: number,
    traceHash: string,
    arcTxHash: string,
    ipfsCid: string | null,
    marketUrl: string,
    signal: string | null,
    confidence: number | null,
    fullTraceJson: string,
  ): Promise<void>;
}
