/**
 * /preview <market_url> — free, single-Claude-call summary. No Stoa fee,
 * no trace pin. Cheap (Haiku, ≤240 tokens) and fast (~1-2s), so it stays
 * synchronous in the Worker — no need to defer to the analyzer.
 */
import { runSingleLLMPreview } from "@stoa/bot-core";

import { toCfg, type Env } from "../env.js";

export interface PreviewArgs {
  env: Env;
  marketUrl: string;
}

export interface PreviewResult {
  message: string;
  signal_guess: string;
}

export async function handlePreview(args: PreviewArgs): Promise<PreviewResult> {
  const { env, marketUrl } = args;
  if (!isLikelyMarketUrl(marketUrl)) {
    return {
      message:
        `That doesn't look like a market URL. Try a Polymarket event/market link, e.g.\n` +
        `\`/preview https://polymarket.com/event/will-foo-bar-by-eoy\``,
      signal_guess: "PASS",
    };
  }

  const summary = await runSingleLLMPreview(toCfg(env), marketUrl);
  const tag =
    summary.signal_guess === "YES"
      ? "📈 YES"
      : summary.signal_guess === "NO"
        ? "📉 NO"
        : "⏸ PASS";

  const message =
    `*Preview* (free — one-shot summary)\n\n` +
    `${summary.one_liner}\n\n` +
    `${tag}\n\n` +
    `_Want a multi-agent analysis (News / Sentiment / Historical / Market Structure + Judge) with a Kelly-sized recommendation and an on-chain trace?_\n` +
    `Run \`/analyze ${marketUrl}\` — $0.15 USDC from your Arc balance.`;

  return { message, signal_guess: summary.signal_guess };
}

function isLikelyMarketUrl(s: string): boolean {
  return /^https?:\/\/(?:www\.)?(polymarket|limitless)\.(com|exchange)\//i.test(s);
}
