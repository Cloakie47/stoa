/**
 * /analyze <market_url> — HMAC-signed POST to the Railway analyzer service.
 *
 * Cloudflare Workers' waitUntil has a 30-second hard cap (even on paid),
 * and the /analyze pipeline takes 30-60+ seconds (multi-agent LLM + Stoa
 * settle + IPFS upload). So this handler just enqueues the job to the
 * analyzer and returns. The analyzer runs the actual pipeline and DMs the
 * user the result via direct Telegram API call when done.
 *
 * The synchronous Telegram ack ("Starting analysis…") is sent by the bot
 * BEFORE this function runs — see src/index.ts.
 */
import { signRequest } from "../hmac.js";
import type { Env } from "../env.js";

export interface DispatchAnalyzeArgs {
  env: Env;
  chatId: number;
  telegramUserId: number;
  marketUrl: string;
  requestId: string;
}

export async function dispatchAnalyzeJob(
  args: DispatchAnalyzeArgs,
): Promise<void> {
  const { env, chatId, telegramUserId, marketUrl, requestId } = args;
  const body = JSON.stringify({
    chatId,
    telegramUserId,
    marketUrl,
    requestId,
  });
  const sigHeaders = await signRequest(body, env.ANALYZER_HMAC_SECRET);

  const res = await fetch(`${env.ANALYZER_URL.replace(/\/$/, "")}/jobs/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...sigHeaders,
    },
    body,
  });
  if (!res.ok && res.status !== 202) {
    const txt = await res.text().catch(() => "");
    throw new Error(`analyzer rejected job (HTTP ${res.status}): ${txt.slice(0, 200)}`);
  }
}
