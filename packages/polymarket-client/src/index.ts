/**
 * @stoa/polymarket-client — thin wrapper around @polymarket/clob-client-v2.
 *
 * Stable surface:
 *   - getMarket(marketUrl)        → resolves Gamma slug/event → CLOB market metadata
 *   - prepareOrder(args)          → builds + signs an order, returns the signed
 *                                    order + raw EIP-712 typed data for inspection.
 *                                    Does NOT post — gives the operator a chance
 *                                    to review before submission.
 *   - submitOrder(prepared)       → POSTs the previously-prepared order to CLOB
 *   - getBuilderTrades({ after }) → fee-revenue stream attributed to our builder code
 *   - cancelOrder(orderId)        → cancel by order id
 *
 * Signing modes:
 *   - SignatureTypeV2.EOA (0) is the default — simplest path, no deposit wallet,
 *     used for the smoke test so operators can inspect the order before
 *     touching real money.
 *   - SignatureTypeV2.POLY_1271 (3) is the PRODUCTION path for InsightAgent's
 *     autonomous trades — the bot owns a smart-contract deposit wallet that
 *     validates orders via ERC-1271. Switch when ready.
 *
 * Authentication:
 *   - L1 (signer-based) is enough for read endpoints + createOrder (build+sign).
 *   - L2 (API-key) is required for postOrder, cancelOrder, getBuilderTrades.
 *     The wrapper lazily calls createOrDeriveApiKey() on first L2 access.
 */

import {
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  getContractConfig,
  type BuilderTrade,
  type BuilderTradesResponse,
  type CreateOrderOptions,
  type OrderBookSummary,
  type SignedOrder,
  type TickSize,
  type UserOrderV2,
} from "@polymarket/clob-client-v2";
import {
  createWalletClient,
  http,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const DEFAULT_HOST = "https://clob.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";

// ── Public types ────────────────────────────────────────────────────────────

export interface PolymarketClientConfig {
  /** 0x-prefixed hex private key. */
  privateKey: Hex;
  /**
   * 32-byte hex builder code (with `0x` prefix). Earns relayer fees on
   * orders attributed to your account. Get yours from
   * polymarket.com/settings?tab=builder.
   */
  builderCode?: string;
  /** CLOB host. Defaults to {@link DEFAULT_HOST}. */
  host?: string;
  /** Polygon mainnet = 137 (default). Amoy = 80002 (testing only — CLOB doesn't run there). */
  chainId?: number;
  /** Polygon RPC URL for the walletClient. Defaults to viem's public polygon transport. */
  polygonRpcUrl?: string;
  /**
   * Signature type — EOA (0) by default for the smoke-test path.
   * Switch to POLY_1271 (3) for the autonomous-deposit-wallet production path.
   */
  signatureType?: SignatureTypeV2;
  /**
   * Funder address — the wallet whose USDC backs the order. For EOA mode
   * this is the signer's own address; for POLY_1271 it's the deposit-wallet
   * smart-contract address. Defaults to the signer when omitted.
   */
  funderAddress?: `0x${string}`;
}

export interface MarketInfo {
  url: string;
  slug: string;
  conditionId: string;
  question: string;
  outcomes: string[];
  /** Token IDs for the YES/NO outcomes (binary markets). */
  tokenIds: { yes?: string; no?: string };
  /** Trading granularity — one of "0.1" / "0.01" / "0.001" / "0.0001". */
  tickSize: TickSize;
  /** True if this market uses the NegRisk CTF exchange (different contract). */
  negRisk: boolean;
  /** Current orderbook prices for the YES side. */
  yesOrderbook: OrderbookSnapshot;
  /** Current orderbook prices for the NO side. */
  noOrderbook: OrderbookSnapshot;
}

export interface OrderbookSnapshot {
  tokenId: string;
  bestBid?: number;
  bestAsk?: number;
  mid?: number;
  /** Top-3 (price, size) levels each side, as numeric tuples. */
  topBids: Array<[number, number]>;
  topAsks: Array<[number, number]>;
}

export interface PrepareOrderArgs {
  /** CLOB outcome-token id. From {@link MarketInfo.tokenIds}. */
  tokenId: string;
  side: "BUY" | "SELL";
  /** Limit price 0-1 (e.g. 0.42 for 42¢). Must respect the market's tickSize. */
  price: number;
  /** Order size in conditional tokens (1 token = $1 if it resolves true). */
  size: number;
  /** Market's tickSize — pulled from {@link MarketInfo.tickSize}. */
  tickSize: TickSize;
  /** Market's negRisk flag — pulled from {@link MarketInfo.negRisk}. */
  negRisk: boolean;
  /** Unix-seconds expiration. Defaults to 0 (no expiration; GTC). */
  expiration?: number;
}

/**
 * Output of {@link StoaPolymarketClient.prepareOrder}. The order is BUILT
 * AND SIGNED but NOT POSTED. The signature is real — anyone with this
 * struct can submit it to CLOB. Operator should inspect `typedData` to
 * confirm the field values before passing the bundle to `submitOrder`.
 */
export interface PreparedOrder {
  /** The signed order — feeds directly into submitOrder(). */
  signedOrder: SignedOrder;
  /**
   * Reconstructed EIP-712 typed data — what the signer actually signed over.
   * Use this to verify the signature corresponds to the field values you
   * see, before posting.
   */
  typedData: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: string;
    };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: "Order";
    message: Record<string, unknown>;
  };
  /** Human-readable summary for logs / smoke test output. */
  summary: {
    token_id: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    timestamp: string;
    expiration: string;
    metadata: string;
    builder: string;
    builder_code: string;
    signature_type: SignatureTypeV2;
    signature_placeholder: string;
    full_signature: string;
  };
}

