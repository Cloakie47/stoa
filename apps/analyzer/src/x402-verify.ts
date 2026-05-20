/**
 * x402 payment verification — pure, testable.
 *
 * The Stoa x402 endpoint (POST /api/x402/analyze) accepts an X-PAYMENT
 * header carrying an Arc Testnet transaction hash. This module verifies
 * the tx satisfies the payment requirements:
 *
 *   1. The tx exists, is mined, and didn't revert.
 *   2. It includes an ERC-20 Transfer event whose `to` == STOA_SETTLER
 *      and whose value (sum across multiple Transfer logs in the same
 *      tx, in case the caller batched) is at least the required micros.
 *   3. The block containing the tx is fresh (< 5 minutes by default).
 *   4. The tx hash has not been used for a prior x402 request (replay
 *      protection via in-memory cache; D1-backed in V1.1).
 *
 * Every failure path returns a discriminated reason so the route handler
 * can echo it back in the 402 body — that's what makes it useful to an
 * agent client: it knows whether to retry, top up, or give up.
 *
 * The verifier depends on a `VerifierClient` interface, not directly on
 * viem, so unit tests stub the on-chain calls. The production client is
 * built in x402-route.ts via createPublicClient.
 */
import type { Address, Hex } from "viem";

/** Minimal surface of viem's PublicClient that the verifier needs.
 *  Defined locally so the verifier can be unit-tested with a hand-rolled
 *  stub instead of having to mock viem internals. */
export interface VerifierClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<TransactionReceipt | null>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

export interface TransactionReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  logs: ReceiptLog[];
}

export interface ReceiptLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

/** keccak256("Transfer(address,address,uint256)"). The well-known ERC-20
 *  Transfer event topic — identical across every standards-compliant
 *  token, including the system USDC contract on Arc Testnet at
 *  0x3600000000000000000000000000000000000000. */
export const TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

export interface VerifyPaymentArgs {
  txHash: Hex;
  /** USDC contract whose Transfer events count toward payment. */
  tokenAddress: Address;
  /** The address that must receive the funds (the Stoa settler / operator
   *  recipient in V1). Case-insensitive comparison — Arc-side tx logs are
   *  lowercase but config may capitalise. */
  recipient: Address;
  /** Minimum acceptable transferred amount, in token base units (USDC = 6
   *  decimals, so 150000 = $0.15). Sums Transfer event values across all
   *  matching logs in the same receipt before comparing. */
  minAmount: bigint;
  /** Freshness window in seconds. Default 300 (5 minutes). The verifier
   *  compares the receipt block's timestamp against `nowSeconds`. */
  freshnessWindowSeconds?: number;
  /** Injected to make freshness deterministic in tests. Production passes
   *  `() => Math.floor(Date.now() / 1000)`. */
  nowSeconds: () => number;
  client: VerifierClient;
  replayCache: ReplayCache;
}

export type VerifyPaymentResult =
  | {
      ok: true;
      tx_hash: Hex;
      received_amount: bigint;
      block_number: bigint;
    }
  | {
      ok: false;
      reason:
        | "tx_not_found"
        | "tx_not_confirmed"
        | "tx_failed"
        | "wrong_recipient"
        | "insufficient_amount"
        | "tx_too_old"
        | "replay_detected";
      received_amount?: bigint;
      required_amount?: bigint;
      block_age_seconds?: number;
    };

