/**
 * x402 facilitator route — POST /api/x402/analyze.
 *
 * Pattern:
 *   1. Caller POSTs { marketUrl } with no X-PAYMENT header.
 *      → 402 Payment Required + JSON instructions (recipient, amount,
 *        chain, freshness window).
 *   2. Caller transfers USDC on Arc Testnet to the recipient.
 *   3. Caller retries the POST with X-PAYMENT: <tx_hash>.
 *      → Verifier checks the tx (mined, success, transfers to settler,
 *        >= 150000 micros, < 5min old, not already used).
 *      → On pass: run the full insight-engine analysis, return JSON.
 *      → On any failure: 402 with a discriminated `reason` so the
 *        caller knows what to fix.
 *
 * The settler / chargeFee path used by the Telegram bot is NOT invoked
 * here — the caller already paid via a plain ERC-20 Transfer. We still
 * pin the reasoning trace to IPFS for verifiability; no on-chain
 * TracePin tx is emitted in V1 because the X-PAYMENT tx already serves
 * as the on-chain audit anchor.
 */
import {
  runFullAnalysis,
  type BotCoreConfig,
  type FullAnalysis,
} from "@stoa/bot-core";
import {
  fetchMarketContext,
  NoAnalyzableSubMarketError,
} from "@stoa/insight-engine";
import type { Request, RequestHandler, Response } from "express";
import { createPublicClient, http, type Address, type Hex } from "viem";

import {
  makeRateLimiter,
  makeReplayCache,
  verifyPayment,
  type RateLimiter,
  type ReplayCache,
  type VerifierClient,
} from "./x402-verify.js";

const X402_SCHEMA_VERSION = "stoa.x402.v1";
const FRESHNESS_WINDOW_SEC = 300;

/** Notional bankroll passed to runFullAnalysis for Kelly sizing. The
 *  x402 response does NOT expose recommended_size_usdc — callers have
 *  no Stoa-managed wallet — but the Kelly machinery still needs a
 *  bankroll to compute calibrated edge + verdict. $100 is a neutral
 *  midpoint; the verdict + confidence are invariant to bankroll, only
 *  the (omitted) size scales with it. */
const NOTIONAL_BANKROLL_USD = 100;

const X_PAYMENT_RE = /^0x[a-fA-F0-9]{64}$/;

export interface X402RouteDeps {
  cfg: BotCoreConfig;
  /** Override the default in-memory replay cache (tests inject a
   *  deterministic-clock variant). */
  replayCache?: ReplayCache;
  rateLimiter?: RateLimiter;
  /** Override the default viem PublicClient. */
  client?: VerifierClient;
  /** Override the default analyse runner (tests inject a stub). */
  runAnalysis?: (cfg: BotCoreConfig, marketUrl: string) => Promise<FullAnalysis>;
  /** Override the default Date.now()-based clock (seconds). */
  nowSeconds?: () => number;
}

interface X402RequestBody {
  marketUrl?: unknown;
}

export interface X402Route {
  handler: RequestHandler;
  /** Test seam — exposes the replay cache + rate limiter the route uses. */
  internals: { replayCache: ReplayCache; rateLimiter: RateLimiter };
}

