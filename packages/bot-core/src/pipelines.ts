/**
 * Long-running pipelines invoked by the Railway analyzer. Each pipeline
 * takes the user job payload + a DbClient + a BotCoreConfig, runs the full
 * flow (Stoa atomic split + optional analysis + trace pin + mocked Limitless
 * trade), and sends the result back to the user via direct Telegram API call.
 *
 * Failures inside the pipeline produce an error follow-up message tagged
 * with the same request ID so the user always hears back exactly once.
 *
 * These are the lift-and-shift replacements for what used to be
 * `handleAnalyze`/`handleConfirm` inside the Worker — same content, but the
 * DB access goes through `DbClient` (D1 directly when called from the bot's
 * simulator; HTTP-proxied via /internal endpoints when called from the
 * Railway analyzer service).
 */
import {
  fetchMarketContext,
  NoAnalyzableSubMarketError,
} from "@stoa/insight-engine";
import type {
  FullTrace,
  JudgeTrace,
  MarketContext,
  SubMarketSelection,
} from "@stoa/insight-engine";

import type { BotCoreConfig } from "./config.js";
import { feeAnalyzeMicros, feeConfirmMicros } from "./config.js";
import type { DbClient } from "./db-client.js";
import { runFullAnalysis } from "./insight.js";
import { placeMockOrder } from "./limitless.js";
import {
  computeSplitLegs,
  confidentialSplitRecipients,
  pinTraceFromOperator,
  sendLegWithRetry,
  shieldedBalanceOf,
  type SplitLegResult,
} from "./stabletrust.js";
import { payStoaFee } from "./stoa.js";
import { sendTelegramMessage } from "./telegram.js";
import {
  loadUserWallet,
  readUsdcBalanceArc,
  readUsdcBalanceBase,
} from "./wallet.js";
import type { Address, Hex } from "viem";

