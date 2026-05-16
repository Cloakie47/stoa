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
import { computeKellyFraction } from "@stoa/insight-engine";

import type { BotCoreConfig } from "./config.js";
import { feeAnalyzeMicros, feeConfirmMicros } from "./config.js";
import type { DbClient } from "./db-client.js";
import { runFullAnalysis } from "./insight.js";
import { placeMockOrder } from "./limitless.js";
import { payStoaFee } from "./stoa.js";
import { sendTelegramMessage } from "./telegram.js";
import {
  loadUserWallet,
  readUsdcBalanceArc,
  readUsdcBalanceBase,
} from "./wallet.js";
import type { Hex } from "viem";

function shortHash(h: string): string {
  if (h.length < 12) return h;
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

// ── /analyze pipeline ────────────────────────────────────────────────────────

export interface AnalyzePipelineArgs {
  cfg: BotCoreConfig;
  db: DbClient;
  chatId: number;
  telegramUserId: number;
  marketUrl: string;
  requestId: string;
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
 *   4. Pay $0.10 Stoa fee atomically (split + trace pin)
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

    const baseBalForKelly = await readUsdcBalanceBase(cfg, wallet.address)
      .then((b) => Number(b) / 1_000_000)
      .catch(() => 0);

    const analysis = await runFullAnalysis(cfg, marketUrl, baseBalForKelly);

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
        traceHash: analysis.trace_hash,
        ipfsCid: analysis.ipfs_cid ?? "",
      });
      await db.logFeeChargeMined(feeId, txHash);
    } catch (e) {
      await db.logFeeChargeFailed(feeId, (e as Error).message);
      throw e;
    }

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
      pinned_tx: txHash,
      analyze_settle_tx: txHash,
    });
    await db.recordTracePin(
      telegramUserId,
      analysis.trace_hash,
      txHash,
      analysis.ipfs_cid,
      marketUrl,
      judge.signal,
      judge.confidence,
      JSON.stringify(analysis.trace),
    );

    const yesPrice = judge.market_price_yes ?? 0;
    const kellyFraction = computeKellyFraction({
      signal: judge.signal,
      subjective_probability: judge.confidence,
      current_yes_price: yesPrice,
    });

    const tag =
      judge.signal === "YES"
        ? "📈 YES"
        : judge.signal === "NO"
          ? "📉 NO"
          : "⏸ PASS";

    const ipfsLink = analysis.ipfs_cid ? `\nIPFS: \`${analysis.ipfs_cid}\`` : "";

    const message =
      `*Analysis complete* — $0.10 charged, split 70/20/10 atomic on Arc.\n\n` +
      `${tag} (confidence ${(judge.confidence * 100).toFixed(0)}%)\n\n` +
      `${judge.thesis ?? "(no thesis)"}\n\n` +
      `*Recommended size:* $${judge.recommended_size_usdc.toFixed(2)} ` +
      `(Kelly ${(kellyFraction * 100).toFixed(1)}% of bankroll)\n\n` +
      `*On-chain artifacts*\n` +
      `Arc tx: [${shortHash(txHash)}](https://testnet.arcscan.app/tx/${txHash})${ipfsLink}\n` +
      `Trace hash: \`${shortHash(analysis.trace_hash)}\`\n\n` +
      `*To execute:* \`/confirm ${order_id}\`\n` +
      `($0.20 execution fee + the trade itself on Base)\n\n` +
      `_Request \`${requestId}\` complete._`;

    await sendTelegramMessage(cfg.TELEGRAM_BOT_TOKEN, chatId, message);

    return {
      order_id,
      trace_hash: analysis.trace_hash,
      ipfs_cid: analysis.ipfs_cid,
      analyze_settle_tx: txHash,
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
      `❌ /analyze failed (request \`${requestId}\`): ${msg}\n\nTry again — if this keeps happening, check /balance and confirm you have ≥ $0.10 USDC on Arc Testnet.`,
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

    const feeId = await db.logFeeChargeStart(
      telegramUserId,
      "confirm",
      Number(feeMicros),
      orderId,
    );
    let settleTx: Hex;
    try {
      settleTx = await payStoaFee({
        cfg,
        userPrivateKey: wallet.privateKey,
        userAddress: wallet.address,
        amountUsdcMicros: feeMicros,
      });
      await db.logFeeChargeMined(feeId, settleTx);
    } catch (e) {
      await db.logFeeChargeFailed(feeId, (e as Error).message);
      throw e;
    }

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

    const message =
      `*Confirmed* — $0.20 execution fee charged, split 70/20/10 atomic on Arc.\n\n` +
      `Trade (MOCKED v0): ${side} ${size.toFixed(2)} @ $${price.toFixed(2)}\n` +
      `Limitless orderId: \`${mock.orderId}\`\n\n` +
      `Arc tx: [${shortHash(settleTx)}](https://testnet.arcscan.app/tx/${settleTx})\n\n` +
      `_When the Limitless partner token arrives, this exact flow will place a real order on Base. The Arc split is real today._\n\n` +
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
