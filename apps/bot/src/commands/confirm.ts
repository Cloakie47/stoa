/**
 * /confirm <orderId> — HMAC-signed POST to the Railway analyzer service.
 *
 * Same waitUntil-vs-30s rationale as /analyze: the Stoa settle on Arc can
 * easily edge past Cloudflare's budget on a slow RPC round, and the real
 * Limitless leg (currently mocked) will be similar. The Worker enqueues;
 * the analyzer runs the pipeline and DMs the result.
 */
import { signRequest } from "../hmac.js";
import type { Env } from "../env.js";

export interface DispatchConfirmArgs {
  env: Env;
  chatId: number;
  telegramUserId: number;
  orderId: string;
  requestId: string;
}

export async function dispatchConfirmJob(
  args: DispatchConfirmArgs,
): Promise<void> {
  const { env, chatId, telegramUserId, orderId, requestId } = args;
  const body = JSON.stringify({
    chatId,
    telegramUserId,
    orderId,
    requestId,
  });
  const sigHeaders = await signRequest(body, env.ANALYZER_HMAC_SECRET);

  const res = await fetch(`${env.ANALYZER_URL.replace(/\/$/, "")}/jobs/confirm`, {
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
