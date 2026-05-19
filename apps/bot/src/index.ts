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
import { Bot, InlineKeyboard, webhookCallback, type Context } from "grammy";

import { dispatchAnalyzeJob } from "./commands/analyze.js";
import { handleBalance } from "./commands/balance.js";
import { dispatchConfirmJob } from "./commands/confirm.js";
import {
  cancelPendingExportForUser,
  handleExportKeyConfirm,
  handleExportKeyStart,
} from "./commands/export_key.js";
import { handlePositions } from "./commands/positions.js";
import { handlePreview } from "./commands/preview.js";
import { handleShield } from "./commands/shield.js";
import { handleShieldedBalance } from "./commands/shielded_balance.js";
import { handleStart } from "./commands/start.js";
import { handleUnshield } from "./commands/unshield.js";
import { handleWithdraw } from "./commands/withdraw.js";
import { toCfg, type Env } from "./env.js";
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

  // Cancel any pending /export_key confirmation if the user sends ANY
  // message that is neither /export_key (which would re-open the window)
  // nor /export_key_confirm (which would consume it). Must run BEFORE the
  // command handlers so the cancellation is visible when those handlers
  // do their work. The actual command handlers proceed normally — this
  // middleware only invalidates the export-key pending state.
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    const fromId = ctx.from?.id;
    if (text && fromId !== undefined) {
      const cmd = text.split(/\s+/, 1)[0] ?? "";
      if (cmd !== "/export_key" && cmd !== "/export_key_confirm") {
        cancelPendingExportForUser(fromId);
      }
    }
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
  //
  // When STOA_USE_STABLETRUST is on, present an inline keyboard so the user
  // can choose between a public on-chain payment and a confidential one.
  // When off, dispatch directly to public flow.
  bot.command("analyze", async (ctx) => {
    const u = ctx.from;
    if (!u) return safeReply(ctx, "Missing user info.");
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return safeReply(ctx, "Missing chat info.");
    const url = ctx.match.trim();
    if (!url) return safeReply(ctx, "Usage: /analyze <market_url>");

    const requestId = newRequestId();
    const cfg = toCfg(ctx.env);

    // Flag off → straight to public dispatch.
    if (!cfg.STOA_USE_STABLETRUST) {
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
          paymentMode: "public",
        });
      } catch (e) {
        await safeReply(
          ctx,
          `❌ Couldn't reach the analyzer (request \`${requestId}\`): ${(e as Error).message}\n\nThis is an infrastructure issue, not a problem with your wallet. Retry in a moment.`,
        );
      }
      return;
    }

    // Flag on → show 2-button keyboard. The URL is stored in the bot's
    // keyboard-message text (parsed back out by the callback handler);
    // callback_data carries only `am:<requestId>:<p|s>` to stay under
    // Telegram's 64-byte callback_data cap.
    const keyboard = new InlineKeyboard()
      .text("💸 Public ($0.15)", `am:${requestId}:p`)
      .text("🔒 Confidential ($0.15)", `am:${requestId}:s`);
    await safeReply(
      ctx,
      `🧠 *Analyze* request \`${requestId}\`\nMarket: \`${url}\`\n\nChoose payment mode:`,
      { parse_mode: "Markdown", reply_markup: keyboard },
    );
  });

  // Inline-keyboard callback for /analyze mode selection.
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("am:")) return next();
    const u = ctx.from;
    const chatId = ctx.chat?.id;
    if (!u || chatId === undefined) {
      await ctx.answerCallbackQuery({ text: "Missing user/chat info." });
      return;
    }
    const parts = data.split(":");
    if (parts.length !== 3) {
      await ctx.answerCallbackQuery({ text: "Malformed callback." });
      return;
    }
    const [, requestId, modeFlag] = parts;
    const paymentMode = modeFlag === "p" ? "public" : "shielded";
    // Recover the market URL from the keyboard message text (line "Market: `<url>`").
    const text = ctx.callbackQuery.message?.text ?? "";
    const m = /Market:\s+([^\s]+)/.exec(text);
    if (!m) {
      await ctx.answerCallbackQuery({
        text: "Couldn't recover the URL — please /analyze again.",
      });
      return;
    }
    const marketUrl = m[1]!;

    await ctx.answerCallbackQuery({ text: `Dispatching ${paymentMode} mode…` });
    try {
      // Replace the keyboard with a status line so the user knows the
      // choice was committed and the buttons can no longer be tapped.
      await ctx.editMessageText(
        `🧠 *Analyze* request \`${requestId}\` — ${paymentMode} mode dispatched. Result in ~60s.`,
        { parse_mode: "Markdown" },
      );
    } catch {
      // Editing can fail if the message is too old; non-fatal.
    }

    try {
      await dispatchAnalyzeJob({
        env: ctx.env,
        chatId,
        telegramUserId: u.id,
        marketUrl,
        requestId: requestId!,
        paymentMode,
      });
    } catch (e) {
      await ctx.api.sendMessage(
        chatId,
        `❌ Couldn't reach the analyzer (request \`${requestId}\`): ${(e as Error).message}`,
        { parse_mode: "Markdown" },
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

  // ── Confidential-payment commands (experimental, feature-gated) ──────────
  // Each handler checks STOA_USE_STABLETRUST internally and returns a
  // "feature not enabled" message when off — registration is unconditional
  // so the bot doesn't return Telegram's default "command unknown" error
  // and operators can flip the flag without redeploying the Worker.
  bot.command("shield", async (ctx) => {
    const u = ctx.from;
    if (!u) return safeReply(ctx, "Missing user info.");
    const amt = Number.parseFloat(ctx.match.trim());
    try {
      const res = await handleShield({
        db: ctx.env.DB,
        env: ctx.env,
        telegramUserId: u.id,
        amountUsdc: amt,
      });
      await safeReply(ctx, res.message);
    } catch (e) {
      await safeReply(ctx, `❌ /shield failed: ${(e as Error).message}`);
    }
  });

  bot.command("unshield", async (ctx) => {
    const u = ctx.from;
    if (!u) return safeReply(ctx, "Missing user info.");
    const amt = Number.parseFloat(ctx.match.trim());
    try {
      const res = await handleUnshield({
        db: ctx.env.DB,
        env: ctx.env,
        telegramUserId: u.id,
        amountUsdc: amt,
      });
      await safeReply(ctx, res.message);
    } catch (e) {
      await safeReply(ctx, `❌ /unshield failed: ${(e as Error).message}`);
    }
  });

  bot.command("shielded_balance", async (ctx) => {
    const u = ctx.from;
    if (!u) return safeReply(ctx, "Missing user info.");
    try {
      const res = await handleShieldedBalance({
        db: ctx.env.DB,
        env: ctx.env,
        telegramUserId: u.id,
      });
      await safeReply(ctx, res.message);
    } catch (e) {
      await safeReply(
        ctx,
        `❌ /shielded_balance failed: ${(e as Error).message}`,
      );
    }
  });

  // /export_key — two-step private-key recovery. DM-only.
  bot.command("export_key", async (ctx) => {
    const u = ctx.from;
    if (!u) return safeReply(ctx, "Missing user info.");
    const chatType = ctx.chat?.type ?? "";
    const res = handleExportKeyStart({
      db: ctx.env.DB,
      env: ctx.env,
      telegramUserId: u.id,
      chatType,
    });
    await safeReply(ctx, res.message);
  });

  bot.command("export_key_confirm", async (ctx) => {
    const u = ctx.from;
    if (!u) return safeReply(ctx, "Missing user info.");
    const chatType = ctx.chat?.type ?? "";
    try {
      const res = await handleExportKeyConfirm({
        db: ctx.env.DB,
        env: ctx.env,
        telegramUserId: u.id,
        chatType,
      });
      await safeReply(ctx, res.message);
    } catch (e) {
      // Never include the underlying error message in the reply — error
      // texts from crypto failures can leak fragments of the ciphertext.
      console.warn(
        `[export_key_confirm] failed for user ${u.id}: ${(e as Error).message}`,
      );
      await safeReply(
        ctx,
        "❌ Could not export your key right now. Please retry /export_key.",
      );
    }
  });

  bot.command("help", async (ctx) => {
    const text = `Stoa InsightAgent commands:

  Wallet
  /start — create your wallet, see funding addresses
  /balance — your USDC on Arc + Base
  /export_key — recover your private key (DM only)

  Analysis
  /preview <url> — free one-shot summary
  /analyze <url> — $0.15, multi-agent analysis + trace pin
  /positions — your open orders
  /confirm <orderId> — $0.20, execute the trade (mocked v0)

  Confidential payments
  /shield <amount> — deposit USDC to shielded balance
  /unshield <amount> — withdraw shielded balance to public
  /shielded_balance — check your shielded balance

  Exit
  /withdraw <addr> <amount> — withdraw any time`;
    // Send as plain text (no parse_mode). Markdown would interpret the
    // single underscore in /export_key and /shielded_balance as italic
    // markers, stripping them on render — users would see /exportkey
    // and /shieldedbalance, which are not registered commands.
    try {
      await ctx.reply(text);
    } catch (e) {
      console.warn(`[help] reply failed: ${(e as Error).message}`);
    }
  });

  return bot;
}

async function safeReply(
  ctx: Context,
  text: string,
  extra?: Parameters<Context["reply"]>[1],
): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: "Markdown", ...(extra ?? {}) });
  } catch {
    await ctx.reply(text, extra);
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
