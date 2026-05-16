/**
 * D1-backed implementation of bot-core's `DbClient`. Thin adapter around the
 * existing query functions in `db.ts` — re-exposed as the platform-agnostic
 * interface so the simulator and any in-Worker code paths can drive bot-core
 * pipelines against D1 directly.
 *
 * The analyzer service (apps/analyzer) does NOT use this; it uses its own
 * HTTP-proxied DbClient that calls the /internal/db/* endpoints on the
 * Worker.
 */
import type {
  DbClient,
  InsertPreparedOrderRow,
  PreparedOrderRow,
  WalletRow,
} from "@stoa/bot-core";
import type { D1Database } from "@cloudflare/workers-types";

import {
  getPreparedOrder as _getPreparedOrder,
  getWallet as _getWallet,
  insertPreparedOrder as _insertPreparedOrder,
  insertWallet as _insertWallet,
  logFeeChargeFailed as _logFeeChargeFailed,
  logFeeChargeMined as _logFeeChargeMined,
  logFeeChargeStart as _logFeeChargeStart,
  markOrderConfirmed as _markOrderConfirmed,
  recordTracePin as _recordTracePin,
} from "./db.js";

export function d1DbClient(db: D1Database): DbClient {
  return {
    getWallet: (id) => _getWallet(db, id) as Promise<WalletRow | null>,
    insertWallet: (id, address, ct) => _insertWallet(db, id, address, ct),
    insertPreparedOrder: (row: InsertPreparedOrderRow) =>
      _insertPreparedOrder(db, row),
    getPreparedOrder: (orderId) =>
      _getPreparedOrder(db, orderId) as Promise<PreparedOrderRow | null>,
    markOrderConfirmed: (orderId, tx, lmtsId) =>
      _markOrderConfirmed(db, orderId, tx, lmtsId),
    logFeeChargeStart: (uid, cmd, amount, related) =>
      _logFeeChargeStart(db, uid, cmd, amount, related),
    logFeeChargeMined: (feeId, tx) => _logFeeChargeMined(db, feeId, tx),
    logFeeChargeFailed: (feeId, msg) => _logFeeChargeFailed(db, feeId, msg),
    recordTracePin: (uid, hash, tx, cid, url, sig, conf, json) =>
      _recordTracePin(db, uid, hash, tx, cid, url, sig, conf, json),
  };
}