function shortHash(h: string): string {
  if (h.length < 12) return h;
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

// ── Fee charging — public vs shielded ────────────────────────────────────────
//
// chargeAnalyzeFee + chargeConfirmFee are the single chokepoint where we
// decide whether to (a) charge via the existing StoaSettler atomic flow
// (public, current production behavior, never changes) or (b) charge
// confidentially via Fairblock StableTrust when the operator has flipped
// STOA_USE_STABLETRUST=true AND the user has enough shielded balance.
//
// In shielded mode the TracePin event is DECOUPLED from the user's
// payment — operator emits TracePin in a separate tx, signed by the
// operator key, so the user's confidential transfer is not attributable
// to any specific analysis. The 70/20/10 split is SKIPPED in V1 shielded
// mode; the operator's StableTrust balance accumulates the fees and the
// split is performed manually post-flow.
//
// On any shielded-flow problem (Fairblock unreachable, circuit breaker
// open, insufficient shielded balance), the code FALLS THROUGH to the
// public flow — the user gets a normal /analyze with the public footer
// and a public 70/20/10 split, no error surfaced. Only a hard failure of
// the public flow itself surfaces an error to the user.

interface ChargeResult {
  mode: "public" | "shielded";
  /** User-side payment tx hash. In public mode this is the StoaSettler
   *  settle() tx (which also pinned the trace atomically). In shielded
   *  mode this is the FIRST successful split leg's tx (operator's 70%). */
  user_tx: Hex;
  /** Operator-signed TracePin tx in shielded mode (the trace pin is split
   *  off from the user payment to break the on-chain correlation). Null
   *  in public mode because settle() pins the trace atomically. */
  trace_pin_tx: Hex | null;
  amount_micros: bigint;
  /** Per-leg detail for the V1 3-way confidential split. Undefined in
   *  public mode (StoaSettler does the split atomically on-chain).
   *  Always 3 entries in shielded mode, even if some legs failed. */
  splits?: SplitLegResult[];
}

async function chargeAnalyzeFee(args: {
  cfg: BotCoreConfig;
  db: DbClient;
  wallet: { address: Address; privateKey: Hex };
  feeMicros: bigint;
  traceHash: Hex;
  ipfsCid: string;
  telegramUserId: number;
  requestId: string;
  paymentMode?: "public" | "shielded";
}): Promise<ChargeResult> {
  const {
    cfg,
    db,
    wallet,
    feeMicros,
    traceHash,
    ipfsCid,
    telegramUserId,
    requestId,
    paymentMode,
  } = args;
  const feeUsd = Number(feeMicros) / 1e6;

  // Shielded only when (flag on AND user did not explicitly pick public).
  const tryShielded =
    cfg.STOA_USE_STABLETRUST && paymentMode !== "public";

  if (tryShielded) {
    const shielded = await trySplitShielded({
      cfg,
      db,
      wallet,
      feeMicros,
      kind: "analyze",
      orderId: null,
      traceHash,
      ipfsCid,
      telegramUserId,
      requestId,
    });
    if (shielded) return shielded;
    // Falls through to public on any error / insufficient balance / leg failure.
  }

  // ── Public flow — current production behavior, unchanged ────────────────
  const feeId = await db.logFeeChargeStart(
    telegramUserId,
    "analyze",
    Number(feeMicros),
    null,
  );
  let txHash: Hex;
  try {
    txHash = await payStoaFee({
      cfg,
      userPrivateKey: wallet.privateKey,
      userAddress: wallet.address,
      amountUsdcMicros: feeMicros,
      traceHash,
      ipfsCid,
    });
    await db.logFeeChargeMined(feeId, txHash);
  } catch (e) {
    await db.logFeeChargeFailed(feeId, (e as Error).message);
    throw e;
  }
  console.log(
    `[stabletrust] mode=public user=${wallet.address} fee=$${feeUsd.toFixed(2)} ` +
      `settle_tx=${txHash} request=${requestId}`,
  );
  return {
    mode: "public",
    user_tx: txHash,
    trace_pin_tx: null,
    amount_micros: feeMicros,
  };
}

/**
 * Attempt the shielded 3-way split. Returns a ChargeResult on full success
 * (all 3 legs succeeded) or `null` to signal the caller should fall through
 * to public flow. Never throws — every failure mode (insufficient balance,
 * Fairblock unreachable, leg failure) returns null with a structured log.
 *
 * Fall-through policy (V1): if ANY of the 3 legs fails after retries, fall
 * through to public flow for THIS analyze so the user is unblocked.
 * Successful legs LEAVE their funds with the corresponding recipient —
 * V1 does not refund partial-success legs. Operator reconciles manually
 * post-flow. V2 will add automatic refund-and-retry.
 */
async function trySplitShielded(args: {
  cfg: BotCoreConfig;
  db: DbClient;
  wallet: { address: Address; privateKey: Hex };
  feeMicros: bigint;
  kind: "analyze" | "confirm";
  orderId: string | null;
  traceHash?: Hex;
  ipfsCid?: string;
  telegramUserId: number;
  requestId: string;
}): Promise<ChargeResult | null> {
  const { cfg, db, wallet, feeMicros, kind, orderId, telegramUserId, requestId } =
    args;
  const feeUsd = Number(feeMicros) / 1e6;

  // ── Pre-flight: shielded balance must cover the full fee ────────────────
  let availableMicros: bigint;
  try {
    const bal = await shieldedBalanceOf({
      cfg,
      userPrivateKey: wallet.privateKey,
    });
    availableMicros = BigInt(bal.balance.available);
  } catch (err) {
    console.log(
      `[stabletrust] mode=public user=${wallet.address} fee=$${feeUsd.toFixed(2)} ` +
        `reason=stabletrust_balance_error error=${(err as Error).message} request=${requestId}`,
    );
    return null;
  }
  if (availableMicros < feeMicros) {
    console.log(
      `[stabletrust] mode=public user=${wallet.address} fee=$${feeUsd.toFixed(2)} ` +
        `reason=insufficient_shielded_balance shielded_available=$${(Number(availableMicros) / 1e6).toFixed(2)} ` +
        `request=${requestId}`,
    );
    return null;
  }

  // ── Compute the 3-way split + log fee start ─────────────────────────────
  const recipients = confidentialSplitRecipients(cfg);
  const legs = computeSplitLegs(feeMicros, recipients);
  const feeId = await db.logFeeChargeStart(
    telegramUserId,
    kind,
    Number(feeMicros),
    orderId,
  );

  // ── Operator-signed TracePin tx (analyze only) — decoupled from payment ─
  let pinTx: Hex | null = null;
  if (kind === "analyze") {
    try {
      pinTx = await pinTraceFromOperator({
        cfg,
        traceHash: args.traceHash!,
        ipfsCid: args.ipfsCid!,
      });
    } catch (err) {
      await db.logFeeChargeFailed(feeId, (err as Error).message);
      console.log(
        `[stabletrust] mode=public user=${wallet.address} fee=$${feeUsd.toFixed(2)} ` +
          `reason=tracepin_failed error=${(err as Error).message} request=${requestId}`,
      );
      return null;
    }
  }

  // ── Three parallel confidential transfers with per-leg retry ────────────
  const settled = await Promise.allSettled(
    legs.map((leg) =>
      sendLegWithRetry({
        cfg,
        userPrivateKey: wallet.privateKey,
        leg,
      }),
    ),
  );

  const splits: SplitLegResult[] = legs.map((leg, i) => {
    const r = settled[i]!;
    if (r.status === "fulfilled") {
      return {
        recipient: leg.recipient,
        amount_micros: leg.amount_micros,
        tx_hash: r.value,
        ok: true,
      };
    }
    return {
      recipient: leg.recipient,
      amount_micros: leg.amount_micros,
      tx_hash: null,
      ok: false,
    };
  });

  const failedLegs = splits.filter((s) => !s.ok);
  if (failedLegs.length > 0) {
    // V1 policy: any leg failure → fall through to public flow. Successful
    // legs are NOT refunded; operator reconciles manually post-flow.
    await db.logFeeChargeFailed(
      feeId,
      `shielded ${failedLegs.length}/3 legs failed; falling through to public`,
    );
    const failedDescriptions = splits
      .map((s, i) =>
        `${["operator", "maintainers", "canteen"][i]}=${s.ok ? "ok" : "FAIL"}`,
      )
      .join(" ");
    console.warn(
      `[stabletrust] mode=public user=${wallet.address} fee=$${feeUsd.toFixed(2)} ` +
        `reason=shielded_partial_failure legs=[${failedDescriptions}] request=${requestId}`,
    );
    return null;
  }

  // All 3 legs succeeded.
  const operatorTx = splits[0]!.tx_hash as Hex;
  await db.logFeeChargeMined(feeId, operatorTx);
  console.log(
    `[stabletrust] mode=shielded user=${wallet.address} fee=$${feeUsd.toFixed(2)} ` +
      `shielded_before=$${(Number(availableMicros) / 1e6).toFixed(2)} ` +
      `shielded_after=$${(Number(availableMicros - feeMicros) / 1e6).toFixed(2)} ` +
      `op_tx=${operatorTx} maint_tx=${splits[1]!.tx_hash} canteen_tx=${splits[2]!.tx_hash} ` +
      `trace_pin_tx=${pinTx ?? "n/a"} request=${requestId}`,
  );
  return {
    mode: "shielded",
    user_tx: operatorTx,
    trace_pin_tx: pinTx,
    amount_micros: feeMicros,
    splits,
  };
}

async function chargeConfirmFee(args: {
  cfg: BotCoreConfig;
  db: DbClient;
  wallet: { address: Address; privateKey: Hex };
  feeMicros: bigint;
  orderId: string;
  telegramUserId: number;
  requestId: string;
  paymentMode?: "public" | "shielded";
}): Promise<ChargeResult> {
  const {
    cfg,
    db,
    wallet,
    feeMicros,
    orderId,
    telegramUserId,
    requestId,
    paymentMode,
  } = args;
  const feeUsd = Number(feeMicros) / 1e6;

  const tryShielded =
    cfg.STOA_USE_STABLETRUST && paymentMode !== "public";

  if (tryShielded) {
    const shielded = await trySplitShielded({
      cfg,
      db,
      wallet,
      feeMicros,
      kind: "confirm",
      orderId,
      telegramUserId,
      requestId,
    });
    if (shielded) return shielded;
    // Falls through on any error / insufficient balance / leg failure.
  }

  // Public flow
  const feeId = await db.logFeeChargeStart(
    telegramUserId,
    "confirm",
    Number(feeMicros),
    orderId,
  );
  let txHash: Hex;
  try {
    txHash = await payStoaFee({
      cfg,
      userPrivateKey: wallet.privateKey,
      userAddress: wallet.address,
      amountUsdcMicros: feeMicros,
    });
    await db.logFeeChargeMined(feeId, txHash);
  } catch (e) {
    await db.logFeeChargeFailed(feeId, (e as Error).message);
    throw e;
  }
  console.log(
    `[stabletrust] mode=public user=${wallet.address} fee=$${feeUsd.toFixed(2)} ` +
      `settle_tx=${txHash} request=${requestId}`,
  );
  return {
    mode: "public",
    user_tx: txHash,
    trace_pin_tx: null,
    amount_micros: feeMicros,
  };
}

// ── /analyze pipeline ────────────────────────────────────────────────────────

export interface AnalyzePipelineArgs {
  cfg: BotCoreConfig;
  db: DbClient;
  chatId: number;
  telegramUserId: number;
  marketUrl: string;
  requestId: string;
  /** Optional payment-mode override from the bot's inline keyboard.
   *  When undefined, falls back to the cfg-default behavior (attempt
   *  shielded if STOA_USE_STABLETRUST and balance covers fee, else public).
   *  When "public", skip the shielded attempt entirely.
   *  When "shielded", attempt shielded even if balance is short (still
   *  falls through to public on insufficient-balance). */
  paymentMode?: "public" | "shielded";
}

export interface AnalyzePipelineResult {
  order_id: string;
  trace_hash: string;
  ipfs_cid: string | null;
  analyze_settle_tx: string;
  signal: string;
  recommended_size_usdc: number;
  confidence: number;
}

/**
 * Full /analyze flow:
 *   1. Load wallet + check Arc USDC balance
 *   2. Read Base USDC balance for Kelly sizing bankroll
 *   3. Run insight-engine multi-agent analysis
 *   4. Pay $0.15 Stoa fee atomically (split + trace pin)
 *   5. Persist prepared order + trace pin row
 *   6. DM the user with the Kelly-sized recommendation + confirm button text
 */
export async function runAnalyzePipeline(
  args: AnalyzePipelineArgs,
): Promise<AnalyzePipelineResult | null> {
  const { cfg, db, chatId, telegramUserId, marketUrl, requestId } = args;
  try {
    const wallet = await loadUserWallet(db, cfg, telegramUserId);
    if (!wallet) {
      throw new Error("No wallet for this user — run /start first.");
    }

    const feeMicros = feeAnalyzeMicros(cfg);
    const arcBal = await readUsdcBalanceArc(cfg, wallet.address);
    if (arcBal < feeMicros) {
      throw new Error(
        `Insufficient Arc USDC. Have ${Number(arcBal) / 1e6}, need ${Number(feeMicros) / 1e6}. Send USDC to ${wallet.address} on Arc Testnet (chain 5042002).`,
      );
    }

    // Bankroll for Kelly sizing: use max(Arc, Base) — a user funded only on
    // Arc shouldn't get silently sized to 0 because their Base balance is 0.
    // The actual trade venue is Base (Limitless), but with Limitless mocked
    // in v0 the recommendation is hackathon-side anyway.
    const arcBalUsd = Number(arcBal) / 1_000_000;
    const baseBalUsd = await readUsdcBalanceBase(cfg, wallet.address)
      .then((b) => Number(b) / 1_000_000)
      .catch(() => 0);
    const bankrollUsd = Math.max(arcBalUsd, baseBalUsd);
    console.log(
      `[analyze:${requestId}] arc=$${arcBalUsd.toFixed(2)} base=$${baseBalUsd.toFixed(2)} bankroll=$${bankrollUsd.toFixed(2)}`,
    );

    // ── Pre-flight context resolution ──────────────────────────────────────
    // Fetch the MarketContext BEFORE the Stoa fee charge so we can refuse
    // gracefully (and return no-charge) when an event URL has no analyzable
    // sub-markets. The insight-engine throws NoAnalyzableSubMarketError in
    // that case — we catch it here, send the refuse message, and exit.
    let context: MarketContext;
    try {
      context = await fetchMarketContext(marketUrl);
    } catch (e) {
      if (e instanceof NoAnalyzableSubMarketError) {
        const message = formatNoAnalyzableSubMarketMessage(e.selection, requestId);
        await sendTelegramMessage(cfg.TELEGRAM_BOT_TOKEN, chatId, message);
        console.log(
          `[runAnalyzePipeline] req=${requestId} refused — no analyzable sub-markets (${e.selection.totalSubMarkets} total, ${e.selection.extremeCount} extreme). No fee charged.`,
        );
        return null;
      }
      throw e;
    }

    const analysis = await runFullAnalysis(cfg, marketUrl, bankrollUsd, context);

    const charge = await chargeAnalyzeFee({
      cfg,
      db,
      wallet,
      feeMicros,
      traceHash: analysis.trace_hash,
      ipfsCid: analysis.ipfs_cid ?? "",
      telegramUserId,
      requestId,
      paymentMode: args.paymentMode,
    });
    // Pin tx for the proof block is operator's TracePin in shielded mode,
    // settle() in public mode — both emit the TracePinned event.
    const pinnedTx: Hex = charge.trace_pin_tx ?? charge.user_tx;

    const order_id = crypto.randomUUID();
    const judge = analysis.trace.judge_trace;
    await db.insertPreparedOrder({
      order_id,
      telegram_user_id: telegramUserId,
      market_url: marketUrl,
      market_slug: analysis.trace.market_question?.slice(0, 80) ?? null,
      market_question: analysis.trace.market_question,
      token_id: null,
      side: judge.signal === "PASS" ? null : "BUY",
      price: null,
      size: null,
      recommended_size_usdc: judge.recommended_size_usdc,
      signal: judge.signal,
      confidence: judge.confidence,
      trace_hash: analysis.trace_hash,
      ipfs_cid: analysis.ipfs_cid,
      pinned_tx: pinnedTx,
      analyze_settle_tx: charge.user_tx,
    });
    await db.recordTracePin(
      telegramUserId,
      analysis.trace_hash,
      pinnedTx,
      analysis.ipfs_cid,
      marketUrl,
      judge.signal,
      judge.confidence,
      JSON.stringify(analysis.trace),
    );

    const message = formatAnalyzeMessage({
      trace: analysis.trace,
      charge,
      ipfsCid: analysis.ipfs_cid,
      orderId: order_id,
      bankrollUsd,
      requestId,
    });
    await sendTelegramMessage(cfg.TELEGRAM_BOT_TOKEN, chatId, message);

    return {
      order_id,
      trace_hash: analysis.trace_hash,
      ipfs_cid: analysis.ipfs_cid,
      analyze_settle_tx: charge.user_tx,
      signal: judge.signal,
      recommended_size_usdc: judge.recommended_size_usdc,
      confidence: judge.confidence,
    };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error(`[runAnalyzePipeline] req=${requestId} failed: ${msg}`);
    await sendTelegramMessage(
      cfg.TELEGRAM_BOT_TOKEN,
      chatId,
      `❌ /analyze failed (request \`${requestId}\`): ${msg}\n\nTry again — if this keeps happening, check /balance and confirm you have ≥ $0.15 USDC on Arc Testnet.`,
    );
    return null;
  }
}

// ── /confirm pipeline ────────────────────────────────────────────────────────

export interface ConfirmPipelineArgs {
  cfg: BotCoreConfig;
  db: DbClient;
  chatId: number;
  telegramUserId: number;
  orderId: string;
  requestId: string;
}

export interface ConfirmPipelineResult {
  order_id: string;
  confirm_settle_tx: string;
  limitless_order_id: string;
}

/**
 * Full /confirm flow:
 *   1. Load order; verify it belongs to the user and is in 'prepared' state
 *   2. Load wallet + check Arc USDC balance ≥ $0.20
 *   3. Pay $0.20 Stoa fee (no trace pin — analyze already pinned)
 *   4. Place (mocked) Limitless order
 *   5. Mark order confirmed in DB
 *   6. DM the user with the result
 */
export async function runConfirmPipeline(
  args: ConfirmPipelineArgs,
): Promise<ConfirmPipelineResult | null> {
  const { cfg, db, chatId, telegramUserId, orderId, requestId } = args;
  try {
    const order = await db.getPreparedOrder(orderId);
    if (!order) throw new Error(`No prepared order with id ${orderId}`);
    if (order.telegram_user_id !== telegramUserId) {
      throw new Error("Order belongs to a different user.");
    }
    if (order.status !== "prepared") {
      throw new Error(
        `Order is already ${order.status}, cannot confirm again.`,
      );
    }
    if (order.signal === "PASS") {
      throw new Error(
        "Analysis said PASS — there's no trade to confirm. Run /analyze on a different market.",
      );
    }

    const wallet = await loadUserWallet(db, cfg, telegramUserId);
    if (!wallet) throw new Error("No wallet — run /start first.");

    const feeMicros = feeConfirmMicros(cfg);
    const arcBal = await readUsdcBalanceArc(cfg, wallet.address);
    if (arcBal < feeMicros) {
      throw new Error(
        `Insufficient Arc USDC. Have ${Number(arcBal) / 1e6}, need ${Number(feeMicros) / 1e6}. Send USDC to ${wallet.address} on Arc Testnet.`,
      );
    }

    const charge = await chargeConfirmFee({
      cfg,
      db,
      wallet,
      feeMicros,
      orderId,
      telegramUserId,
      requestId,
    });
    const settleTx = charge.user_tx;

    const side = (order.side as "BUY" | "SELL" | null) ?? "BUY";
    const price = order.price ?? 0.5;
    const size = order.size ?? (order.recommended_size_usdc ?? 1) / price;
    const mock = await placeMockOrder(cfg, {
      marketSlug: order.market_slug ?? "unknown-market",
      tokenId: order.token_id ?? "0",
      side,
      price,
      size,
    });

    await db.markOrderConfirmed(orderId, settleTx, mock.orderId);

    const feeHeaderLine =
      charge.mode === "shielded"
        ? `*Confirmed* — $0.20 execution fee charged confidentially via Fairblock StableTrust.`
        : `*Confirmed* — $0.20 execution fee charged, split 70/20/10 atomic on Arc.`;
    const txLabel = charge.mode === "shielded" ? "Confidential tx" : "Arc tx";
    const message =
      `${feeHeaderLine}\n\n` +
      `Trade (MOCKED v0): ${side} ${size.toFixed(2)} @ $${price.toFixed(2)}\n` +
      `Limitless orderId: \`${mock.orderId}\`\n\n` +
      `${txLabel}: [${shortHash(settleTx)}](https://testnet.arcscan.app/tx/${settleTx})\n\n` +
      `_When the Limitless partner token arrives, this exact flow will place a real order on Base. The Arc payment is real today._\n\n` +
      `_Request \`${requestId}\` complete._`;

    await sendTelegramMessage(cfg.TELEGRAM_BOT_TOKEN, chatId, message);

    return {
      order_id: orderId,
      confirm_settle_tx: settleTx,
      limitless_order_id: mock.orderId,
    };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error(`[runConfirmPipeline] req=${requestId} failed: ${msg}`);
    await sendTelegramMessage(
      cfg.TELEGRAM_BOT_TOKEN,
      chatId,
      `❌ /confirm failed (request \`${requestId}\`): ${msg}\n\nTry again — if this keeps happening, check /balance and confirm you have ≥ $0.20 USDC on Arc Testnet.`,
    );
    return null;
  }
}

// ── /analyze message formatter ────────────────────────────────────────────

interface FormatAnalyzeArgs {
  trace: FullTrace;
  charge: ChargeResult;
  ipfsCid: string | null;
  orderId: string;
  bankrollUsd: number;
  requestId: string;
}

/**
 * Render the full Metaculus-template analyze result for Telegram. Markdown
 * format; `sendTelegramMessage` retries as plain text on Markdown parse
 * failures so a stray backtick/asterisk doesn't kill the response.
 *
 * Footer + proof block branch by charge.mode:
 *   - public:   footer says "split 70/20/10 atomic on Arc"; proof block's
 *               "Arc tx" link points to the StoaSettler settle() tx
 *               (which atomically pinned the trace).
 *   - shielded: footer says "charged confidentially via Fairblock
 *               StableTrust" and adds a [Confidential tx] link; proof
 *               block's "Arc tx" link points to the SEPARATE operator-
 *               signed TracePin tx (no on-chain link to the user payment).
 */
function formatAnalyzeMessage(args: FormatAnalyzeArgs): string {
  const { trace, charge, ipfsCid, orderId, bankrollUsd, requestId } = args;
  const proofTx: Hex = charge.trace_pin_tx ?? charge.user_tx;
  const j: JudgeTrace = trace.judge_trace;
  const yes = clamp01(j.market_price_yes);
  const no = 1 - yes;
  const pYes = clamp01(j.model_probability_yes);

  // ── Section 0: sub-market disambiguation callout (event URLs only) ──────
  const calloutBlock = renderSubMarketCalloutBlock(j.sub_market_selection);

  // ── Section 1: verdict header ───────────────────────────────────────────
  const verdictEmoji =
    j.signal === "YES" ? "📈" : j.signal === "NO" ? "📉" : "⏸";
  const verdictLabel = formatVerdict(j.signal);

  const ens = trace.judge_ensemble;
  const ensSize = ens?.runs.length ?? 1;
  const directionAg = ens?.directional_agreement ?? 1;
  const edgeBpsAbs = Math.abs(j.edge_yes) * 10_000;
  const strengthLabel =
    j.signal === "PASS"
      ? "no clear edge"
      : edgeBpsAbs >= 800 && directionAg >= 1
        ? "strong signal"
        : edgeBpsAbs >= 400 && directionAg >= 0.67
          ? "moderate signal"
          : "weak signal";

  const headerLines: string[] = [
    `${verdictEmoji} ${verdictLabel} — ${strengthLabel}`,
    j.signal === "PASS"
      ? j.recommendation_reason || shortHeadline(j.thesis)
      : shortHeadline(j.thesis),
  ];
  if (j.signal !== "PASS" && ensSize > 1) {
    const nAgree = Math.round(directionAg * ensSize);
    headerLines.push(`${nAgree} of ${ensSize} AI models agree on direction.`);
  }

  // ── Section 2: market block ─────────────────────────────────────────────
  const marketLines = [
    `Market: ${truncate(trace.market_question, 200)}`,
    `Now:    YES $${yes.toFixed(2)} / NO $${no.toFixed(2)}`,
  ];

  // ── Section 3: confidence line ──────────────────────────────────────────
  const confidenceLine = renderConfidenceLine(j.signal, pYes);

  // ── Section 4: trade plan / wait block (branching) ──────────────────────
  const tradePlanBlock = renderTradePlanBlock({
    judge: j,
    bankrollUsd,
    yes,
    no,
  });

  // ── Section 5: why this is the call (citations) ─────────────────────────
  const whyBlock = renderWhyBlock(j);

  // ── Section 6: what could go wrong (BUY only) ───────────────────────────
  const whatGoesWrongBlock =
    j.signal === "PASS"
      ? null
      : renderWhatGoesWrongBlock(j, j.recommended_size_usdc);

  // ── Section 7: re-evaluation triggers ───────────────────────────────────
  const watchBlock = renderWatchBlock(j);

  // ── Section 8: proof of analysis ────────────────────────────────────────
  const proofBlock = renderProofBlock(proofTx, ipfsCid);

  // ── Section 9: separator ────────────────────────────────────────────────
  const separator = "────────────────────────────────────────";

  // ── Section 10: footer CTA (branching) ──────────────────────────────────
  const footerCta =
    j.signal === "PASS"
      ? `No trade to confirm right now. The bot only recommends trades when edge exceeds 4¢ — a discipline that saves you from noise trades.`
      : `Ready to execute? /confirm ${orderId}\n  ($0.20 execution fee on Arc + your trade on Limitless)`;

  // ── Section 11: request footer ──────────────────────────────────────────
  const requestFooter =
    charge.mode === "shielded"
      ? `_Request \`${requestId}\` — $0.15 charged confidentially via Fairblock StableTrust. [Confidential tx](https://testnet.arcscan.app/tx/${charge.user_tx})._`
      : `_Request \`${requestId}\` — $0.15 charged, split 70/20/10 atomic on Arc._`;

  const parts: (string | null)[] = [
    calloutBlock,
    calloutBlock ? "" : null,
    ...headerLines,
    "",
    ...marketLines,
    confidenceLine,
    "",
    tradePlanBlock,
    "",
    whyBlock,
    "",
    whatGoesWrongBlock,
    whatGoesWrongBlock ? "" : null,
    watchBlock,
    "",
    proofBlock,
    "",
    separator,
    footerCta,
    "",
    requestFooter,
  ];
  return parts.filter((p): p is string => p !== null).join("\n");
}

// ── Section helpers ────────────────────────────────────────────────────────

function renderConfidenceLine(
  signal: JudgeTrace["signal"],
  pYes: number,
): string {
  const sideProb = signal === "NO" ? 1 - pYes : pYes;
  const sideWord = signal === "NO" ? "NO" : "YES";
  const strengthWord =
    sideProb >= 0.75 ? "high" : sideProb >= 0.6 ? "moderate" : "low";
  if (signal === "PASS") {
    return `Confidence: ${Math.round(pYes * 100)}% YES / ${Math.round(
      (1 - pYes) * 100,
    )}% NO — no clear edge`;
  }
  return `Confidence: ${Math.round(sideProb * 100)}% chance ${sideWord} wins (${strengthWord})`;
}

function renderTradePlanBlock(args: {
  judge: JudgeTrace;
  bankrollUsd: number;
  yes: number;
  no: number;
}): string {
  const { judge: j, bankrollUsd, yes, no } = args;
  if (j.signal === "PASS") {
    const reason = j.recommendation_reason
      ? truncate(j.recommendation_reason, 280)
      : "The market is pricing this close to where the model estimates it should be.";
    return (
      `*Wait — no clear edge right now*\n` +
      `  ${reason}\n` +
      `  Stoa won't recommend a trade with edge under 4¢ — a discipline that saves you from noise trades.`
    );
  }
  const verdictSide = j.signal === "NO" ? "NO" : "YES";
  const entryPrice = j.signal === "NO" ? no : yes;
  const stopPrice = entryPrice * 0.85;
  const secondHalfPrice = (entryPrice + stopPrice) / 2;
  const tp1 = entryPrice + 0.4 * (1.0 - entryPrice);
  const tp2 = entryPrice + 0.9 * (1.0 - entryPrice);
  const sizeUsd = j.recommended_size_usdc;
  const sizePct = bankrollUsd > 0 ? (sizeUsd / bankrollUsd) * 100 : 0;
  const resolutionWhen = j.resolution_date_estimate || "market resolution";
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  return (
    `*How to trade*\n` +
    `  Buy:         ${verdictSide} @ ${fmt(entryPrice)} or cheaper\n` +
    `  Spend:       ${fmt(sizeUsd)} (about ${Math.round(sizePct)}% of your ${fmt(bankrollUsd)} wallet)\n` +
    `  Strategy:    half now, half if ${verdictSide} drops to ${fmt(secondHalfPrice)}\n` +
    `  Take profit: sell half at ${verdictSide} ${fmt(tp1)}, sell rest at ${verdictSide} ${fmt(tp2)}\n` +
    `  Stop loss:   sell everything if ${verdictSide} drops below ${fmt(stopPrice)}\n` +
    `  Hold until:  ${resolutionWhen} or any exit trigger below`
  );
}

function renderWhyBlock(j: JudgeTrace): string {
  const evidenceLines =
    j.evidence
      .slice(0, 4)
      .map((e, i) => {
        const claim = truncate(e.claim ?? "(no claim)", 220);
        const claimEsc = escapeMarkdownLinkText(claim);
        const name = escapeMarkdownLinkText(e.source_name ?? "unverified");
        const url = e.source_url;
        if (url) {
          return `  ${i + 1} [${claimEsc}](${url}) — ${name}`;
        }
        return `  ${i + 1} ${claimEsc} — ${name || "unverified"}`;
      })
      .join("\n") || "  (no evidence emitted)";
  return `*Why this is the call*\n${evidenceLines}`;
}

function renderWhatGoesWrongBlock(
  j: JudgeTrace,
  sizeUsd: number,
): string | null {
  if (j.signal === "PASS") return null;
  const oppositeSide = j.signal === "YES" ? "NO" : "YES";
  const counterSide = oppositeSide; // for BUY_YES we surface NO-wins risks
  const minProb = 0.01;
  const buckets = j.risk_decomposition.filter(
    (r) =>
      r.probability >= minProb &&
      (r.side === counterSide || r.side === "ambiguity"),
  );
  if (buckets.length === 0) return null;
  // Sort by probability desc, cap at 4 lines.
  const sorted = [...buckets].sort((a, b) => b.probability - a.probability).slice(0, 4);
  const lines = sorted.map((r) => {
    const pct = Math.round(r.probability * 100);
    const scenario = truncate(r.scenario, 140);
    if (r.side === "ambiguity") {
      return `  • ${pct}% chance ${scenario}`;
    }
    return `  • ${pct}% chance ${scenario} → ${oppositeSide} wins, you lose $${sizeUsd.toFixed(2)}`;
  });
  return `*What could go wrong*\n${lines.join("\n")}`;
}

function renderWatchBlock(j: JudgeTrace): string {
  const triggers = (j.reevaluation_triggers ?? []).slice(0, 5);
  if (triggers.length === 0) {
    return `*Watch these signals to re-analyze*\n  • (no triggers emitted — re-run /analyze when material new information arrives)`;
  }
  const lines = triggers.map((t) => `  • ${truncate(t, 200)}`).join("\n");
  return `*Watch these signals to re-analyze*\n${lines}`;
}

function renderProofBlock(txHash: Hex, ipfsCid: string | null): string {
  const arcLink = `[${shortHash(txHash)}](https://testnet.arcscan.app/tx/${txHash})`;
  const ipfsLine = ipfsCid
    ? `  Reasoning trace: [${shortHash(ipfsCid)}](https://gateway.pinata.cloud/ipfs/${ipfsCid})`
    : `  Reasoning trace: (no pin)`;
  return `*Proof of analysis (on-chain, immutable)*\n  Arc tx: ${arcLink}\n${ipfsLine}`;
}

/**
 * Conservative escape for text destined to live inside legacy Markdown
 * `[text](url)` link bodies. Escapes the chars that would break the link
 * structure (`[`, `]`) or accidentally trigger inline formatting (`_`,
 * `*`, backslash, backtick). URL contents are left untouched — the
 * formatter never injects user-controlled URLs anywhere but inside the
 * `(...)` of the link, where these chars don't need escaping. Markdown V2
 * users wanting full escape coverage should switch parse_mode globally;
 * we keep legacy mode so the rest of the message (period-separated prose,
 * parens around fractions, etc.) renders without backslash noise.
 */
function escapeMarkdownLinkText(s: string): string {
  return s.replace(/[\\`*_[\]]/g, (m) => `\\${m}`);
}

function clamp01(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Compact a multi-sentence thesis into a verdict-header headline.
 *
 * Strategy:
 *   1. Pack whole sentences (split on .!?) up to MAX_LEN — if at least one
 *      full sentence fits, return that with no ellipsis.
 *   2. Otherwise, the first sentence alone exceeds MAX_LEN. Truncate at the
 *      last word boundary that fits and append "…" so the cut is clean.
 *
 * Previous version char-truncated at 120, which produced output like
 * "…wins both runoff scenarios ..." (cut mid-clause, dangling spaces).
 */
function shortHeadline(thesis: string): string {
  const MAX_LEN = 200;
  const trimmed = thesis.trim();
  if (trimmed.length <= MAX_LEN) return trimmed;

  // Split into sentences while keeping their terminators, so we can pack
  // complete sentences back together.
  const sentences = trimmed.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [trimmed];
  let packed = "";
  for (const s of sentences) {
    const candidate = packed ? `${packed} ${s.trim()}` : s.trim();
    if (candidate.length > MAX_LEN) break;
    packed = candidate;
  }
  if (packed.length > 0) return packed;

  // First sentence alone exceeds MAX_LEN. Word-boundary truncate the start.
  const head = trimmed.slice(0, MAX_LEN - 1);
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace > MAX_LEN * 0.6 ? head.slice(0, lastSpace) : head;
  return `${cut.replace(/[\s,;:—-]+$/, "")}…`;
}

/**
 * Display label for the trade direction. NEVER returns a string with an
 * underscore — Telegram legacy Markdown treats `_` as italic markup, and
 * "BUY_YES" rendered the entire downstream message in italic (or as plain
 * text) until the next `_`, which broke the bold section headers and the
 * Arc-tx hyperlink. Always insert a space.
 */
function formatVerdict(signal: JudgeTrace["signal"]): string {
  if (signal === "YES") return "BUY YES";
  if (signal === "NO") return "BUY NO";
  return "PASS";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Human-readable USD volume formatter. Telegram users skim — kilo/mega
 * suffixes beat raw 7-digit numbers. Always returns a $-prefixed string.
 *
 *   $1,234,567 → "$1.23M"
 *   $27,170,900 → "$27.17M"
 *   $1,200 → "$1.2k"
 *   $60 → "$60"
 */
function humanFormatVolume(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "$?";
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}k`;
  return `$${Math.round(usd)}`;
}

/**
 * Pre-header callout for event URLs. Returns null for direct market URLs
 * (no selection happened) or when the selection metadata is missing — in
 * either case the formatter skips this section entirely.
 *
 * When the event has multiple moderate sub-markets, lists up to 3
 * alternatives. When there's only one moderate sub-market, replaces the
 * "Other moderate-priced options" list with a single explanatory line.
 *
 * NEVER rendered when selection.selected is null — that path is the
 * refuse-and-no-charge case handled in {@link formatNoAnalyzableSubMarketMessage},
 * which the pipeline invokes before the formatter ever runs.
 */
function renderSubMarketCalloutBlock(
  selection: SubMarketSelection | null | undefined,
): string | null {
  if (!selection || !selection.isEventUrl || !selection.selected) return null;
  const sel = selection.selected;
  const yes = `$${sel.yesPrice.toFixed(2)}`;
  const vol = humanFormatVolume(sel.volumeUsd);
  const lines = [
    `ℹ️ *Sub-market selected*`,
    `This event has ${selection.totalSubMarkets} sub-markets. I analyzed the highest-volume one in moderate price range:`,
    `  "${truncate(sel.question, 160)}" (YES ${yes}, ${vol} volume)`,
    "",
  ];
  if (selection.alternatives.length > 0) {
    lines.push(
      `Other moderate-priced options (${selection.moderateCount - 1} total):`,
    );
    for (const alt of selection.alternatives) {
      lines.push(
        `  • ${truncate(alt.question, 130)} (YES $${alt.yesPrice.toFixed(2)})`,
      );
    }
    lines.push("");
  } else {
    lines.push(`This was the only moderate-priced sub-market in this event.`);
    lines.push("");
  }
  lines.push(
    `Paste a specific sub-market URL to analyze it directly. ${selection.extremeCount} sub-markets were skipped because they're at extreme prices (>$0.90 or <$0.10) where no meaningful edge can exist.`,
    "",
    "────────────────────────────────────────",
  );
  return lines.join("\n");
}

/**
 * Refuse-and-no-charge message for events where every sub-market is at
 * extreme prices. Sent by {@link runAnalyzePipeline} BEFORE any fee charge.
 * Mirror of the regular formatter's request footer so the user still sees a
 * request-id correlation, but without the "$0.15 charged" — because we did
 * not charge.
 */
function formatNoAnalyzableSubMarketMessage(
  selection: SubMarketSelection,
  requestId: string,
): string {
  return [
    `ℹ️ *No analyzable sub-markets in this event*`,
    `All ${selection.totalSubMarkets} sub-markets in this event are at extreme prices (>$0.90 or <$0.10). No meaningful edge can be analyzed — the market is already pricing these as near-certainties.`,
    "",
    `Try one of:`,
    `  • Paste a specific sub-market URL directly`,
    `  • Use a different event URL with active price discovery`,
    "",
    `_Request \`${requestId}\` — no fee charged._`,
  ].join("\n");
}
