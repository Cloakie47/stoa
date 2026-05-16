/**
 * D1 query helpers. Thin wrappers around `env.DB.prepare(...)` so that
 * command handlers don't repeat SQL inline.
 */
import type { D1Database } from "@cloudflare/workers-types";

import type { Env } from "./env.js";

export interface UserRow {
  telegram_user_id: number;
  telegram_username: string | null;
  created_at: string;
  disclosure_accepted_at: string | null;
}

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

export interface FeeChargeRow {
  id: number;
  telegram_user_id: number;
  command: string;
  related_order_id: string | null;
  amount_usdc_micro: number;
  tx_hash: string | null;
  status: string;
  error_msg: string | null;
  created_at: string;
  mined_at: string | null;
}

// ── Users + wallets ─────────────────────────────────────────────────────────

export async function getUser(
  db: D1Database,
  telegramUserId: number,
): Promise<UserRow | null> {
  return (
    await db
      .prepare("SELECT * FROM users WHERE telegram_user_id = ?")
      .bind(telegramUserId)
      .first<UserRow>()
  ) ?? null;
}

export async function upsertUser(
  db: D1Database,
  telegramUserId: number,
  telegramUsername: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (telegram_user_id, telegram_username)
       VALUES (?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET
         telegram_username = excluded.telegram_username`,
    )
    .bind(telegramUserId, telegramUsername)
    .run();
}

export async function markDisclosureAccepted(
  db: D1Database,
  telegramUserId: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE users SET disclosure_accepted_at = datetime('now') WHERE telegram_user_id = ?",
    )
    .bind(telegramUserId)
    .run();
}

export async function getWallet(
  db: D1Database,
  telegramUserId: number,
): Promise<WalletRow | null> {
  return (
    await db
      .prepare("SELECT * FROM wallets WHERE telegram_user_id = ?")
      .bind(telegramUserId)
      .first<WalletRow>()
  ) ?? null;
}

export async function insertWallet(
  db: D1Database,
  telegramUserId: number,
  address: string,
  pkCiphertextB64: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO wallets (telegram_user_id, address, pk_ciphertext_b64)
       VALUES (?, ?, ?)`,
    )
    .bind(telegramUserId, address, pkCiphertextB64)
    .run();
}

// ── Prepared orders ─────────────────────────────────────────────────────────

export async function insertPreparedOrder(
  db: D1Database,
  row: Pick<
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
  >,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO prepared_orders
       (order_id, telegram_user_id, market_url, market_slug, market_question,
        token_id, side, price, size, recommended_size_usdc,
        signal, confidence, trace_hash, ipfs_cid, pinned_tx, analyze_settle_tx)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.order_id,
      row.telegram_user_id,
      row.market_url,
      row.market_slug,
      row.market_question,
      row.token_id,
      row.side,
      row.price,
      row.size,
      row.recommended_size_usdc,
      row.signal,
      row.confidence,
      row.trace_hash,
      row.ipfs_cid,
      row.pinned_tx,
      row.analyze_settle_tx,
    )
    .run();
}

export async function getPreparedOrder(
  db: D1Database,
  orderId: string,
): Promise<PreparedOrderRow | null> {
  return (
    await db
      .prepare("SELECT * FROM prepared_orders WHERE order_id = ?")
      .bind(orderId)
      .first<PreparedOrderRow>()
  ) ?? null;
}

export async function listOpenPreparedOrders(
  db: D1Database,
  telegramUserId: number,
): Promise<PreparedOrderRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM prepared_orders
       WHERE telegram_user_id = ? AND status IN ('prepared', 'confirmed')
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .bind(telegramUserId)
    .all<PreparedOrderRow>();
  return res.results;
}

export async function markOrderConfirmed(
  db: D1Database,
  orderId: string,
  confirmSettleTx: string,
  limitlessOrderId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE prepared_orders
       SET status = 'confirmed',
           confirm_settle_tx = ?,
           limitless_order_id = ?,
           confirmed_at = datetime('now')
       WHERE order_id = ?`,
    )
    .bind(confirmSettleTx, limitlessOrderId, orderId)
    .run();
}

// ── Fee charges audit log ──────────────────────────────────────────────────

export async function logFeeChargeStart(
  db: D1Database,
  telegramUserId: number,
  command: "analyze" | "confirm",
  amountUsdcMicro: number,
  relatedOrderId: string | null,
): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO fee_charges (telegram_user_id, command, related_order_id, amount_usdc_micro)
       VALUES (?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(telegramUserId, command, relatedOrderId, amountUsdcMicro)
    .first<{ id: number }>();
  if (!r) throw new Error("logFeeChargeStart: no id returned");
  return r.id;
}

export async function logFeeChargeMined(
  db: D1Database,
  feeId: number,
  txHash: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE fee_charges
       SET tx_hash = ?, status = 'mined', mined_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(txHash, feeId)
    .run();
}

export async function logFeeChargeFailed(
  db: D1Database,
  feeId: number,
  errorMsg: string,
): Promise<void> {
  await db
    .prepare(`UPDATE fee_charges SET status = 'failed', error_msg = ? WHERE id = ?`)
    .bind(errorMsg.slice(0, 1000), feeId)
    .run();
}

// ── Trace pins ─────────────────────────────────────────────────────────────

export async function recordTracePin(
  db: D1Database,
  telegramUserId: number,
  traceHash: string,
  arcTxHash: string,
  ipfsCid: string | null,
  marketUrl: string,
  signal: string | null,
  confidence: number | null,
  fullTraceJson: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO trace_pins
       (trace_hash, telegram_user_id, ipfs_cid, arc_tx_hash, market_url,
        signal, confidence, full_trace_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      traceHash,
      telegramUserId,
      ipfsCid,
      arcTxHash,
      marketUrl,
      signal,
      confidence,
      fullTraceJson,
    )
    .run();
}

// ── Withdrawals ────────────────────────────────────────────────────────────

export async function logWithdrawalStart(
  db: D1Database,
  telegramUserId: number,
  toAddress: string,
  amountUsdcMicro: number,
  chain: "base" | "arc-testnet",
): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO withdrawals (telegram_user_id, to_address, amount_usdc_micro, chain)
       VALUES (?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(telegramUserId, toAddress, amountUsdcMicro, chain)
    .first<{ id: number }>();
  if (!r) throw new Error("logWithdrawalStart: no id returned");
  return r.id;
}

export async function logWithdrawalMined(
  db: D1Database,
  withdrawalId: number,
  txHash: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE withdrawals SET status = 'mined', tx_hash = ? WHERE id = ?`,
    )
    .bind(txHash, withdrawalId)
    .run();
}

export async function logWithdrawalFailed(
  db: D1Database,
  withdrawalId: number,
  errorMsg: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE withdrawals SET status = 'failed', error_msg = ? WHERE id = ?`,
    )
    .bind(errorMsg.slice(0, 1000), withdrawalId)
    .run();
}

// Re-export for convenience
export type { Env };
