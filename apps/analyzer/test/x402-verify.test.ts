/**
 * Unit tests for verifyPayment + ReplayCache + RateLimiter.
 *
 * Every test injects a stub VerifierClient so no Arc RPC call is made.
 * The stub returns canned receipts and blocks built by `makeReceipt` and
 * `makeTransferLog`.
 */
import { describe, expect, it } from "vitest";

import {
  TRANSFER_EVENT_TOPIC,
  makeRateLimiter,
  makeReplayCache,
  verifyPayment,
  type ReceiptLog,
  type TransactionReceipt,
  type VerifierClient,
} from "../src/x402-verify.js";

import type { Address, Hex } from "viem";

const TOKEN: Address = "0x3600000000000000000000000000000000000000";
const RECIPIENT: Address = "0x05a98a1dca17917b6e8b19306c1653fa9fc5d689";
const OTHER_ADDR: Address = "0xdeadbeef00000000000000000000000000000000";
const TX_HASH: Hex =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

const MIN_AMOUNT = 150_000n; // $0.15 in USDC micros

function padAddrTopic(addr: Address): Hex {
  return ("0x" + "0".repeat(24) + addr.slice(2).toLowerCase()) as Hex;
}

function valueData(value: bigint): Hex {
  return ("0x" + value.toString(16).padStart(64, "0")) as Hex;
}

function makeTransferLog(args: {
  token?: Address;
  from?: Address;
  to: Address;
  value: bigint;
}): ReceiptLog {
  return {
    address: args.token ?? TOKEN,
    topics: [
      TRANSFER_EVENT_TOPIC,
      padAddrTopic(args.from ?? OTHER_ADDR),
      padAddrTopic(args.to),
    ],
    data: valueData(args.value),
  };
}

function makeReceipt(args: {
  status?: "success" | "reverted";
  blockNumber?: bigint;
  logs?: ReceiptLog[];
}): TransactionReceipt {
  return {
    status: args.status ?? "success",
    blockNumber: args.blockNumber ?? 100n,
    logs: args.logs ?? [],
  };
}

function stubClient(args: {
  receipt: TransactionReceipt | null | "throw";
  blockTimestamp?: bigint;
}): VerifierClient {
  return {
    async getTransactionReceipt() {
      if (args.receipt === "throw") {
        throw new Error("TransactionReceiptNotFoundError");
      }
      return args.receipt;
    },
    async getBlock() {
      return { timestamp: args.blockTimestamp ?? 0n };
    },
  };
}