// ── Implementation ───────────────────────────────────────────────────────────

// CLOB V2 EIP-712 Order struct — mirrors CTF_EXCHANGE_V2_ORDER_STRUCT in the
// SDK (clob-client-v2/dist/order-utils/model/ctfExchangeV2TypedData.js). V1's
// taker/nonce/feeRateBps/expiration were removed; timestamp/metadata/builder
// were added. `expiration` survives on the SignedOrder wire format but is
// NOT part of the EIP-712 hash.
const ORDER_EIP712_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
};
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export class StoaPolymarketClient {
  readonly host: string;
  readonly chainId: number;
  readonly signatureType: SignatureTypeV2;
  readonly builderCode?: string;
  readonly funderAddress: `0x${string}`;
  readonly signerAddress: `0x${string}`;

  private walletClient: WalletClient;
  /** Lazy-initialized read-only client (no L2 creds). */
  private _readClient: ClobClient | null = null;
  /** Lazy-initialized authed client (with L2 creds). */
  private _authedClient: ClobClient | null = null;

  constructor(config: PolymarketClientConfig) {
    this.host = config.host ?? DEFAULT_HOST;
    this.chainId = config.chainId ?? Chain.POLYGON;
    this.signatureType = config.signatureType ?? SignatureTypeV2.EOA;
    this.builderCode = config.builderCode;

    const account = privateKeyToAccount(config.privateKey);
    this.signerAddress = account.address;
    this.funderAddress = config.funderAddress ?? account.address;

    this.walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(config.polygonRpcUrl),
    });
  }

  /**
   * Lazily build a read-only ClobClient. No L2 auth, so safe to call
   * before the user has any API keys provisioned.
   */
  private getReadClient(): ClobClient {
    if (!this._readClient) {
      this._readClient = new ClobClient({
        host: this.host,
        chain: this.chainId as Chain,
        signer: this.walletClient,
        signatureType: this.signatureType,
        funderAddress: this.funderAddress,
      });
    }
    return this._readClient;
  }

  /**
   * Lazily build an L2-authed ClobClient by calling
   * createOrDeriveApiKey() on first use. Required for submitOrder,
   * cancelOrder, getBuilderTrades.
   */
  private async getAuthedClient(): Promise<ClobClient> {
    if (this._authedClient) return this._authedClient;
    const read = this.getReadClient();
    const creds = await read.createOrDeriveApiKey();
    this._authedClient = new ClobClient({
      host: this.host,
      chain: this.chainId as Chain,
      signer: this.walletClient,
      creds,
      signatureType: this.signatureType,
      funderAddress: this.funderAddress,
    });
    return this._authedClient;
  }

  /**
   * Resolve a polymarket.com URL → CLOB market metadata.
   *
   * Two paths:
   *   - /market/<slug>  → Gamma /markets?slug=<slug>
   *   - /event/<slug>  → Gamma /events?slug=<slug>, picks highest-volume sub-market
   *
   * Returns conditionId + token IDs + tick size + negRisk + orderbook snapshots
   * — enough to drive prepareOrder() without further round trips.
   */
  async getMarket(marketUrl: string): Promise<MarketInfo> {
    const slug = extractSlug(marketUrl);
    const raw = await fetchGammaMarketOrEvent(slug);

    const conditionId =
      raw.conditionId ??
      (() => {
        throw new Error(
          `Gamma market for slug=${raw.slug} has no conditionId — cannot trade.`,
        );
      })();

    const outcomes = parseArrayField<string>(raw.outcomes);
    const tokenIds = parseArrayField<string>(raw.clobTokenIds);
    const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(o));
    const noIdx = outcomes.findIndex((o) => /^no$/i.test(o));
    const yesTokenId = (yesIdx >= 0 ? tokenIds[yesIdx] : tokenIds[0]) as
      | string
      | undefined;
    const noTokenId = (noIdx >= 0 ? tokenIds[noIdx] : tokenIds[1]) as
      | string
      | undefined;
    if (!yesTokenId || !noTokenId) {
      throw new Error(
        `Market ${raw.slug} missing CLOB token IDs (yes=${yesTokenId}, no=${noTokenId}).`,
      );
    }

    const read = this.getReadClient();

    // Resolve tickSize + negRisk from CLOB (authoritative; Gamma's view can lag).
    const [tickSize, negRisk, yesBook, noBook] = await Promise.all([
      read.getTickSize(yesTokenId),
      read.getNegRisk(yesTokenId),
      read.getOrderBook(yesTokenId),
      read.getOrderBook(noTokenId),
    ]);

    return {
      url: marketUrl,
      slug: raw.slug,
      conditionId,
      question: raw.question,
      outcomes,
      tokenIds: { yes: yesTokenId, no: noTokenId },
      tickSize,
      negRisk,
      yesOrderbook: snapshotFromBook(yesTokenId, yesBook),
      noOrderbook: snapshotFromBook(noTokenId, noBook),
    };
  }

  /**
   * Build + sign an order, but do NOT post it. Returns both the signed order
   * (consumable by {@link submitOrder}) and the reconstructed EIP-712 typed
   * data for human inspection.
   */
  async prepareOrder(args: PrepareOrderArgs): Promise<PreparedOrder> {
    if (this.builderCode === undefined) {
      // Not strictly required — the order will just have empty builder code
      // and earn no fees. Warn so operators don't ship without it.
      console.warn(
        "[polymarket-client] No builderCode configured — orders won't earn relayer fees. Set POLY_BUILDER_CODE.",
      );
    }

    const read = this.getReadClient();
    const userOrder: UserOrderV2 = {
      tokenID: args.tokenId,
      price: args.price,
      size: args.size,
      side: args.side === "BUY" ? Side.BUY : Side.SELL,
      builderCode: this.builderCode,
      expiration: args.expiration ?? 0,
    };
    const options: CreateOrderOptions = {
      tickSize: args.tickSize,
      negRisk: args.negRisk,
    };

    // createOrder builds the order struct AND signs it via the wallet client.
    // It does NOT post — that requires postOrder (gated behind submitOrder).
    const signedOrder = (await read.createOrder(userOrder, options)) as SignedOrder;

    // Reconstruct the EIP-712 typed data for the operator's review.
    // Polymarket V2 uses two contracts depending on negRisk; pick the right
    // verifyingContract from the contract config.
    const contractConfig = getContractConfig(this.chainId);
    const verifyingContract = args.negRisk
      ? contractConfig.negRiskExchangeV2
      : contractConfig.exchangeV2;

    const sigField = (signedOrder as unknown as { signature: string })
      .signature;
    const fullSignature =
      typeof sigField === "string" ? sigField : String(sigField);

    const so = signedOrder as unknown as {
      salt: string;
      maker: string;
      signer: string;
      tokenId: string;
      makerAmount: string;
      takerAmount: string;
      side: number | string;
      signatureType: number;
      timestamp: string;
      metadata?: string;
      builder?: string;
      expiration?: string;
    };
    // Normalize side to the 0/1 form the SDK uses inside the EIP-712 message
    // (BUY=0, SELL=1) — matches buildOrderTypedData in exchangeOrderBuilderV2.
    const sideNumeric =
      typeof so.side === "number"
        ? so.side
        : /^buy$/i.test(String(so.side))
          ? 0
          : 1;

    const typedData = {
      domain: {
        name: "Polymarket CTF Exchange",
        version: "2",
        chainId: this.chainId,
        verifyingContract,
      },
      types: ORDER_EIP712_TYPES,
      primaryType: "Order" as const,
      message: {
        salt: so.salt,
        maker: so.maker,
        signer: so.signer,
        tokenId: so.tokenId,
        makerAmount: so.makerAmount,
        takerAmount: so.takerAmount,
        side: sideNumeric,
        signatureType: so.signatureType,
        timestamp: so.timestamp,
        metadata: so.metadata ?? ZERO_BYTES32,
        builder: so.builder ?? ZERO_BYTES32,
      },
    };

    const summary = {
      token_id: args.tokenId,
      side: args.side,
      price: args.price,
      size: args.size,
      timestamp: String(typedData.message.timestamp),
      // Wire-only — not part of the EIP-712 hash, but the SDK still posts it.
      expiration: String(so.expiration ?? "0"),
      metadata: String(typedData.message.metadata),
      builder: String(typedData.message.builder),
      builder_code: this.builderCode ?? ZERO_BYTES32,
      signature_type: this.signatureType,
      // Show first 10 + last 6 chars so the operator sees it's signed without
      // having to scan the full 132-char hex blob.
      signature_placeholder:
        fullSignature.length > 20
          ? `${fullSignature.slice(0, 10)}…${fullSignature.slice(-6)}`
          : fullSignature,
      full_signature: fullSignature,
    };

    return { signedOrder, typedData, summary };
  }

  /**
   * Submit a previously-prepared order. Gated — operator typically reviews
   * the prepared order first, then calls this with the same struct.
   */
  async submitOrder(
    prepared: PreparedOrder,
    orderType: OrderType = OrderType.GTC,
  ): Promise<{ orderId: string; raw: unknown }> {
    const authed = await this.getAuthedClient();
    const response = (await authed.postOrder(
      prepared.signedOrder,
      orderType,
    )) as { orderID?: string; orderId?: string; success?: boolean };
    const orderId =
      response.orderID ??
      response.orderId ??
      (() => {
        throw new Error(
          `postOrder returned no orderID: ${JSON.stringify(response)}`,
        );
      })();
    return { orderId, raw: response };
  }

  /**
   * Fetch trades attributed to our builder code — the revenue-stream queryable
   * source for the InsightAgent's earnings dashboard.
   */
  async getBuilderTrades(args: {
    after?: Date;
    builderCode?: string;
  } = {}): Promise<BuilderTrade[]> {
    const code = args.builderCode ?? this.builderCode;
    if (!code) {
      throw new Error(
        "getBuilderTrades requires a builderCode (pass it in or configure POLY_BUILDER_CODE).",
      );
    }
    const authed = await this.getAuthedClient();
    const params: { builder_code: string; after?: string } = {
      builder_code: code,
    };
    if (args.after) {
      params.after = String(Math.floor(args.after.getTime() / 1000));
    }
    const resp = (await authed.getBuilderTrades(
      params,
    )) as BuilderTradesResponse;
    return resp.trades;
  }

  /**
   * Cancel a previously-posted order by its orderID.
   */
  async cancelOrder(orderId: string): Promise<void> {
    const authed = await this.getAuthedClient();
    await authed.cancelOrder({ orderID: orderId });
  }
}

