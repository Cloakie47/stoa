/**
 * Wrapper around @stoa/insight-engine for use inside bot-core pipelines.
 *
 * The engine reads env via Node's `process.env`. The Worker exposes it via
 * `nodejs_compat`; the analyzer runs on Node natively. We mirror the
 * relevant secrets before each call so the engine's lazy reads find them.
 *
 * We always run with `pinOnChain: false` because trace pinning happens
 * inside `StoaSettler.settle()` (atomically with the payment). The engine
 * just computes the hash; we upload to IPFS via `uploadToIpfs` and hand
 * both to the settle() call ourselves.
 */
import { analyzeMarket, uploadToIpfs, hashTrace } from "@stoa/insight-engine";
import type { FullTrace, Signal } from "@stoa/insight-engine";

import type { BotCoreConfig } from "./config.js";

export interface SingleLLMSummary {
  signal_guess: Signal;
  one_liner: string;
  raw_text: string;
}

export interface FullAnalysis {
  trace: FullTrace;
  trace_hash: `0x${string}`;
  ipfs_cid: string | null;
  cost_usd: number;
}

function plumbEnv(cfg: BotCoreConfig): void {
  globalThis.process ??= { env: {} } as unknown as NodeJS.Process;
  globalThis.process.env ??= {} as NodeJS.ProcessEnv;
  process.env.ANTHROPIC_API_KEY = cfg.ANTHROPIC_API_KEY;
  if (cfg.PINATA_JWT) process.env.PINATA_JWT = cfg.PINATA_JWT;
}

/**
 * Full multi-agent analysis ($0.10–$0.30 in LLM costs typically — paid by
 * the operator's Anthropic key, recouped via the user-paid Stoa fee).
 *
 * Returns the FullTrace + its keccak256 hash + IPFS CID (if Pinata is
 * configured; else null). The caller passes hash + cid to StoaSettler.settle.
 */
export async function runFullAnalysis(
  cfg: BotCoreConfig,
  marketUrl: string,
  userBalanceUsdc: number,
): Promise<FullAnalysis> {
  plumbEnv(cfg);
  const result = await analyzeMarket(marketUrl, userBalanceUsdc, {
    pinOnChain: false,
  });
  const trace_hash =
    (result.trace.trace_hash as `0x${string}` | undefined) ??
    hashTrace(result.trace);
  let cid: string | null = null;
  try {
    cid = await uploadToIpfs(result.trace);
  } catch (e) {
    console.warn(`[insight] IPFS upload failed: ${(e as Error).message}`);
  }
  if (cid) result.trace.ipfs_cid = cid;
  return {
    trace: result.trace,
    trace_hash,
    ipfs_cid: cid,
    cost_usd: result.cost_usd,
  };
}

/**
 * Free /preview path — single Claude call summarizing the market. Used by
 * the Worker directly (synchronous, fast). No trace pin, no Stoa fee.
 */
export async function runSingleLLMPreview(
  cfg: BotCoreConfig,
  marketUrl: string,
): Promise<SingleLLMSummary> {
  plumbEnv(cfg);
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  const sys =
    "You are a prediction-market analyst. Given a Polymarket-style market " +
    "URL, return a one-paragraph (≤80 words) take on the question: what's " +
    "the most likely outcome, and what's the single strongest piece of " +
    "evidence pushing your guess? End with a one-line tag: SIGNAL=YES, " +
    "SIGNAL=NO, or SIGNAL=PASS.";
  const resp = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 240,
    system: sys,
    messages: [{ role: "user", content: `Market: ${marketUrl}` }],
  });
  const text =
    resp.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();
  const m = /SIGNAL=(YES|NO|PASS)\b/i.exec(text);
  const signal: Signal = m
    ? (m[1]!.toUpperCase() as Signal)
    : ("PASS" as Signal);
  return {
    signal_guess: signal,
    one_liner: text.replace(/SIGNAL=(YES|NO|PASS)\b/i, "").trim(),
    raw_text: text,
  };
}
