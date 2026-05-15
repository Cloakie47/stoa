/**
 * Unit tests for @stoa/polymarket-client — mocks all external IO (Gamma,
 * CLOB v2, viem signer). No real Polygon traffic. The gated integration
 * test that actually talks to Polymarket lives in e2e.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PK = ("0x" + "11".repeat(32)) as `0x${string}`;
const BUILDER = "0xff2fdfbfe161a68f0667339ab70dee79fae9a5b5880ebc16722dfb478fa9e2cf";

const YES_TOKEN = "12345678901234567890123456789012345678901234567890123456789012345";
const NO_TOKEN = "98765432109876543210987654321098765432109876543210987654321098765";
const COND_ID = "0xc0ffee00000000000000000000000000000000000000000000000000000000c0";

// Stub the entire @polymarket/clob-client-v2 import so the wrapper's
// `new ClobClient({...})` is a controllable mock.
const createOrderMock = vi.fn();
const postOrderMock = vi.fn();
const cancelOrderMock = vi.fn();
const getBuilderTradesMock = vi.fn();
const getTickSizeMock = vi.fn();
const getNegRiskMock = vi.fn();
const getOrderBookMock = vi.fn();
const getOpenOrdersMock = vi.fn();
const createOrDeriveApiKeyMock = vi.fn();

vi.mock("@polymarket/clob-client-v2", () => {
  class ClobClient {
    createOrder = createOrderMock;
    postOrder = postOrderMock;
    cancelOrder = cancelOrderMock;
    getBuilderTrades = getBuilderTradesMock;
    getTickSize = getTickSizeMock;
    getNegRisk = getNegRiskMock;
    getOrderBook = getOrderBookMock;
    getOpenOrders = getOpenOrdersMock;
    createOrDeriveApiKey = createOrDeriveApiKeyMock;
  }
  const SignatureTypeV2 = { EOA: 0, POLY_PROXY: 1, POLY_GNOSIS_SAFE: 2, POLY_1271: 3 };
  const Side = { BUY: "BUY", SELL: "SELL" };
  const OrderType = { GTC: "GTC", FOK: "FOK", GTD: "GTD", FAK: "FAK" };
  const Chain = { POLYGON: 137, AMOY: 80002 };
  const getContractConfig = (_chainId: number) => ({
    exchange: "0xE111180000d2663C0091e4f400237545B87B996B",
    negRiskAdapter: "0x0000000000000000000000000000000000000001",
    negRiskExchange: "0x0000000000000000000000000000000000000002",
    collateral: "0x0000000000000000000000000000000000000003",
    conditionalTokens: "0x0000000000000000000000000000000000000004",
    exchangeV2: "0xE111180000d2663C0091e4f400237545B87B996B",
    negRiskExchangeV2: "0xe2222d279d744050d28e00520010520000310F59",
  });
  return {
    ClobClient,
    SignatureTypeV2,
    Side,
    OrderType,
    Chain,
    getContractConfig,
  };
});

// Import AFTER the vi.mock so the wrapper sees the stubbed module.
const mod = await import("../src/index.js");
const { StoaPolymarketClient, SignatureTypeV2 } = mod;

const baseSignedOrder = {
  salt: "12345",
  maker: "0xaaaa000000000000000000000000000000000001",
  signer: "0xaaaa000000000000000000000000000000000001",
  taker: "0x0000000000000000000000000000000000000000",
  tokenId: YES_TOKEN,
  makerAmount: "1000000",
  takerAmount: "2380952",
  expiration: "0",
  nonce: "0",
  feeRateBps: "0",
  side: 0,
  signatureType: 0,
  timestamp: String(Math.floor(Date.now() / 1000)),
  metadata: "0x0000000000000000000000000000000000000000000000000000000000000000",
  builder: BUILDER,
  signature: "0xdeadbeefcafe00000000000000000000000000000000000000000000000000001b",
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  createOrderMock.mockReset();
  postOrderMock.mockReset();
  cancelOrderMock.mockReset();
  getBuilderTradesMock.mockReset();
  getTickSizeMock.mockReset();
  getNegRiskMock.mockReset();
  getOrderBookMock.mockReset();
  getOpenOrdersMock.mockReset();
  createOrDeriveApiKeyMock.mockReset();
  // Default Gamma stub: /markets returns one binary market.
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/markets?slug=")) {
      return new Response(
        JSON.stringify([
          {
            slug: "test-market",
            question: "Will X happen?",
            conditionId: COND_ID,
            outcomes: JSON.stringify(["Yes", "No"]),
            clobTokenIds: JSON.stringify([YES_TOKEN, NO_TOKEN]),
            volumeNum: 100_000,
            active: true,
            closed: false,
          },
        ]),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("StoaPolymarketClient.getMarket", () => {
  it("resolves a market URL → MarketInfo with tickSize, negRisk, orderbooks", async () => {
    getTickSizeMock.mockResolvedValue("0.01");
    getNegRiskMock.mockResolvedValue(false);
    getOrderBookMock.mockImplementation(async (tokenId: string) => ({
      market: "m",
      asset_id: tokenId,
      bids: [
        { price: "0.41", size: "500" },
        { price: "0.40", size: "1000" },
      ],
      asks: [
        { price: "0.45", size: "300" },
        { price: "0.46", size: "800" },
      ],
    }));

    const client = new StoaPolymarketClient({ privateKey: PK, builderCode: BUILDER });
    const m = await client.getMarket("https://polymarket.com/market/test-market");

    expect(m.slug).toBe("test-market");
    expect(m.conditionId).toBe(COND_ID);
    expect(m.tokenIds).toEqual({ yes: YES_TOKEN, no: NO_TOKEN });
    expect(m.tickSize).toBe("0.01");
    expect(m.negRisk).toBe(false);
    expect(m.yesOrderbook.bestBid).toBe(0.41);
    expect(m.yesOrderbook.bestAsk).toBe(0.45);
    expect(m.yesOrderbook.mid).toBe(0.43);
    expect(m.yesOrderbook.topBids).toEqual([
      [0.41, 205],
      [0.4, 400],
    ]);
  });

  it("falls back to events endpoint and picks highest-volume sub-market", async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/markets?slug=")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/events?slug=")) {
        return new Response(
          JSON.stringify([
            {
              slug: "event-x",
              markets: [
                {
                  slug: "small",
                  question: "Will A?",
                  conditionId: "0x1111",
                  outcomes: JSON.stringify(["Yes", "No"]),
                  clobTokenIds: JSON.stringify([YES_TOKEN, NO_TOKEN]),
                  volumeNum: 1_000,
                  active: true,
                  closed: false,
                },
                {
                  slug: "huge",
                  question: "Will B?",
                  conditionId: "0x2222",
                  outcomes: JSON.stringify(["Yes", "No"]),
                  clobTokenIds: JSON.stringify([YES_TOKEN, NO_TOKEN]),
                  volumeNum: 50_000,
                  active: true,
                  closed: false,
                },
              ],
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    getTickSizeMock.mockResolvedValue("0.01");
    getNegRiskMock.mockResolvedValue(false);
    getOrderBookMock.mockResolvedValue({ market: "m", asset_id: YES_TOKEN, bids: [], asks: [] });

    const client = new StoaPolymarketClient({ privateKey: PK });
    const m = await client.getMarket(
      "https://polymarket.com/event/event-x",
    );
    expect(m.slug).toBe("huge");
    expect(m.conditionId).toBe("0x2222");
  });
});

describe("StoaPolymarketClient.prepareOrder", () => {
  it("calls createOrder with the right shape and returns signed order + EIP-712 typed data", async () => {
    createOrderMock.mockResolvedValue(baseSignedOrder);

    const client = new StoaPolymarketClient({
      privateKey: PK,
      builderCode: BUILDER,
    });
    const prepared = await client.prepareOrder({
      tokenId: YES_TOKEN,
      side: "BUY",
      price: 0.42,
      size: 2.38,
      tickSize: "0.01",
      negRisk: false,
    });

    // 1. createOrder receives the V2 userOrder shape with builderCode threaded through.
    expect(createOrderMock).toHaveBeenCalledOnce();
    const [userOrder, options] = createOrderMock.mock.calls[0]!;
    expect((userOrder as { tokenID: string }).tokenID).toBe(YES_TOKEN);
    expect((userOrder as { side: string }).side).toBe("BUY");
    expect((userOrder as { price: number }).price).toBe(0.42);
    expect((userOrder as { size: number }).size).toBe(2.38);
    expect((userOrder as { builderCode: string }).builderCode).toBe(BUILDER);
    expect((options as { tickSize: string; negRisk: boolean })).toEqual({
      tickSize: "0.01",
      negRisk: false,
    });

    // 2. The returned PreparedOrder mirrors the signed order.
    expect(prepared.signedOrder).toEqual(baseSignedOrder);

    // 3. typedData has the right domain (standard CTF exchange, not negRisk).
    expect(prepared.typedData.domain.name).toBe("Polymarket CTF Exchange");
    expect(prepared.typedData.domain.chainId).toBe(137);
    expect(prepared.typedData.domain.verifyingContract).toBe(
      "0xE111180000d2663C0091e4f400237545B87B996B",
    );

    // 4. message contains the order fields we'd sign over.
    expect(prepared.typedData.message.tokenId).toBe(YES_TOKEN);
    expect(prepared.typedData.message.makerAmount).toBe("1000000");
    expect(prepared.typedData.primaryType).toBe("Order");

    // 5. summary truncates the signature into a placeholder for printing.
    expect(prepared.summary.builder_code).toBe(BUILDER);
    expect(prepared.summary.signature_type).toBe(SignatureTypeV2.EOA);
    expect(prepared.summary.signature_placeholder).toMatch(/^0x\w+…\w+$/);
    expect(prepared.summary.full_signature).toBe(baseSignedOrder.signature);
  });

  it("uses the NegRisk exchange contract when negRisk=true", async () => {
    createOrderMock.mockResolvedValue(baseSignedOrder);

    const client = new StoaPolymarketClient({
      privateKey: PK,
      builderCode: BUILDER,
    });
    const prepared = await client.prepareOrder({
      tokenId: YES_TOKEN,
      side: "BUY",
      price: 0.42,
      size: 2.38,
      tickSize: "0.01",
      negRisk: true,
    });
    expect(prepared.typedData.domain.verifyingContract).toBe(
      "0xe2222d279d744050d28e00520010520000310F59",
    );
  });

  it("DOES NOT call postOrder — prepareOrder is build-and-sign-only", async () => {
    createOrderMock.mockResolvedValue(baseSignedOrder);
    const client = new StoaPolymarketClient({ privateKey: PK, builderCode: BUILDER });
    await client.prepareOrder({
      tokenId: YES_TOKEN,
      side: "BUY",
      price: 0.5,
      size: 2,
      tickSize: "0.01",
      negRisk: false,
    });
    expect(postOrderMock).not.toHaveBeenCalled();
  });
});

describe("StoaPolymarketClient.submitOrder", () => {
  it("calls postOrder with the signed order and returns the orderId", async () => {
    createOrderMock.mockResolvedValue(baseSignedOrder);
    postOrderMock.mockResolvedValue({ orderID: "order_abc123", success: true });
    createOrDeriveApiKeyMock.mockResolvedValue({
      key: "key",
      secret: "secret",
      passphrase: "passphrase",
    });

    const client = new StoaPolymarketClient({ privateKey: PK, builderCode: BUILDER });
    const prepared = await client.prepareOrder({
      tokenId: YES_TOKEN,
      side: "BUY",
      price: 0.5,
      size: 2,
      tickSize: "0.01",
      negRisk: false,
    });
    const res = await client.submitOrder(prepared);

    expect(createOrDeriveApiKeyMock).toHaveBeenCalledOnce();
    expect(postOrderMock).toHaveBeenCalledOnce();
    expect(postOrderMock.mock.calls[0]![0]).toEqual(baseSignedOrder);
    expect(res.orderId).toBe("order_abc123");
  });
});

describe("StoaPolymarketClient.cancelOrder", () => {
  it("calls cancelOrder({orderID}) on the authed client", async () => {
    cancelOrderMock.mockResolvedValue({});
    createOrDeriveApiKeyMock.mockResolvedValue({
      key: "k",
      secret: "s",
      passphrase: "p",
    });

    const client = new StoaPolymarketClient({ privateKey: PK, builderCode: BUILDER });
    await client.cancelOrder("order_abc123");
    expect(cancelOrderMock).toHaveBeenCalledWith({ orderID: "order_abc123" });
  });
});

describe("StoaPolymarketClient.getBuilderTrades", () => {
  it("queries builder trades by builder_code (defaults to the configured one)", async () => {
    getBuilderTradesMock.mockResolvedValue({
      trades: [
        {
          id: "trade_1",
          builder_code: BUILDER,
          fee: "1000",
          feeUsdc: "0.001",
        },
      ],
      next_cursor: "",
      limit: 100,
      count: 1,
    });
    createOrDeriveApiKeyMock.mockResolvedValue({
      key: "k",
      secret: "s",
      passphrase: "p",
    });

    const client = new StoaPolymarketClient({ privateKey: PK, builderCode: BUILDER });
    const trades = await client.getBuilderTrades();
    expect(getBuilderTradesMock).toHaveBeenCalledWith({ builder_code: BUILDER });
    expect(trades).toHaveLength(1);
  });

  it("accepts an `after` Date and threads it into the request as unix seconds (string)", async () => {
    getBuilderTradesMock.mockResolvedValue({
      trades: [],
      next_cursor: "",
      limit: 100,
      count: 0,
    });
    createOrDeriveApiKeyMock.mockResolvedValue({
      key: "k",
      secret: "s",
      passphrase: "p",
    });

    const after = new Date("2026-05-15T00:00:00Z");
    const client = new StoaPolymarketClient({ privateKey: PK, builderCode: BUILDER });
    await client.getBuilderTrades({ after });
    expect(getBuilderTradesMock).toHaveBeenCalledWith({
      builder_code: BUILDER,
      after: String(Math.floor(after.getTime() / 1000)),
    });
  });

  it("throws if no builder code is configured or passed", async () => {
    const client = new StoaPolymarketClient({ privateKey: PK });
    await expect(client.getBuilderTrades()).rejects.toThrow(/builderCode/);
  });
});

describe("StoaPolymarketClient.getOpenOrders", () => {
  it("forwards the params to the SDK and returns the flat array", async () => {
    const fixture = [
      {
        id: "0xord_abc",
        status: "LIVE",
        owner: "k",
        maker_address: "0xaaaa000000000000000000000000000000000001",
        market: COND_ID,
        asset_id: YES_TOKEN,
        side: "BUY",
        original_size: "1.37",
        size_matched: "0",
        price: "0.73",
        associate_trades: [],
        outcome: "Yes",
        created_at: 1778850590,
        expiration: "0",
        order_type: "GTC",
      },
    ];
    getOpenOrdersMock.mockResolvedValue(fixture);
    createOrDeriveApiKeyMock.mockResolvedValue({
      key: "k",
      secret: "s",
      passphrase: "p",
    });

    const client = new StoaPolymarketClient({ privateKey: PK, builderCode: BUILDER });
    const orders = await client.getOpenOrders({ market: COND_ID });
    expect(getOpenOrdersMock).toHaveBeenCalledWith({ market: COND_ID });
    expect(orders).toEqual(fixture);
  });

  it("defaults params to {} when none are supplied", async () => {
    getOpenOrdersMock.mockResolvedValue([]);
    createOrDeriveApiKeyMock.mockResolvedValue({
      key: "k",
      secret: "s",
      passphrase: "p",
    });
    const client = new StoaPolymarketClient({ privateKey: PK, builderCode: BUILDER });
    const orders = await client.getOpenOrders();
    expect(getOpenOrdersMock).toHaveBeenCalledWith({});
    expect(orders).toEqual([]);
  });
});
