/**
 * Integration tests for the x402 route handler.
 *
 * Mocks: an in-memory VerifierClient that returns canned receipts, and a
 * stub runAnalysis that returns a hand-built FullAnalysis. The route is
 * exercised via direct handler invocation with mock req/res — no http
 * server, no supertest dep.
 */
import { describe, expect, it, vi } from "vitest";

import type { BotCoreConfig, FullAnalysis } from "@stoa/bot-core";
import type { Request, Response } from "express";

import { makeX402Route } from "../src/x402-route.js";
import {
  TRANSFER_EVENT_TOPIC,
  type ReceiptLog,
  type TransactionReceipt,
  type VerifierClient,
} from "../src/x402-verify.js";

import type { Hex } from "viem";

const STOA_SETTLER = "0x05a98a1dca17917b6e8b19306c1653fa9fc5d689";
const ARC_USDC = "0x3600000000000000000000000000000000000000";

const baseCfg: BotCoreConfig = {
  ARC_TESTNET_RPC: "https://rpc.testnet.arc.network",
  ARC_CHAIN_ID: "5042002",
  BASE_RPC: "https://mainnet.base.org",
  BASE_CHAIN_ID: "8453",
  ARC_USDC,
  STOA_SETTLER,
  STOA_SPLITTER: "0x0000000000000000000000000000000000000000",
  STOA_TRACEPIN: "0x0000000000000000000000000000000000000000",
  BASE_USDC: "0x0000000000000000000000000000000000000000",
  STOA_FEE_ANALYZE_USDC: "150000",
  STOA_FEE_CONFIRM_USDC: "200000",
  TELEGRAM_BOT_TOKEN: "fake",
  ANTHROPIC_API_KEY: "fake",
  WALLET_ENCRYPTION_KEY: "fake",
  OPERATOR_PRIVATE_KEY: "0x0",
  STOA_RECIPIENT_OPERATOR: "0x0",
  STOA_RECIPIENT_MAINTAINERS: "0x0",
  STOA_RECIPIENT_CANTEEN: "0x0",
  STOA_USE_STABLETRUST: false,
  FAIRBLOCK_API_URL: "https://stabletrust-api.fairblock.network",
  STABLETRUST_ARC_USDC_ADDRESS: ARC_USDC,
};

const TX_HASH: Hex =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

function padAddrTopic(addr: string): Hex {
  return ("0x" + "0".repeat(24) + addr.slice(2).toLowerCase()) as Hex;
}

function valueData(value: bigint): Hex {
  return ("0x" + value.toString(16).padStart(64, "0")) as Hex;
}

function transferLog(args: { to: string; value: bigint }): ReceiptLog {
  return {
    address: ARC_USDC,
    topics: [
      TRANSFER_EVENT_TOPIC,
      padAddrTopic("0xdeadbeef00000000000000000000000000000000"),
      padAddrTopic(args.to),
    ],
    data: valueData(args.value),
  };
}

function okReceipt(value: bigint, blockNumber = 100n): TransactionReceipt {
  return {
    status: "success",
    blockNumber,
    logs: [transferLog({ to: STOA_SETTLER, value })],
  };
}

function clientWith(receipt: TransactionReceipt | null, blockTs: bigint): VerifierClient {
  return {
    async getTransactionReceipt() {
      return receipt;
    },
    async getBlock() {
      return { timestamp: blockTs };
    },
  };
}

interface MockResponse {
  statusCode: number;
  body: unknown;
  status(code: number): MockResponse;
  json(body: unknown): MockResponse;
}

function mockReq(args: {
  body: unknown;
  headers?: Record<string, string>;
  ip?: string;
}): Request {
  const headers = args.headers ?? {};
  return {
    body: args.body,
    ip: args.ip ?? "1.2.3.4",
    socket: { remoteAddress: args.ip ?? "1.2.3.4" },
    header(name: string): string | undefined {
      const k = name.toLowerCase();
      for (const [hk, hv] of Object.entries(headers)) {
        if (hk.toLowerCase() === k) return hv;
      }
      return undefined;
    },
  } as unknown as Request;
}

function mockRes(): MockResponse {
  const self: MockResponse = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      self.statusCode = code;
      return self;
    },
    json(body: unknown) {
      self.body = body;
      return self;
    },
  };
  return self;
}

function fakeAnalysis(): FullAnalysis {
  const judge = {
    agent: "judge" as const,
    market_url: "https://polymarket.com/event/example",
    market_question: "Will example resolve YES?",
    thesis: "Recent reporting points to YES.",
    evidence: [],
    counter_arguments: "Sample size is small.",
    confidence: 73,
    signal: "NO" as const,
    reasoning: "Reasoning chain.",
    timestamp: "2026-05-20T00:00:00Z",
    model: "claude-haiku-4-5",
    token_usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    disagreement_analysis: "Agents broadly agreed.",
    agent_signals: {},
    model_probability_yes: 0.27,
    market_price_yes: 0.38,
    edge_yes: -0.11,
    edge_no: 0.11,
    kelly_fraction: 0.12,
    recommended_size_usdc: 12.0,
    ci_low: 0.2,
    ci_high: 0.34,
    outside_view_p_yes: null,
    inside_view_adjustment: null,
    status_quo_outcome: "NO" as const,
    no_scenario: { description: "Status quo holds", weight: 0.6 },
    yes_scenario: { description: "Surprise YES", weight: 0.4 },
    risk_decomposition: [],
    reevaluation_triggers: [],
    stability: "stable",
    recommendation_reason: "Edge of 11¢ favors NO at $0.38.",
  };
  return {
    trace: {
      schema_version: "stoa.insight.v1",
      market_url: "https://polymarket.com/event/example",
      market_question: "Will example resolve YES?",
      user_balance_usdc: 100,
      agent_traces: [],
      judge_trace: judge,
      final_signal: "NO",
      final_confidence: 73,
      recommended_size_usdc: 12.0,
      ipfs_cid: "QmFakeCid12345",
      total_token_usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        estimated_cost_usd: 0.04,
      },
      started_at: "2026-05-20T00:00:00Z",
      finalized_at: "2026-05-20T00:00:30Z",
    },
    trace_hash: "0xabc",
    ipfs_cid: "QmFakeCid12345",
    cost_usd: 0.04,
  };
}