// ── Helpers (Gamma URL → conditionId resolution) ─────────────────────────────

interface GammaMarketRaw {
  slug: string;
  question: string;
  conditionId?: string;
  outcomes?: string | string[];
  clobTokenIds?: string | string[];
  volumeNum?: number;
  volume?: string | number;
  active?: boolean;
  closed?: boolean;
}
interface GammaEventRaw {
  slug: string;
  markets?: GammaMarketRaw[];
}

function parseArrayField<T>(field: string | T[] | undefined): T[] {
  if (!field) return [];
  if (Array.isArray(field)) return field;
  try {
    const parsed = JSON.parse(field) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseVolume(m: GammaMarketRaw): number {
  if (typeof m.volumeNum === "number") return m.volumeNum;
  if (typeof m.volume === "number") return m.volume;
  if (typeof m.volume === "string") {
    const n = Number.parseFloat(m.volume);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function extractSlug(input: string): string {
  if (!input.startsWith("http")) return input.trim();
  const url = new URL(input);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "market" && parts[1]) return parts[1];
  if (parts[0] === "event") {
    return (parts[2] ?? parts[1] ?? "").trim();
  }
  const last = parts[parts.length - 1];
  if (!last) throw new Error(`Cannot extract slug from URL: ${input}`);
  return last;
}

async function fetchGammaMarketOrEvent(slug: string): Promise<GammaMarketRaw> {
  // Try as single market first.
  const marketRes = await fetch(
    `${GAMMA}/markets?slug=${encodeURIComponent(slug)}`,
  );
  if (marketRes.ok) {
    const body = (await marketRes.json()) as GammaMarketRaw[] | GammaMarketRaw;
    const arr = Array.isArray(body) ? body : [body];
    if (arr.length > 0) return arr[0]!;
  }
  // Fall back to event lookup.
  const eventRes = await fetch(
    `${GAMMA}/events?slug=${encodeURIComponent(slug)}`,
  );
  if (!eventRes.ok) {
    throw new Error(
      `Gamma resolution failed for slug=${slug}. /markets=${marketRes.status}, /events=${eventRes.status}.`,
    );
  }
  const eventBody = (await eventRes.json()) as
    | GammaEventRaw[]
    | GammaEventRaw;
  const events = Array.isArray(eventBody) ? eventBody : [eventBody];
  if (events.length === 0 || !events[0]!.markets || events[0]!.markets!.length === 0) {
    throw new Error(`No event or markets for slug=${slug}.`);
  }
  // Pick highest-volume sub-market that's still active.
  const submarkets = events[0]!.markets!.filter(
    (m) => m.active !== false && m.closed !== true,
  );
  const sorted = (submarkets.length > 0 ? submarkets : events[0]!.markets!).slice().sort(
    (a, b) => parseVolume(b) - parseVolume(a),
  );
  const picked = sorted[0]!;
  console.log(
    `[polymarket-client] Event URL — selected highest-volume sub-market "${picked.question}" (slug=${picked.slug}, volume=$${Math.round(parseVolume(picked)).toLocaleString()})`,
  );
  return picked;
}

function snapshotFromBook(
  tokenId: string,
  book: OrderBookSummary,
): OrderbookSnapshot {
  const parseLevel = (l: { price: string; size: string }): [number, number] => {
    const price = Number.parseFloat(l.price);
    const size = Number.parseFloat(l.size);
    return [price, Math.round(price * size * 100) / 100];
  };
  const bids = book.bids.map(parseLevel).sort((a, b) => b[0] - a[0]);
  const asks = book.asks.map(parseLevel).sort((a, b) => a[0] - b[0]);
  const bestBid = bids[0]?.[0];
  const bestAsk = asks[0]?.[0];
  const mid =
    bestBid !== undefined && bestAsk !== undefined
      ? Math.round(((bestBid + bestAsk) / 2) * 10_000) / 10_000
      : undefined;
  return {
    tokenId,
    bestBid,
    bestAsk,
    mid,
    topBids: bids.slice(0, 3),
    topAsks: asks.slice(0, 3),
  };
}

// ── Re-exports from CLOB v2 (so consumers don't need to take a direct dep) ──

export {
  Chain,
  OrderType,
  Side,
  SignatureTypeV2,
  type BuilderTrade,
  type SignedOrder,
  type TickSize,
};
