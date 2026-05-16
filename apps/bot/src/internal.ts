/**
 * HMAC-authed internal HTTP API. The Railway analyzer service calls these
 * routes to perform D1 reads/writes during the long-running /analyze and
 * /confirm pipelines.
 *
 * Wire format: POST /internal/db { op: "<methodName>", args: [...] }
 *
 * The single-endpoint dispatch keeps the surface tiny — adding a new
 * DbClient method only requires extending the switch in `handleDbOp` rather
 * than registering a new route.
 *
 * Authentication: every request must carry valid `X-Stoa-Timestamp` and
 * `X-Stoa-Signature` headers signed with `ANALYZER_HMAC_SECRET`. Replays
 * outside ±5 minutes are rejected.
 */
import type { DbClient } from "@stoa/bot-core";

import { d1DbClient } from "./d1-db-client.js";
import type { Env } from "./env.js";
import { verifyRequest } from "./hmac.js";

type DbOp =
  | "getWallet"
  | "insertWallet"
  | "insertPreparedOrder"
  | "getPreparedOrder"
  | "markOrderConfirmed"
  | "logFeeChargeStart"
  | "logFeeChargeMined"
  | "logFeeChargeFailed"
  | "recordTracePin";

interface DbCallEnvelope {
  op: DbOp;
  args: unknown[];
}

/**
 * Dispatch a parsed DbCallEnvelope to the D1-backed DbClient. Returns the
 * result (possibly null/undefined) — caller serializes it as JSON.
 */
async function handleDbOp(db: DbClient, env: DbCallEnvelope): Promise<unknown> {
  const { op, args } = env;
  switch (op) {
    case "getWallet":
      return db.getWallet(args[0] as number);
    case "insertWallet":
      return db.insertWallet(
        args[0] as number,
        args[1] as string,
        args[2] as string,
      );
    case "insertPreparedOrder":
      return db.insertPreparedOrder(args[0] as Parameters<DbClient["insertPreparedOrder"]>[0]);
    case "getPreparedOrder":
      return db.getPreparedOrder(args[0] as string);
    case "markOrderConfirmed":
      return db.markOrderConfirmed(
        args[0] as string,
        args[1] as string,
        args[2] as string,
      );
    case "logFeeChargeStart":
      return db.logFeeChargeStart(
        args[0] as number,
        args[1] as "analyze" | "confirm",
        args[2] as number,
        args[3] as string | null,
      );
    case "logFeeChargeMined":
      return db.logFeeChargeMined(args[0] as number, args[1] as string);
    case "logFeeChargeFailed":
      return db.logFeeChargeFailed(args[0] as number, args[1] as string);
    case "recordTracePin":
      return db.recordTracePin(
        args[0] as number,
        args[1] as string,
        args[2] as string,
        args[3] as string | null,
        args[4] as string,
        args[5] as string | null,
        args[6] as number | null,
        args[7] as string,
      );
    default: {
      const _exhaustive: never = op;
      void _exhaustive;
      throw new Error(`Unknown DB op: ${String(op)}`);
    }
  }
}

/**
 * Handle a POST /internal/db request. Verifies HMAC, dispatches the op,
 * returns the JSON-encoded result.
 */
export async function handleInternalDb(
  req: Request,
  env: Env,
): Promise<Response> {
  const body = await req.text();
  try {
    await verifyRequest({
      body,
      timestamp: req.headers.get("X-Stoa-Timestamp"),
      signature: req.headers.get("X-Stoa-Signature"),
      secret: env.ANALYZER_HMAC_SECRET,
    });
  } catch (e) {
    return new Response(`unauthorized: ${(e as Error).message}`, {
      status: 401,
    });
  }

  let parsed: DbCallEnvelope;
  try {
    parsed = JSON.parse(body) as DbCallEnvelope;
  } catch {
    return new Response("bad request: invalid JSON", { status: 400 });
  }

  const db = d1DbClient(env.DB);
  try {
    const result = await handleDbOp(db, parsed);
    return Response.json({ ok: true, result: result ?? null });
  } catch (e) {
    console.error(
      `[internal.db] op=${parsed.op} failed: ${(e as Error).message}`,
    );
    return Response.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