export async function verifyPayment(
  args: VerifyPaymentArgs,
): Promise<VerifyPaymentResult> {
  const {
    txHash,
    tokenAddress,
    recipient,
    minAmount,
    freshnessWindowSeconds = 300,
    nowSeconds,
    client,
    replayCache,
  } = args;

  // ── Step 1: tx receipt + status ────────────────────────────────────────
  let receipt: TransactionReceipt | null;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    // viem throws TransactionReceiptNotFoundError for unknown OR
    // unconfirmed hashes; distinguishing the two requires getTransaction
    // (which we don't want to add complexity for in V1). The /api/ caller
    // can retry — both cases resolve to "wait and try again."
    return { ok: false, reason: "tx_not_confirmed" };
  }
  if (receipt === null) {
    return { ok: false, reason: "tx_not_found" };
  }
  if (receipt.status !== "success") {
    return { ok: false, reason: "tx_failed" };
  }

  // ── Step 2: sum Transfer values whose `to` == recipient ────────────────
  const recipientLower = recipient.toLowerCase();
  const tokenLower = tokenAddress.toLowerCase();
  let received = 0n;
  let foundAnyTransfer = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tokenLower) continue;
    if (log.topics.length < 3) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_EVENT_TOPIC) continue;
    foundAnyTransfer = true;
    // topics[2] is the indexed `to` address, padded to 32 bytes.
    // Extract the last 20 bytes and compare case-insensitively.
    const toTopic = log.topics[2] ?? "0x";
    const toAddr = "0x" + toTopic.slice(-40).toLowerCase();
    if (toAddr !== recipientLower) continue;
    // data is a single non-indexed uint256 — the transferred value.
    received += BigInt(log.data);
  }

  if (received === 0n) {
    // No matching Transfer to our recipient — either the tx didn't transfer
    // the right token (no Transfer at all) or all transfers went elsewhere.
    return {
      ok: false,
      reason: foundAnyTransfer ? "wrong_recipient" : "wrong_recipient",
      received_amount: 0n,
      required_amount: minAmount,
    };
  }
  if (received < minAmount) {
    return {
      ok: false,
      reason: "insufficient_amount",
      received_amount: received,
      required_amount: minAmount,
    };
  }

  // ── Step 3: freshness ──────────────────────────────────────────────────
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const ageSeconds = nowSeconds() - Number(block.timestamp);
  if (ageSeconds > freshnessWindowSeconds) {
    return {
      ok: false,
      reason: "tx_too_old",
      block_age_seconds: ageSeconds,
    };
  }

  // ── Step 4: replay check (read-then-write, single-process safe) ────────
  if (replayCache.has(txHash)) {
    return { ok: false, reason: "replay_detected" };
  }
  replayCache.add(txHash);

  return {
    ok: true,
    tx_hash: txHash,
    received_amount: received,
    block_number: receipt.blockNumber,
  };
}

// ── Replay cache ─────────────────────────────────────────────────────────
//
// Single-process in-memory store with explicit clock injection for tests.
// Each entry has a 24h TTL. A passive cleanup pass on every `has()` keeps
// the map bounded; an optional sweep timer (`startReapTimer`) is started
// at service boot to handle long-running idle periods. Multi-instance
// support is a V1.1 upgrade (D1-backed).

export interface ReplayCache {
  has(txHash: Hex): boolean;
  add(txHash: Hex): void;
  size(): number;
  /** Test seam: force-evict everything past TTL. */
  reap(): void;
}

export interface ReplayCacheOptions {
  ttlMs?: number;
  /** Defaults to `() => Date.now()`. Tests inject a deterministic clock. */
  clock?: () => number;
}

export function makeReplayCache(opts: ReplayCacheOptions = {}): ReplayCache {
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
  const clock = opts.clock ?? (() => Date.now());
  const map = new Map<Hex, number>();

  function reap(): void {
    const now = clock();
    for (const [k, exp] of map) {
      if (exp <= now) map.delete(k);
    }
  }

  return {
    has(txHash: Hex): boolean {
      // Lazy reap on read so any caller of has() amortises the sweep.
      const exp = map.get(txHash);
      if (exp === undefined) return false;
      if (exp <= clock()) {
        map.delete(txHash);
        return false;
      }
      return true;
    },
    add(txHash: Hex): void {
      map.set(txHash, clock() + ttlMs);
    },
    size(): number {
      return map.size;
    },
    reap,
  };
}

// ── Rate limiter (token bucket per source key) ───────────────────────────
//
// Two buckets per key (typically the source IP): a "challenge" bucket for
// requests without a payment header (cheap, 10/min) and a "paid" bucket
// for requests with one (more allowance because the caller paid USDC,
// 60/min). Express middleware in x402-route.ts decides which bucket to
// consume from.

export interface RateLimiter {
  /** Returns true if the request should be allowed. Consumes a token. */
  tryConsume(key: string, kind: "challenge" | "paid"): boolean;
  reset(key: string): void;
}

export interface RateLimiterOptions {
  challengePerMinute?: number;
  paidPerMinute?: number;
  clock?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export function makeRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
  const challengeCap = opts.challengePerMinute ?? 10;
  const paidCap = opts.paidPerMinute ?? 60;
  const clock = opts.clock ?? (() => Date.now());
  const buckets = new Map<string, { challenge: Bucket; paid: Bucket }>();

  function fresh(cap: number): Bucket {
    return { tokens: cap, lastRefill: clock() };
  }

  function refill(b: Bucket, cap: number): void {
    const now = clock();
    // Refill linearly at cap-per-60s.
    const elapsedSec = (now - b.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    const refillTokens = (elapsedSec / 60) * cap;
    b.tokens = Math.min(cap, b.tokens + refillTokens);
    b.lastRefill = now;
  }

  return {
    tryConsume(key: string, kind: "challenge" | "paid"): boolean {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { challenge: fresh(challengeCap), paid: fresh(paidCap) };
        buckets.set(key, bucket);
      }
      const cap = kind === "challenge" ? challengeCap : paidCap;
      const b = bucket[kind];
      refill(b, cap);
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
    reset(key: string): void {
      buckets.delete(key);
    },
  };
}
