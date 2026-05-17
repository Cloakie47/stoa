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
  const proofBlock = renderProofBlock(txHash, ipfsCid);

  // ── Section 9: separator ────────────────────────────────────────────────
  const separator = "────────────────────────────────────────";

  // ── Section 10: footer CTA (branching) ──────────────────────────────────
  const footerCta =
    j.signal === "PASS"
      ? `No trade to confirm right now. The bot only recommends trades when edge exceeds 4¢ — a discipline that saves you from noise trades.`
      : `Ready to execute? /confirm ${orderId}\n  ($0.20 execution fee on Arc + your trade on Limitless)`;

  // ── Section 11: request footer ──────────────────────────────────────────
  const requestFooter = `_Request \`${requestId}\` — $0.15 charged, split 70/20/10 atomic on Arc._`;

  const parts: (string | null)[] = [
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
