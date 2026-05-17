/**
 * Stoa bot — Cloudflare Workers entrypoint.
 *
 * Routes:
 *   GET  /              → health check
 *   GET  /version       → build info
 *   POST /telegram      → Telegram webhook (grammY handler)
 *   POST /internal/db   → HMAC-authed DB proxy for the Railway analyzer
 *
 * For /analyze and /confirm, the Worker enqueues a job on the analyzer via
 * HMAC-signed POST and returns immediately. The analyzer runs the pipeline
 * (30-60+ s) and DMs the user the result via direct Telegram API call.
 * Cloudflare's waitUntil has a 30-second cap; the analyzer doesn't.
 */
import { newRequestId } from "@stoa/bot-core";
import { Bot, webhookCallback, type Context } from "grammy";

import { dispatchAnalyzeJob } from "./commands/analyze.js";
import { handleBalance } from "./commands/balance.js";
import { dispatchConfirmJob } from "./commands/confirm.js";
import { handlePositions } from "./commands/positions.js";
import { handlePreview } from "./commands/preview.js";
import { handleStart } from "./commands/start.js";
import { handleWithdraw } from "./commands/withdraw.js";
import type { Env } from "./env.js";
import { handleInternalDb } from "./internal.js";
import type { ExecutionContext } from "@cloudflare/workers-types";

function makeBot(env: Env): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // Thread the Worker env into grammY's ctx BEFORE any command handlers
  // run. Order-sensitive: must come before `bot.command(...)` registrations.
  bot.use(async (ctx, next) => {
    ctx.env = env;
    await next();
  });

  bot.command("start", async (ctx) => {
    const u = ctx.from;
    if (!u) return safeReply(ctx, "Missing user info.");
    const res = await handleStart({
      db: ctx.env.DB,
      env: ctx.env,
      telegramUserId: u.id,
      telegramUsername: u.username ?? null,
    });
    await safeReply(ctx, res.message);
  });

  bot.command("preview", async (ctx) => {
    const url = ctx.match.trim();
    if (!url) return safeReply(ctx, "Usage: /preview <market_url>");
    try {
      const res = await handlePreview({ env: ctx.env, marketUrl: url });
      await safeReply(ctx, res.message);
    } catch (e) {
      await safeReply(ctx, `❌ /preview failed: ${(e as Error).message}`);
    }
  });

  // /analyze: ack synchronously, then dispatch the job to the Railway
  // analyzer. The analyzer runs the 30-60s pipeline and DMs the result.
  bot.command("analyze", async (ctx) => {
    const u = ctx.from;
    if (!u) return safeReply(ctx, "Missing user info.");
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return safeReply(ctx, "Missing chat info.");
    const url = ctx.match.trim();
    if (!url) return safeReply(ctx, "Usage: /analyze <market_url>");

    const requestId = newRequestId();
    await safeReply(
      ctx,
      `🧠 Starting analysis (request \`${requestId}\`) — result in ~60 seconds. You can leave the chat; we'll DM you when it's done.`,
    );

    try {
      await dispatchAnalyzeJob({
        env: ctx.env,
        chatId,
        telegramUserId: u.id,
        marketUrl: url,
        requestId,
      });
    } catch (e) {
      await safeReply(
        ctx,
        `❌ Couldn't reach the analyzer (request \`${requestId}\`): ${(e as Error).message}\n\nThis is an infrastructure issue, not a problem with your wallet. Retry in a moment.`,
      );
    }
  });

  // /confirm: same dispatch-and-ack pattern.
  bot.command("confirm", async (ctx) => {
    const u = ctx.from;
    if (!u) return safeReply(ctx, "Missing user info.");
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return safeReply(ctx, "Missing chat info.");
    const orderId = ctx.match.trim();
    if (!orderId) return safeReply(ctx, "Usage: /confirm <orderId>");

    const requestId = newRequestId();
    await safeReply(
      ctx,
      `🟢 Confirming order \`${orderId}\` (request \`${requestId}\`) — result in ~30 seconds.`,
    );

    try {
      await dispatchConfirmJob({
        env: ctx.env,
        chatId,
        telegramUserId: u.id,
        orderId,
        requestId,
      });
    } catch (e) {
      await safeReply(
        ctx,
        `❌ Couldn't reach the analyzer (request \`${requestId}\`): ${(e as Error).message}\n\nThis is an infrastructure issue. Retry in a moment.`,
      );
    }
  });

  bot.command("balance", async (ctx) => {
    const u = ctx.from;
    if (!u) return safeReply(ctx, "Missing user info.");
    try {
      const res = await handleBalance({
        db: ctx.env.DB,
        env: ctx.env,
        telegramUserId: u.id,
      });
      await safeReply(ctx, res.message);
    } catch (e) {
      await safeReply(ctx, `❌ /balance failed: ${(e as Error).message}`);
    }
  });

  bot.command("positions", async (ctx) => {
    const u = ctx.from;
    if (!u) return safeReply(ctx, "Missing user info.");
    try {
      const res = await handlePositions({
        db: ctx.env.DB,
        env: ctx.env,
        telegramUserId: u.id,
      });
      await safeReply(ctx, res.message);
    } catch (e) {
      await safeReply(ctx, `❌ /positions failed: ${(e as Error).message}`);
    }
  });

  bot.command("withdraw", async (ctx) => {
    const u = ctx.from;
    if (!u) return safeReply(ctx, "Missing user info.");
    const parts = ctx.match.trim().split(/\s+/);
    if (parts.length < 2) {
      return safeReply(ctx, "Usage: /withdraw <address> <amount_usdc>");
    }
    const [to, amountStr] = parts;
    const amt = Number.parseFloat(amountStr!);
    try {
      const res = await handleWithdraw({
        db: ctx.env.DB,
        env: ctx.env,
        telegramUserId: u.id,
        toAddress: to!,
        amountUsdc: amt,
      });
      await safeReply(ctx, res.message);
    } catch (e) {
      await safeReply(ctx, `❌ /withdraw failed: ${(e as Error).message}`);
    }
  });

  bot.command("help", async (ctx) =>
    safeReply(
      ctx,
      `Stoa InsightAgent commands:
/start — create your wallet, see funding addresses
/preview <url> — free one-shot summary
/analyze <url> — $0.15, multi-agent analysis + trace pin
/confirm <orderId> — $0.20, execute the trade (mocked v0)
/balance — your USDC on Arc + Base
/positions — your open orders
/withdraw <addr> <amount> — exit any time`,
    ),
  );

  return bot;
}

async function safeReply(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(text);
  }
}

// Augment grammY Context with the Worker env binding so command handlers
// can read it cleanly via ctx.env.
declare module "grammy" {
  interface Context {
    env: Env;
  }
}

export default {
  async fetch(
    req: Request,
    env: Env,
    workerCtx: ExecutionContext,
  ): Promise<Response> {
    void workerCtx; // reserved — currently no waitUntil paths
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return new Response("stoa-bot ok", { status: 200 });
    }
    if (req.method === "GET" && url.pathname === "/version") {
      return Response.json({
        name: "@stoa/bot",
        version: "0.0.1",
        commit: "dev",
      });
    }
    if (req.method === "POST" && url.pathname === "/internal/db") {
      return handleInternalDb(req, env);
    }
    if (req.method === "POST" && url.pathname === "/telegram") {
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const got = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (got !== env.TELEGRAM_WEBHOOK_SECRET) {
          return new Response("forbidden", { status: 403 });
        }
      }
      const bot = makeBot(env);
      const handle = webhookCallback(bot, "cloudflare-mod");
      return handle(req);
    }
    return new Response("not found", { status: 404 });
  },
};