const NOW_SEC = 2_000_000_000;

describe("x402 route — POST /api/x402/analyze", () => {
  it("returns 402 with full instructions when X-PAYMENT header is missing", async () => {
    const route = makeX402Route({
      cfg: baseCfg,
      client: clientWith(null, 0n),
      runAnalysis: vi.fn(),
      nowSeconds: () => NOW_SEC,
    });
    const req = mockReq({
      body: { marketUrl: "https://polymarket.com/event/example" },
    });
    const res = mockRes();
    await route.handler(req, res as unknown as Response, () => {});
    expect(res.statusCode).toBe(402);
    const body = res.body as Record<string, unknown>;
    expect(body.error).toBe("Payment required");
    expect(body.facilitator).toBe("stoa.v1");
    expect(body.amount).toBe("0.15");
    expect(body.asset).toBe("USDC");
    expect(body.chain).toBe("arc-testnet");
    expect(body.chainId).toBe(5042002);
    expect(body.recipient).toBe(STOA_SETTLER);
    expect(body.asset_address).toBe(ARC_USDC);
    expect(body.freshness_window_seconds).toBe(300);
    expect(typeof body.instructions).toBe("string");
    expect(typeof body.docs).toBe("string");
  });

  it("returns 400 when marketUrl is missing/invalid", async () => {
    const route = makeX402Route({
      cfg: baseCfg,
      client: clientWith(null, 0n),
      runAnalysis: vi.fn(),
      nowSeconds: () => NOW_SEC,
    });
    const req = mockReq({ body: { marketUrl: "not-a-url" } });
    const res = mockRes();
    await route.handler(req, res as unknown as Response, () => {});
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when X-PAYMENT header format is bad", async () => {
    const route = makeX402Route({
      cfg: baseCfg,
      client: clientWith(null, 0n),
      runAnalysis: vi.fn(),
      nowSeconds: () => NOW_SEC,
    });
    const req = mockReq({
      body: { marketUrl: "https://polymarket.com/event/example" },
      headers: { "X-PAYMENT": "0xnothex" },
    });
    const res = mockRes();
    await route.handler(req, res as unknown as Response, () => {});
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 with verdict on a valid mocked payment", async () => {
    const runAnalysis = vi.fn(async () => fakeAnalysis());
    const route = makeX402Route({
      cfg: baseCfg,
      client: clientWith(okReceipt(150_000n), BigInt(NOW_SEC - 30)),
      runAnalysis,
      nowSeconds: () => NOW_SEC,
    });
    const req = mockReq({
      body: { marketUrl: "https://polymarket.com/event/example" },
      headers: { "X-PAYMENT": TX_HASH },
    });
    const res = mockRes();
    await route.handler(req, res as unknown as Response, () => {});
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.verdict).toBe("BUY_NO");
    expect(body.confidence).toBe(0.73);
    expect(body.edge).toBe(0.11); // edge_no since verdict is BUY_NO
    expect(body.marketQuestion).toBe("Will example resolve YES?");
    expect(body.ipfs_trace).toBe("QmFakeCid12345");
    expect(body.arc_settlement_tx).toBe(TX_HASH);
    expect(body.settlement_mode).toBe("x402_public");
    expect(body.schema_version).toBe("stoa.x402.v1");
    expect(body._note).toMatch(/recommended_size_usdc/);
    expect(runAnalysis).toHaveBeenCalledOnce();
  });

  it("returns 402 with reason=replay_detected on second use of same tx", async () => {
    const runAnalysis = vi.fn(async () => fakeAnalysis());
    const route = makeX402Route({
      cfg: baseCfg,
      client: clientWith(okReceipt(150_000n), BigInt(NOW_SEC - 30)),
      runAnalysis,
      nowSeconds: () => NOW_SEC,
    });
    const headers = { "X-PAYMENT": TX_HASH };
    const body = { marketUrl: "https://polymarket.com/event/example" };

    const res1 = mockRes();
    await route.handler(mockReq({ body, headers }), res1 as unknown as Response, () => {});
    expect(res1.statusCode).toBe(200);

    const res2 = mockRes();
    await route.handler(mockReq({ body, headers }), res2 as unknown as Response, () => {});
    expect(res2.statusCode).toBe(402);
    expect((res2.body as Record<string, unknown>).reason).toBe("replay_detected");
  });

  it("returns 402 with reason=insufficient_amount on underpayment", async () => {
    const route = makeX402Route({
      cfg: baseCfg,
      client: clientWith(okReceipt(100_000n), BigInt(NOW_SEC - 30)), // $0.10 < $0.15
      runAnalysis: vi.fn(),
      nowSeconds: () => NOW_SEC,
    });
    const res = mockRes();
    await route.handler(
      mockReq({
        body: { marketUrl: "https://polymarket.com/event/example" },
        headers: { "X-PAYMENT": TX_HASH },
      }),
      res as unknown as Response,
      () => {},
    );
    expect(res.statusCode).toBe(402);
    const body = res.body as Record<string, unknown>;
    expect(body.reason).toBe("insufficient_amount");
    expect(body.received_amount).toBe("100000");
    expect(body.required_amount).toBe("150000");
  });
});
