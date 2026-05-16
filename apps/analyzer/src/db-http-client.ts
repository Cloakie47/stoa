/**
 * HTTP-backed DbClient. Implements bot-core's DbClient interface by POSTing
 * HMAC-signed envelopes to the Worker's /internal/db endpoint.
 *
 * Wire format mirrors apps/bot/src/internal.ts:
 *   POST {botInternalUrl}/internal/db
 *   { op: "<methodName>", args: [...] }
 *   → { ok: true, result: <method-return> } | { ok: false, error: "..." }
 *
 * Each method delegates to a single `call(op, args)` helper that handles the
 * signing + parsing. Argument and return types are checked against the
 * DbClient interface at the call sites below.
 */
import type {
  DbClient,
  InsertPreparedOrderRow,
  PreparedOrderRow,
  WalletRow,
} from "@stoa/bot-core";

import { signRequest } from "./hmac.js";

interface ResultEnvelope {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function httpDbClient(args: {
  botInternalUrl: string;
  hmacSecret: string;
}): DbClient {
  const url = `${args.botInternalUrl.replace(/\/$/, "")}/internal/db`;
  const secret = args.hmacSecret;

  async function call(op: string, methodArgs: unknown[]): Promise<unknown> {
    const body = JSON.stringify({ op, args: methodArgs });
    const sig = await signRequest(body, secret);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sig },
      body,
    });
    let env: ResultEnvelope;
    try {
      env = (await res.json()) as ResultEnvelope;
    } catch {
      throw new Error(
        `db proxy returned non-JSON HTTP ${res.status} for op=${op}`,
      );
    }
    if (!env.ok) {
      throw new Error(
        `db proxy op=${op} failed: ${env.error ?? "<no error>"} (HTTP ${res.status})`,
      );
    }
    return env.result ?? null;
  }

  return {
    getWallet: async (id) => (await call("getWallet", [id])) as WalletRow | null,
    insertWallet: async (id, address, ct) => {
      await call("insertWallet", [id, address, ct]);
    },
    insertPreparedOrder: async (row: InsertPreparedOrderRow) => {
      await call("insertPreparedOrder", [row]);
    },
    getPreparedOrder: async (orderId) =>
      (await call("getPreparedOrder", [orderId])) as PreparedOrderRow | null,
    markOrderConfirmed: async (orderId, tx, lmtsId) => {
      await call("markOrderConfirmed", [orderId, tx, lmtsId]);
    },
    logFeeChargeStart: async (uid, cmd, amount, related) =>
      (await call("logFeeChargeStart", [uid, cmd, amount, related])) as number,
    logFeeChargeMined: async (feeId, tx) => {
      await call("logFeeChargeMined", [feeId, tx]);
    },
    logFeeChargeFailed: async (feeId, msg) => {
      await call("logFeeChargeFailed", [feeId, msg]);
    },
    recordTracePin: async (uid, hash, tx, cid, url2, sig, conf, json) => {
      await call("recordTracePin", [
        uid,
        hash,
        tx,
        cid,
        url2,
        sig,
        conf,
        json,
      ]);
    },
  };
}
