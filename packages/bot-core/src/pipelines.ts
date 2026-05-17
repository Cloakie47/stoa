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
import { formatEdgeSigned } from "@stoa/insight-engine";
import type { FullTrace, JudgeTrace } from "@stoa/insight-engine";

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

    const analysis = await runFullAnalysis(cfg, marketUrl, bankrollUsd);

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

    const message = formatAnalyzeMessage({
      trace: analysis.trace,
      txHash,
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

// ── /analyze message formatter ────────────────────────────────────────────

interface FormatAnalyzeArgs {
  trace: FullTrace;
  txHash: Hex;
  ipfsCid: string | null;
  orderId: string;
  bankrollUsd: number;
  requestId: string;
}

/**
 * Render the full Metaculus-template analyze result for Telegram. Markdown
 * format; `sendTelegramMessage` retries as plain text on Markdown parse
 * failures so a stray backtick/asterisk doesn't kill the response.
 */
function formatAnalyzeMessage(args: FormatAnalyzeArgs): string {
  const { trace, txHash, ipfsCid, orderId, bankrollUsd, requestId } = args;
  const j: JudgeTrace = trace.judge_trace;
  const yes = clamp01(j.market_price_yes);
  const no = 1 - yes;
  const pYes = clamp01(j.model_probability_yes);
  const ciLow = clamp01(j.ci_low ?? Math.max(0, pYes - 0.15));
  const ciHigh = clamp01(j.ci_high ?? Math.min(1, pYes + 0.15));

  // Outside view + inside view are nullable — when the Historical agent
  // could not anchor a reference class, the Judge sets both to null and the
  // formatter hides those lines (replaced with a single "Reference class:
  // insufficient" line below).
  const hasOutsideView =
    typeof j.outside_view_p_yes === "number" && Number.isFinite(j.outside_view_p_yes);
  const outsideView = hasOutsideView ? clamp01(j.outside_view_p_yes!) : null;
  const insideAdj = hasOutsideView ? (j.inside_view_adjustment ?? 0) : null;

  // Edge sign: positive = YES side; we report whichever side the trade is on
  // (or the raw signed edge_yes on PASS so the body matches the header text).
  const edgeSigned =
    j.signal === "NO" ? -Math.abs(j.edge_no) : j.edge_yes;
  const edgeStr = formatEdgeSigned(edgeSigned);

  const verdictEmoji =
    j.signal === "YES" ? "📈" : j.signal === "NO" ? "📉" : "⏸";
  const verdictHeader =
    j.signal === "PASS"
      ? `${verdictEmoji} PASS — ${j.recommendation_reason ?? "no actionable edge"}`
      : `${verdictEmoji} BUY_${j.signal} — ${shortHeadline(j.thesis)}`;

  // ── Ensemble agreement line ──
  const ens = trace.judge_ensemble;
  const ensSize = ens?.runs.length ?? 1;
  const verdictAg = ens?.verdict_agreement ?? 1;
  const directionAg = ens?.directional_agreement ?? 1;
  const ensembleLine =
    ensSize > 1
      ? `  Ensemble: ${ensSize}-model median, verdict ${(verdictAg * 100).toFixed(0)}%, direction ${(directionAg * 100).toFixed(0)}%`
      : `  Ensemble: 1 model (disabled or fallback)`;

  // ── Recommended action block ──
  // For PASS: replace the "PASS — same reason as header" redundancy with a
  // forward-looking "Wait. Re-enter on the first of: <triggers>". For the
  // BUY verdicts, keep the standard entry/size/stop block.
  const sizePct =
    bankrollUsd > 0 ? (j.recommended_size_usdc / bankrollUsd) * 100 : 0;
  const entryPrice = j.signal === "NO" ? no : yes;
  let actionBlock: string;
  if (j.signal === "PASS") {
    const triggers = (j.reevaluation_triggers ?? [])
      .slice(0, 3)
      .map((t) => `    • ${truncate(t, 200)}`)
      .join("\n");
    actionBlock = triggers
      ? `*Recommended action*\n  Wait. Re-enter on the first of:\n${triggers}`
      : `*Recommended action*\n  Wait — re-run /analyze when material new information arrives.`;
  } else {
    actionBlock =
      `*Recommended action*\n` +
      `  BUY_${j.signal} @ $${entryPrice.toFixed(3)} or better\n` +
      `  Size: $${j.recommended_size_usdc.toFixed(2)} (${sizePct.toFixed(1)}% of $${bankrollUsd.toFixed(2)} bankroll, quarter-Kelly)\n` +
      `  Stop: exit if ${j.signal === "YES" ? `YES drops below $${(yes * 0.85).toFixed(2)}` : `NO drops below $${(no * 0.85).toFixed(2)}`}\n` +
      `  Hold until: resolution or trigger`;
  }

  // ── Evidence ──
  // Render each evidence item as a Markdown hyperlink so tapping a bullet
  // opens the source URL in Telegram. We stay on legacy Markdown parse mode
  // (the rest of the message uses *bold* / `code` / [link](url)), so
  // escape the bracket chars that would break legacy-Markdown link parsing,
  // plus the chars that would unintentionally trigger formatting inside the
  // link text. URLs are left raw — legacy MD accepts them as-is.
  const evidenceLines =
    j.evidence
      .slice(0, 4)
      .map((e, i) => {
        const claim = truncate(e.claim ?? "(no claim)", 220);
        const claimEsc = escapeMarkdownLinkText(claim);
        const name = escapeMarkdownLinkText(e.source_name ?? "unverified");
        const url = e.source_url;
        if (url) {
          return `  [${i + 1}] [${claimEsc}](${url}) — ${name}`;
        }
        return `  [${i + 1}] ${claimEsc} — ${name || "unverified"}`;
      })
      .join("\n") || "  (no evidence emitted)";

  // ── Risk decomposition ──
  const riskLines =
    j.risk_decomposition.length > 0
      ? j.risk_decomposition
          .slice(0, 4)
          .map(
            (r) =>
              `  • ${truncate(r.scenario, 100)} — ${(r.probability * 100).toFixed(0)}%`,
          )
          .join("\n")
      : "  (no risk decomposition)";
  const triggers =
    j.reevaluation_triggers.length > 0
      ? j.reevaluation_triggers.slice(0, 5).join("; ")
      : "no triggers emitted";

  // ── Calibration ──
  const cal = j.calibration_adjustment;
  const calBlock = cal
    ? `*Calibration adjustment applied*\n` +
      `  Domain: ${cal.domain}\n` +
      `  Adjustment: ${cal.adjustment_applied >= 0 ? "+" : ""}${cal.adjustment_applied} bps\n` +
      `  Reason: ${truncate(cal.reason, 240)}`
    : `*Calibration adjustment applied*\n  Domain: other — no adjustment`;

  // ── Time to resolution ──
  const hrs = trace.judge_ensemble?.aggregate
    ? undefined
    : undefined;
  void hrs;

  // ── On-chain artifacts ──
  const arcLink = `[${shortHash(txHash)}](https://testnet.arcscan.app/tx/${txHash})`;
  const ipfsLine = ipfsCid ? `IPFS:  \`${shortHash(ipfsCid)}\`` : `IPFS:  (no pin)`;

  // Model-estimate block has two shapes depending on whether the Historical
  // agent could anchor a reference class.
  const modelEstimateLines = [
    `*Model estimate*`,
    `  P(YES) = ${pYes.toFixed(3)} [80% CI: ${ciLow.toFixed(2)} – ${ciHigh.toFixed(2)}]`,
  ];
  if (outsideView === null) {
    modelEstimateLines.push(
      `  Reference class: insufficient (Historical agent could not identify defensible reference class)`,
    );
  } else {
    modelEstimateLines.push(
      `  Outside view (base rate): ${outsideView.toFixed(3)}`,
      `  Inside view adjustment: ${insideAdj! >= 0 ? "+" : ""}${insideAdj!.toFixed(3)}`,
    );
  }
  modelEstimateLines.push(`  Edge: ${edgeStr}`, ensembleLine);

  return [
    verdictHeader,
    `Market: ${truncate(trace.market_question, 200)}`,
    `Current price: YES $${yes.toFixed(3)} / NO $${no.toFixed(3)}`,
    "",
    ...modelEstimateLines,
    "",
    actionBlock,
    "",
    `*Why*`,
    evidenceLines,
    "",
    `*What would invalidate this call*`,
    riskLines,
    `  → Re-run /analyze if: ${truncate(triggers, 300)}`,
    "",
    calBlock,
    "",
    `*On-chain artifacts*`,
    `Arc tx: ${arcLink}`,
    ipfsLine,
    `Trace hash: \`${shortHash(trace.trace_hash ?? "0x")}\``,
    "",
    j.signal === "PASS"
      ? `_No trade to confirm. Run /analyze on a different market._`
      : `*To execute:* \`/confirm ${orderId}\`\n($0.20 execution fee + the trade itself on Limitless)`,
    "",
    `_Request \`${requestId}\` — $0.15 charged, split 70/20/10 atomic on Arc._`,
  ].join("\n");
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

function shortHeadline(thesis: string): string {
  const first = thesis.split(/[.!?]/)[0] ?? thesis;
  return truncate(first.trim(), 120);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