describe("verifyPayment", () => {
  const NOW_SEC = 2_000_000_000; // fixed clock for tests

  it("returns ok for a valid recent payment to the recipient", async () => {
    const replayCache = makeReplayCache({ clock: () => NOW_SEC * 1000 });
    const client = stubClient({
      receipt: makeReceipt({
        logs: [
          makeTransferLog({ to: RECIPIENT, value: MIN_AMOUNT }),
        ],
      }),
      blockTimestamp: BigInt(NOW_SEC - 30), // 30s ago
    });
    const result = await verifyPayment({
      txHash: TX_HASH,
      tokenAddress: TOKEN,
      recipient: RECIPIENT,
      minAmount: MIN_AMOUNT,
      nowSeconds: () => NOW_SEC,
      client,
      replayCache,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.received_amount).toBe(MIN_AMOUNT);
      expect(result.tx_hash).toBe(TX_HASH);
    }
  });

  it("returns tx_not_found when receipt is null", async () => {
    const client = stubClient({ receipt: null });
    const replayCache = makeReplayCache();
    const r = await verifyPayment({
      txHash: TX_HASH,
      tokenAddress: TOKEN,
      recipient: RECIPIENT,
      minAmount: MIN_AMOUNT,
      nowSeconds: () => NOW_SEC,
      client,
      replayCache,
    });
    expect(r).toEqual({ ok: false, reason: "tx_not_found" });
  });

  it("returns tx_not_confirmed when viem throws (unknown tx)", async () => {
    const client = stubClient({ receipt: "throw" });
    const replayCache = makeReplayCache();
    const r = await verifyPayment({
      txHash: TX_HASH,
      tokenAddress: TOKEN,
      recipient: RECIPIENT,
      minAmount: MIN_AMOUNT,
      nowSeconds: () => NOW_SEC,
      client,
      replayCache,
    });
    expect(r).toEqual({ ok: false, reason: "tx_not_confirmed" });
  });

  it("returns tx_failed when status=reverted", async () => {
    const client = stubClient({
      receipt: makeReceipt({ status: "reverted" }),
    });
    const replayCache = makeReplayCache();
    const r = await verifyPayment({
      txHash: TX_HASH,
      tokenAddress: TOKEN,
      recipient: RECIPIENT,
      minAmount: MIN_AMOUNT,
      nowSeconds: () => NOW_SEC,
      client,
      replayCache,
    });
    expect(r).toEqual({ ok: false, reason: "tx_failed" });
  });

  it("returns wrong_recipient when Transfer goes elsewhere", async () => {
    const client = stubClient({
      receipt: makeReceipt({
        logs: [
          makeTransferLog({ to: OTHER_ADDR, value: MIN_AMOUNT }),
        ],
      }),
      blockTimestamp: BigInt(NOW_SEC - 30),
    });
    const replayCache = makeReplayCache();
    const r = await verifyPayment({
      txHash: TX_HASH,
      tokenAddress: TOKEN,
      recipient: RECIPIENT,
      minAmount: MIN_AMOUNT,
      nowSeconds: () => NOW_SEC,
      client,
      replayCache,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("wrong_recipient");
    }
  });

  it("returns insufficient_amount when transferred < minAmount", async () => {
    const client = stubClient({
      receipt: makeReceipt({
        logs: [
          makeTransferLog({ to: RECIPIENT, value: 100_000n }), // only $0.10
        ],
      }),
      blockTimestamp: BigInt(NOW_SEC - 30),
    });
    const replayCache = makeReplayCache();
    const r = await verifyPayment({
      txHash: TX_HASH,
      tokenAddress: TOKEN,
      recipient: RECIPIENT,
      minAmount: MIN_AMOUNT,
      nowSeconds: () => NOW_SEC,
      client,
      replayCache,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("insufficient_amount");
      expect(r.received_amount).toBe(100_000n);
      expect(r.required_amount).toBe(MIN_AMOUNT);
    }
  });

  it("returns tx_too_old when block timestamp is > freshness window", async () => {
    const client = stubClient({
      receipt: makeReceipt({
        logs: [
          makeTransferLog({ to: RECIPIENT, value: MIN_AMOUNT }),
        ],
      }),
      blockTimestamp: BigInt(NOW_SEC - 600), // 10 minutes ago
    });
    const replayCache = makeReplayCache();
    const r = await verifyPayment({
      txHash: TX_HASH,
      tokenAddress: TOKEN,
      recipient: RECIPIENT,
      minAmount: MIN_AMOUNT,
      freshnessWindowSeconds: 300,
      nowSeconds: () => NOW_SEC,
      client,
      replayCache,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("tx_too_old");
      expect(r.block_age_seconds).toBe(600);
    }
  });

  it("returns replay_detected when the tx hash is already in the cache", async () => {
    const replayCache = makeReplayCache();
    replayCache.add(TX_HASH);
    const client = stubClient({
      receipt: makeReceipt({
        logs: [
          makeTransferLog({ to: RECIPIENT, value: MIN_AMOUNT }),
        ],
      }),
      blockTimestamp: BigInt(NOW_SEC - 30),
    });
    const r = await verifyPayment({
      txHash: TX_HASH,
      tokenAddress: TOKEN,
      recipient: RECIPIENT,
      minAmount: MIN_AMOUNT,
      nowSeconds: () => NOW_SEC,
      client,
      replayCache,
    });
    expect(r).toEqual({ ok: false, reason: "replay_detected" });
  });

  it("sums multiple Transfer logs to the recipient in the same tx", async () => {
    const client = stubClient({
      receipt: makeReceipt({
        logs: [
          makeTransferLog({ to: RECIPIENT, value: 80_000n }),
          makeTransferLog({ to: OTHER_ADDR, value: 9_999_999n }), // ignored
          makeTransferLog({ to: RECIPIENT, value: 75_000n }),
        ],
      }),
      blockTimestamp: BigInt(NOW_SEC - 10),
    });
    const replayCache = makeReplayCache();
    const r = await verifyPayment({
      txHash: TX_HASH,
      tokenAddress: TOKEN,
      recipient: RECIPIENT,
      minAmount: MIN_AMOUNT,
      nowSeconds: () => NOW_SEC,
      client,
      replayCache,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.received_amount).toBe(155_000n); // 80k + 75k, the OTHER_ADDR leg is excluded
    }
  });

  it("ignores Transfer events from non-USDC contracts in the same tx", async () => {
    const otherToken: Address = "0x4200000000000000000000000000000000000000";
    const client = stubClient({
      receipt: makeReceipt({
        logs: [
          // Transfer of some unrelated token to the recipient — must NOT count.
          makeTransferLog({ token: otherToken, to: RECIPIENT, value: 9_999_999n }),
        ],
      }),
      blockTimestamp: BigInt(NOW_SEC - 10),
    });
    const replayCache = makeReplayCache();
    const r = await verifyPayment({
      txHash: TX_HASH,
      tokenAddress: TOKEN,
      recipient: RECIPIENT,
      minAmount: MIN_AMOUNT,
      nowSeconds: () => NOW_SEC,
      client,
      replayCache,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("wrong_recipient");
    }
  });

  it("compares recipient case-insensitively (config might be checksummed)", async () => {
    const upperRecipient = ("0x" + RECIPIENT.slice(2).toUpperCase()) as Address;
    const client = stubClient({
      receipt: makeReceipt({
        logs: [
          makeTransferLog({ to: RECIPIENT, value: MIN_AMOUNT }),
        ],
      }),
      blockTimestamp: BigInt(NOW_SEC - 10),
    });
    const replayCache = makeReplayCache();
    const r = await verifyPayment({
      txHash: TX_HASH,
      tokenAddress: TOKEN,
      recipient: upperRecipient,
      minAmount: MIN_AMOUNT,
      nowSeconds: () => NOW_SEC,
      client,
      replayCache,
    });
    expect(r.ok).toBe(true);
  });
});

describe("makeReplayCache", () => {
  it("returns false for unknown tx hash", () => {
    const cache = makeReplayCache();
    expect(cache.has(TX_HASH)).toBe(false);
  });

  it("returns true after add() within TTL", () => {
    const cache = makeReplayCache({ ttlMs: 60_000, clock: () => 1_000 });
    cache.add(TX_HASH);
    expect(cache.has(TX_HASH)).toBe(true);
  });

  it("returns false after TTL expires", () => {
    let now = 1_000;
    const cache = makeReplayCache({ ttlMs: 60_000, clock: () => now });
    cache.add(TX_HASH);
    expect(cache.has(TX_HASH)).toBe(true);
    now = 1_000 + 60_001;
    expect(cache.has(TX_HASH)).toBe(false);
  });

  it("reap() removes expired entries", () => {
    let now = 1_000;
    const cache = makeReplayCache({ ttlMs: 60_000, clock: () => now });
    cache.add(TX_HASH);
    expect(cache.size()).toBe(1);
    now = 1_000 + 60_001;
    cache.reap();
    expect(cache.size()).toBe(0);
  });
});

describe("makeRateLimiter", () => {
  it("allows up to challengePerMinute then rejects", () => {
    const rl = makeRateLimiter({ challengePerMinute: 3, paidPerMinute: 10 });
    expect(rl.tryConsume("1.2.3.4", "challenge")).toBe(true);
    expect(rl.tryConsume("1.2.3.4", "challenge")).toBe(true);
    expect(rl.tryConsume("1.2.3.4", "challenge")).toBe(true);
    expect(rl.tryConsume("1.2.3.4", "challenge")).toBe(false);
  });

  it("paid bucket is independent of challenge bucket per key", () => {
    const rl = makeRateLimiter({ challengePerMinute: 1, paidPerMinute: 2 });
    expect(rl.tryConsume("k", "challenge")).toBe(true);
    expect(rl.tryConsume("k", "challenge")).toBe(false);
    // paid bucket still full
    expect(rl.tryConsume("k", "paid")).toBe(true);
    expect(rl.tryConsume("k", "paid")).toBe(true);
    expect(rl.tryConsume("k", "paid")).toBe(false);
  });

  it("refills linearly over a minute", () => {
    let now = 0;
    const rl = makeRateLimiter({
      challengePerMinute: 60,
      paidPerMinute: 60,
      clock: () => now,
    });
    // drain
    for (let i = 0; i < 60; i++) expect(rl.tryConsume("k", "challenge")).toBe(true);
    expect(rl.tryConsume("k", "challenge")).toBe(false);
    // 1s later, ~1 token refilled (60/min = 1/s)
    now = 1_000;
    expect(rl.tryConsume("k", "challenge")).toBe(true);
  });
});
