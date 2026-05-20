/**
 * Stoa Analyzer — Railway-hosted Express service that runs the long pipelines
 * the Cloudflare Worker can't (waitUntil has a 30s cap, and /analyze is
 * routinely 30-60+ seconds).
 *
 * Endpoints:
 *   GET  /              — health check
 *   POST /jobs/analyze  — { chatId, telegramUserId, marketUrl, requestId }
 *   POST /jobs/confirm  — { chatId, telegramUserId, orderId, requestId }
 *
 * Both job endpoints validate the X-Stoa-Timestamp + X-Stoa-Signature
 * headers against ANALYZER_HMAC_SECRET, schedule the in-process pipeline,
 * and return 202 immediately. The pipeline DMs the result to the user when
 * complete via direct Telegram API call.
 *
 * In-process scheduling is good enough for hackathon scale (handful of users,
 * tens of analyses per day). A real queue (BullMQ + Redis) would be the
 * v1 upgrade.
 */
import { runAnalyzePipeline, runConfirmPipeline } from "@stoa/bot-core";
import express, { type Request, type Response } from "express";

import { httpDbClient } from "./db-http-client.js";
import { loadEnv } from "./env.js";
import { verifyRequest } from "./hmac.js";
import { makeX402Route } from "./x402-route.js";

const env = loadEnv();
const dbc = httpDbClient({
  botInternalUrl: env.BOT_INTERNAL_URL,
  hmacSecret: env.ANALYZER_HMAC_SECRET,
});

// Express body parsing: we need the RAW string for HMAC verification AND
// the parsed JSON for the handler. The verifier requires byte-identical
// input to the bytes the bot signed, so we capture the raw body via the
// `verify` callback before express.json() parses it.
const app = express();
// Trust Railway's reverse proxy so req.ip reflects the original client.
// Used by the x402 rate-limiter; harmless for the HMAC-protected /jobs/*
// endpoints which don't read req.ip. If we're not actually behind a proxy
// (e.g. local `pnpm run dev`), Express still falls back to socket address
// — see sourceKey() in x402-route.ts.
app.set("trust proxy", true);
app.use(
  express.json({
    limit: "256kb",
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  }),
);

app.get("/", (_req, res) => {
  res.status(200).send("stoa-analyzer ok");
});

// ── x402 facilitator endpoint ────────────────────────────────────────────
// POST /api/x402/analyze — public, on-chain-paid /analyze for AI agents.
// Independent of the Telegram-bot HMAC path; uses USDC Transfer events on
// Arc Testnet as the authentication primitive (one tx = one analysis).
const x402 = makeX402Route({ cfg: env.cfg });
app.post("/api/x402/analyze", x402.handler);

app.get("/version", (_req, res) => {
  res.json({
    name: "@stoa/analyzer",
    version: "0.0.1",
    bot_internal: env.BOT_INTERNAL_URL,
  });
});

// ── Job: /analyze ────────────────────────────────────────────────────────────

interface AnalyzeJobBody {
  chatId: number;
  telegramUserId: number;
  marketUrl: string;
  requestId: string;
  /** Optional payment-mode override from the bot's inline-keyboard
   *  selection. When omitted, runAnalyzePipeline uses its default policy. */
  paymentMode?: "public" | "shielded";
}

app.post("/jobs/analyze", async (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? "";
  try {
    await verifyRequest({
      body: rawBody,
      timestamp: (req.headers["x-stoa-timestamp"] as string | undefined) ?? null,
      signature: (req.headers["x-stoa-signature"] as string | undefined) ?? null,
      secret: env.ANALYZER_HMAC_SECRET,
    });
  } catch (e) {
    return res.status(401).send(`unauthorized: ${(e as Error).message}`);
  }

  const body = req.body as Partial<AnalyzeJobBody>;
  if (
    typeof body.chatId !== "number" ||
    typeof body.telegramUserId !== "number" ||
    typeof body.marketUrl !== "string" ||
    typeof body.requestId !== "string"
  ) {
    return res.status(400).json({ error: "invalid body" });
  }

  console.log(
    `[jobs/analyze] req=${body.requestId} user=${body.telegramUserId} url=${body.marketUrl}`,
  );

  const paymentMode =
    body.paymentMode === "public" || body.paymentMode === "shielded"
      ? body.paymentMode
      : undefined;

  // Schedule in the background — don't await; respond 202 right away.
  void runAnalyzePipeline({
    cfg: env.cfg,
    db: dbc,
    chatId: body.chatId,
    telegramUserId: body.telegramUserId,
    marketUrl: body.marketUrl,
    requestId: body.requestId,
    paymentMode,
  }).catch((e: unknown) => {
    console.error(
      `[jobs/analyze] req=${body.requestId} uncaught: ${(e as Error).message}`,
    );
  });

  return res.status(202).json({ accepted: true, requestId: body.requestId });
});

// ── Job: /confirm ────────────────────────────────────────────────────────────

interface ConfirmJobBody {
  chatId: number;
  telegramUserId: number;
  orderId: string;
  requestId: string;
}

app.post("/jobs/confirm", async (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? "";
  try {
    await verifyRequest({
      body: rawBody,
      timestamp: (req.headers["x-stoa-timestamp"] as string | undefined) ?? null,
      signature: (req.headers["x-stoa-signature"] as string | undefined) ?? null,
      secret: env.ANALYZER_HMAC_SECRET,
    });
  } catch (e) {
    return res.status(401).send(`unauthorized: ${(e as Error).message}`);
  }

  const body = req.body as Partial<ConfirmJobBody>;
  if (
    typeof body.chatId !== "number" ||
    typeof body.telegramUserId !== "number" ||
    typeof body.orderId !== "string" ||
    typeof body.requestId !== "string"
  ) {
    return res.status(400).json({ error: "invalid body" });
  }

  console.log(
    `[jobs/confirm] req=${body.requestId} user=${body.telegramUserId} order=${body.orderId}`,
  );

  void runConfirmPipeline({
    cfg: env.cfg,
    db: dbc,
    chatId: body.chatId,
    telegramUserId: body.telegramUserId,
    orderId: body.orderId,
    requestId: body.requestId,
  }).catch((e: unknown) => {
    console.error(
      `[jobs/confirm] req=${body.requestId} uncaught: ${(e as Error).message}`,
    );
  });

  return res.status(202).json({ accepted: true, requestId: body.requestId });
});

app.listen(env.PORT, env.HOST, () => {
  console.log(`[stoa-analyzer] listening on ${env.HOST}:${env.PORT}`);
  console.log(`  bot internal URL: ${env.BOT_INTERNAL_URL}`);
  console.log(`  arc RPC:          ${env.cfg.ARC_TESTNET_RPC}`);
  console.log(`  StoaSettler:      ${env.cfg.STOA_SETTLER}`);
  console.log(`  x402 endpoint:    POST /api/x402/analyze`);
});