export function makeX402Route(deps: X402RouteDeps): X402Route {
  const replayCache = deps.replayCache ?? makeReplayCache();
  const rateLimiter = deps.rateLimiter ?? makeRateLimiter();
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  const client: VerifierClient =
    deps.client ??
    (createPublicClient({
      transport: http(deps.cfg.ARC_TESTNET_RPC),
    }) as unknown as VerifierClient);

  const recipient = deps.cfg.STOA_SETTLER as Address;
  const tokenAddress = deps.cfg.ARC_USDC as Address;
  const minAmount = BigInt(deps.cfg.STOA_FEE_ANALYZE_USDC);
  const chainId = Number.parseInt(deps.cfg.ARC_CHAIN_ID, 10);

  const runAnalysis =
    deps.runAnalysis ??
    ((cfg: BotCoreConfig, marketUrl: string) =>
      runFullAnalysisForX402(cfg, marketUrl));

  const handler: RequestHandler = async (req, res) => {
    const ip = sourceKey(req);
    const paymentHeader = req.header("x-payment") ?? req.header("X-PAYMENT");

    // ── Input validation (marketUrl + X-PAYMENT shape) ─────────────────
    const body = (req.body ?? {}) as X402RequestBody;
    if (
      typeof body.marketUrl !== "string" ||
      !isLikelyUrl(body.marketUrl)
    ) {
      return res.status(400).json({
        error: "Bad request",
        detail: "marketUrl must be a valid URL string",
      });
    }
    const marketUrl = body.marketUrl;

    if (paymentHeader !== undefined && !X_PAYMENT_RE.test(paymentHeader)) {
      return res.status(400).json({
        error: "Bad request",
        detail:
          "X-PAYMENT must be a 0x-prefixed 32-byte hex string (66 chars)",
      });
    }

    // ── Rate limit ─────────────────────────────────────────────────────
    const rlKind = paymentHeader ? "paid" : "challenge";
    if (!rateLimiter.tryConsume(ip, rlKind)) {
      return res.status(429).json({
        error: "Too many requests",
        detail: `Rate limit exceeded for ${rlKind} requests; retry in <60s`,
      });
    }

    // ── Case A: no payment header → 402 challenge ──────────────────────
    if (!paymentHeader) {
      return send402Challenge(res, {
        cfg: deps.cfg,
        recipient,
        tokenAddress,
        minAmount,
        chainId,
      });
    }

    // ── Case B: payment header present → verify on-chain ───────────────
    const result = await verifyPayment({
      txHash: paymentHeader as Hex,
      tokenAddress,
      recipient,
      minAmount,
      freshnessWindowSeconds: FRESHNESS_WINDOW_SEC,
      nowSeconds,
      client,
      replayCache,
    });
    if (!result.ok) {
      const bodyOut: Record<string, unknown> = {
        error: "Payment verification failed",
        reason: result.reason,
      };
      if (result.required_amount !== undefined) {
        bodyOut.required_amount = result.required_amount.toString();
      }
      if (result.received_amount !== undefined) {
        bodyOut.received_amount = result.received_amount.toString();
      }
      if (result.block_age_seconds !== undefined) {
        bodyOut.block_age_seconds = result.block_age_seconds;
      }
      bodyOut.freshness_window_seconds = FRESHNESS_WINDOW_SEC;
      return res.status(402).json(bodyOut);
    }

    console.log(
      `[x402] verified payment tx=${result.tx_hash} amount=${result.received_amount.toString()} ` +
        `block=${result.block_number.toString()} ip=${ip}`,
    );

    // ── Run the analysis (bypasses settler / chargeFee / DM) ───────────
    try {
      const analysis = await runAnalysis(deps.cfg, marketUrl);
      return res.status(200).json(buildSuccessResponse(analysis, paymentHeader as Hex, marketUrl));
    } catch (e) {
      if (e instanceof NoAnalyzableSubMarketError) {
        // Caller paid for the attempt; we surface a PASS verdict with
        // the refusal reason rather than a 5xx so the caller gets a
        // structured answer for the USDC they spent.
        return res.status(200).json({
          verdict: "PASS",
          confidence: 0,
          edge: 0,
          marketQuestion: e.selection.selected?.question ?? marketUrl,
          marketUrl,
          thesis:
            "Stoa refused to analyse this event: every sub-market is at extreme prices (>$0.90 or <$0.10) where no meaningful edge can be assessed.",
          ipfs_trace: null,
          arc_settlement_tx: paymentHeader,
          settlement_mode: "x402_public",
          schema_version: X402_SCHEMA_VERSION,
          _note:
            "Caller paid for the analysis attempt; no refund is issued. To get an analysable verdict, paste a specific sub-market URL instead of the event URL.",
        });
      }
      console.error(
        `[x402] analysis failed after verified payment tx=${paymentHeader} url=${marketUrl}: ${(e as Error).message}`,
      );
      // A 5xx here is correct because the caller paid and we failed to
      // deliver. The replay cache already consumed the tx hash, so the
      // caller will need to resubmit with a fresh payment — operator
      // reconciles refunds manually in V1.
      return res.status(500).json({
        error: "Analysis failed after payment was accepted",
        detail: (e as Error).message,
        arc_settlement_tx: paymentHeader,
      });
    }
  };

  return { handler, internals: { replayCache, rateLimiter } };
}

function send402Challenge(
  res: Response,
  args: {
    cfg: BotCoreConfig;
    recipient: Address;
    tokenAddress: Address;
    minAmount: bigint;
    chainId: number;
  },
): Response {
  const amountDollars = (Number(args.minAmount) / 1e6).toFixed(2);
  return res.status(402).json({
    error: "Payment required",
    facilitator: "stoa.v1",
    mode: "public",
    amount: amountDollars,
    asset: "USDC",
    chain: "arc-testnet",
    chainId: args.chainId,
    recipient: args.recipient,
    asset_address: args.tokenAddress,
    freshness_window_seconds: FRESHNESS_WINDOW_SEC,
    instructions:
      `Transfer ${amountDollars} USDC (or more) to ${args.recipient} on Arc Testnet ` +
      `(chainId ${args.chainId}). Then retry this request including the header ` +
      `X-PAYMENT: <tx_hash>. The transaction must be confirmed within ` +
      `${FRESHNESS_WINDOW_SEC} seconds of the retry and must not have been used ` +
      `for a previous request.`,
    docs: "https://github.com/Cloakie47/stoa#x402-api",
  });
}

function buildSuccessResponse(
  analysis: FullAnalysis,
  txHash: Hex,
  marketUrl: string,
): Record<string, unknown> {
  const j = analysis.trace.judge_trace;
  const verdict =
    j.signal === "YES" ? "BUY_YES" : j.signal === "NO" ? "BUY_NO" : "PASS";
  const edge = j.signal === "NO" ? j.edge_no : j.edge_yes;
  return {
    verdict,
    confidence: round4(j.confidence / 100),
    edge: round4(edge),
    marketQuestion: analysis.trace.market_question,
    marketUrl,
    thesis: j.thesis,
    ipfs_trace: analysis.ipfs_cid,
    arc_settlement_tx: txHash,
    settlement_mode: "x402_public",
    schema_version: X402_SCHEMA_VERSION,
    _note:
      "recommended_size_usdc is omitted in x402 mode since callers do not have a Stoa-managed bankroll",
  };
}

async function runFullAnalysisForX402(
  cfg: BotCoreConfig,
  marketUrl: string,
): Promise<FullAnalysis> {
  // Pre-resolve the market context so NoAnalyzableSubMarketError is
  // raised cheaply — runFullAnalysis would otherwise re-fetch context
  // internally. Matches the bot's runAnalyzePipeline pattern.
  const context = await fetchMarketContext(marketUrl);
  return runFullAnalysis(cfg, marketUrl, NOTIONAL_BANKROLL_USD, context, {
    redactPin: false,
  });
}

function isLikelyUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function sourceKey(req: Request): string {
  // Express populates req.ip from X-Forwarded-For when `trust proxy` is set.
  // On Railway the platform forwards XFF reliably; if not, we fall back to
  // the socket address. Either way, a deterministic non-empty string.
  const ip =
    (typeof req.ip === "string" && req.ip.length > 0 ? req.ip : null) ??
    req.socket.remoteAddress ??
    "unknown";
  return ip;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
