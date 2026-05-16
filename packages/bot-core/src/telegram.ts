/**
 * Direct Telegram Bot API client used for follow-up messages from inside the
 * analyzer's deferred jobs (after the original webhook has already returned).
 *
 * The grammY context only lives for the duration of the webhook; bot-core
 * pipelines always send via this raw fetch path so they don't depend on it.
 */

export type ParseMode = "Markdown" | "HTML";

/**
 * Send a single message. If `parseMode` is set and Telegram rejects with 400
 * (typically unbalanced backticks/asterisks), retries once as plain text so
 * the user always sees *something*.
 *
 * Errors after the retry are logged but do not throw — the caller is past
 * the point where an exception could be surfaced to the user.
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: number,
  text: string,
  parseMode: ParseMode | undefined = "Markdown",
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.ok) return;

  if (parseMode) {
    const retry = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (retry.ok) return;
    console.error(
      `[telegram] sendMessage retry failed: ${retry.status} ${await retry.text()}`,
    );
    return;
  }

  console.error(
    `[telegram] sendMessage failed: ${res.status} ${await res.text()}`,
  );
}

/**
 * Generate a short request ID (6 hex chars) for tagging async tasks so the
 * user can correlate the immediate ack with the eventual follow-up.
 */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
