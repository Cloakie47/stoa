/**
 * @stoa/limitless-client — thin wrapper around the Limitless Exchange
 * Programmatic API.
 *
 * Stable surface:
 *   - getMarket(slug)              → resolves Limitless market metadata
 *   - createSubAccount(name)       → mints a sub-account with a managed Privy wallet
 *   - checkAllowances(profileId)   → reads on-chain USDC + CTF approvals for a sub
 *   - retryAllowances(profileId)   → re-runs approvals if checkAllowances shows gaps
 *   - prepareOrder(args)           → builds the order DTO; with delegated_signing,
 *                                    the wrapper does NOT sign — the server signs
 *                                    via the sub-account's managed wallet at submit
 *   - submitOrder(prepared, sub)   → POSTs to /trading/order with delegated headers
 *   - getOpenOrders(profileId)     → live orders for a sub-account
 *   - cancelOrder(orderId, profile) → cancel by id
 *   - getTrades(profileId)         → fill history per sub-account
 *
 * Auth model:
 *   - HMAC-SHA256 with scoped tokens. Headers:
 *       lmts-api-key, lmts-timestamp, lmts-signature
 *   - Scopes required: trading + account_creation + delegated_signing
 *   - Partner access is gated by manual approval at help@limitless.network.
 *     This wrapper does NOT mint or apply for tokens — operator does that.
 *
 * Source: https://docs.limitless.exchange/api-reference/introduction
 */

import { createHmac } from "node:crypto";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://api.limitless.exchange";

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Bootstrap creds for a scoped Limitless partner token. Derived once by the
 * operator via the Limitless dashboard or /auth/api-tokens/derive endpoint;
 * stored in operator secrets (NOT in user state).
 */
export interface LimitlessCreds {
  /** Scoped token id (public). */
  tokenId: string;
  /** Scoped token secret (private). */
  secret: string;
}

export interface LimitlessClientConfig {
  creds: LimitlessCreds;
  /** Defaults to https://api.limitless.exchange. */
  baseUrl?: string;
  /**
   * Optional fee-rate in basis points that the SDK suggests for FOK orders.
   * Limitless defaults to 300 (3%) if omitted. Operator can override here.
   */
  defaultFeeRateBps?: number;
}

export type Side = "BUY" | "SELL";
export type OrderType = "GTC" | "FOK";

export interface MarketInfo {
  slug: string;
  question: string;
  /** Token IDs for the YES / NO outcomes (CTF tokenIds, decimal strings). */
  tokenIds: { yes?: string; no?: string };
  /** True if this is a negative-risk market (different exchange contract). */
  negRisk: boolean;
  /** YES book snapshot. */
  yesOrderbook: OrderbookSnapshot;
  /** NO book snapshot. */
  noOrderbook: OrderbookSnapshot;
}

export interface OrderbookSnapshot {
  tokenId: string;
  bestBid?: number;
  bestAsk?: number;
  mid?: number;
  topBids: Array<[number, number]>;
  topAsks: Array<[number, number]>;
}

export interface SubAccount {
  /** Limitless internal profile id; persist this per Telegram user. */
  profileId: number;
  /** On-chain Base address (managed Privy wallet in server-wallet mode). */
  account: `0x${string}`;
}

/**
 * Args accepted by prepareOrder. The Limitless SDK accepts EITHER
 * (price + size) — GTC limit orders — OR (makerAmount) — FOK market orders.
 * Discriminate via orderType.
 */
export type PrepareOrderArgs =
  | {
      orderType: "GTC";
      marketSlug: string;
      tokenId: string;
      side: Side;
      /** Price as a number 0.01–0.99 (Limitless validates the tick). */
      price: number;
      /** Outcome-token shares. */
      size: number;
      feeRateBps?: number;
    }
  | {
      orderType: "FOK";
      marketSlug: string;
      tokenId: string;
      side: Side;
      /** USDC amount to spend (BUY) or shares to sell (SELL). */
      makerAmount: number;
      feeRateBps?: number;
    };

/**
 * Output of prepareOrder. With delegated_signing scope, `signature` is empty —
 * the server signs after `submitOrder` posts. The wrapper still returns the
 * full order struct for operator inspection.
 */
export interface PreparedOrder {
  marketSlug: string;
  orderType: OrderType;
  /** Order DTO the server will sign + persist. Fields per Limitless API. */
  order: Record<string, unknown>;
  /** Human summary for logs. */
  summary: {
    side: Side;
    tokenId: string;
    price?: number;
    size?: number;
    makerAmount?: number;
    feeRateBps: number;
  };
}

export interface SubmitOrderResult {
  orderId: string;
  status: string;
  raw: unknown;
}

export interface OpenOrder {
  id: string;
  marketSlug: string;
  tokenId: string;
  side: Side;
  price: string;
  size: string;
  filled: string;
  status: string;
  createdAt: string;
  raw: unknown;
}

export interface FillRecord {
  tradeId: string;
  marketSlug: string;
  tokenId: string;
  side: Side;
  price: string;
  size: string;
  feeUsdc: string;
  matchedAt: string;
  raw: unknown;
}

// ── HMAC auth ───────────────────────────────────────────────────────────────

/**
 * Build Limitless HMAC headers per docs.
 *
 * Signature = HMAC-SHA256(secret, `${ts}|${METHOD}|${path}|${body}`).hex
 *
 * NOTE: The exact canonical-payload format is not fully spelled out in
 * Limitless's public docs at the time of writing — verify against an SDK
 * call once the partner token is provisioned. If the format differs, this
 * helper is the only place to update.
 */
function buildAuthHeaders(
  creds: LimitlessCreds,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: string,
): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = `${ts}|${method}|${path}|${body}`;
  const sig = createHmac("sha256", creds.secret).update(payload).digest("hex");
  return {
    "lmts-api-key": creds.tokenId,
    "lmts-timestamp": ts,
    "lmts-signature": sig,
  };
}

// ── Implementation ──────────────────────────────────────────────────────────

export class StoaLimitlessClient {
  readonly baseUrl: string;
  readonly defaultFeeRateBps: number;
  private readonly creds: LimitlessCreds;

  constructor(config: LimitlessClientConfig) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.creds = config.creds;
    this.defaultFeeRateBps = config.defaultFeeRateBps ?? 300;
  }

  /** Internal: authed fetch with HMAC headers. */
  private async authedFetch<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const bodyStr = body === undefined ? "" : JSON.stringify(body);
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      ...buildAuthHeaders(this.creds, method, path, bodyStr),
      ...extraHeaders,
    };
    if (method !== "GET") headers["Content-Type"] = "application/json";
    const resp = await fetch(url, {
      method,
      headers,
      body: bodyStr === "" ? undefined : bodyStr,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(
        `Limitless ${method} ${path} → ${resp.status}: ${text.slice(0, 500)}`,
      );
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  // ── Markets ───────────────────────────────────────────────────────────────

  /**
   * Resolve a Limitless market by slug. Returns YES/NO tokenIds + book snapshot.
   *
   * Public endpoint — no auth required. The HMAC headers are still sent
   * (harmless) so a single client works for everything.
   */
  async getMarket(slug: string): Promise<MarketInfo> {
    // TODO: confirm exact path. Likely /markets/${slug} or /markets?slug=.
    // The current path is a placeholder; verify when first API call runs.
    const raw = await this.authedFetch<MarketInfoRaw>(
      "GET",
      `/markets/${encodeURIComponent(slug)}`,
    );
    return {
      slug: raw.slug,
      question: raw.question,
      tokenIds: {
        yes: raw.tokens?.yes,
        no: raw.tokens?.no,
      },
      negRisk: Boolean(raw.negRisk),
      yesOrderbook: snapshotFromRaw(raw.tokens?.yes ?? "", raw.yesBook),
      noOrderbook: snapshotFromRaw(raw.tokens?.no ?? "", raw.noBook),
    };
  }

  // ── Sub-account management ───────────────────────────────────────────────

  /**
   * Create a Limitless sub-account with a managed Privy server wallet.
   * Returns { profileId, account } — persist `profileId` per Telegram user;
   * `account` is the on-chain Base address the user funds with USDC.
   *
   * Requires the `account_creation` scope on the operator token.
   */
  async createSubAccount(displayName?: string): Promise<SubAccount> {
    const body = {
      displayName: displayName ?? undefined,
      createServerWallet: true,
    };
    const resp = await this.authedFetch<{
      profileId: number;
      account: `0x${string}`;
    }>("POST", "/partner-accounts", body);
    return resp;
  }

  /** Read USDC + CTF approvals for a sub-account. */
  async checkAllowances(
    profileId: number,
  ): Promise<Array<{ kind: string; target: string; ok: boolean }>> {
    return this.authedFetch(
      "GET",
      `/partner-accounts/${profileId}/allowances`,
    );
  }

  /** Re-run approvals if checkAllowances reports gaps. */
  async retryAllowances(profileId: number): Promise<void> {
    await this.authedFetch(
      "POST",
      `/partner-accounts/${profileId}/allowances/retry`,
    );
  }

  // ── Orders (delegated-signing mode) ──────────────────────────────────────

  /**
   * Build an order DTO ready for delegated-signing submission. Does NOT sign —
   * the server signs after `submitOrder` POSTs. Returns the order struct +
   * summary so the operator/bot can show a preview before submitting.
   */
  prepareOrder(args: PrepareOrderArgs): PreparedOrder {
    const feeRateBps = args.feeRateBps ?? this.defaultFeeRateBps;
    const sideInt = args.side === "BUY" ? 0 : 1;
    const isGTC = args.orderType === "GTC";
    return {
      marketSlug: args.marketSlug,
      orderType: args.orderType,
      order: {
        tokenId: args.tokenId,
        side: sideInt,
        feeRateBps,
        ...(isGTC
          ? {
              price: args.price,
              size: args.size,
            }
          : {
              makerAmount: args.makerAmount,
            }),
        // signature / signatureType omitted — server signs.
      },
      summary: {
        side: args.side,
        tokenId: args.tokenId,
        feeRateBps,
        ...(isGTC
          ? { price: args.price, size: args.size }
          : { makerAmount: args.makerAmount }),
      },
    };
  }

  /**
   * Submit a prepared order on behalf of a sub-account. Server signs the
   * order using the sub-account's managed wallet.
   *
   * Requires the `delegated_signing` scope on the operator token.
   */
  async submitOrder(
    prepared: PreparedOrder,
    profileId: number,
  ): Promise<SubmitOrderResult> {
    const body = {
      marketSlug: prepared.marketSlug,
      orderType: prepared.orderType,
      onBehalfOf: profileId,
      order: prepared.order,
      // Idempotency: optional — recommend bot-side caller passes clientOrderId.
    };
    const resp = await this.authedFetch<{
      orderId: string;
      status: string;
      [k: string]: unknown;
    }>("POST", "/trading/order", body);
    return { orderId: resp.orderId, status: resp.status, raw: resp };
  }

  // ── Reads (operator + per-user) ───────────────────────────────────────────

  async getOpenOrders(profileId: number): Promise<OpenOrder[]> {
    const resp = await this.authedFetch<{ orders: Array<Record<string, unknown>> }>(
      "GET",
      `/trading/orders?profileId=${profileId}`,
      undefined,
      { "x-on-behalf-of": String(profileId) },
    );
    return (resp.orders ?? []).map((o) => ({
      id: String(o.id),
      marketSlug: String(o.marketSlug ?? ""),
      tokenId: String(o.tokenId ?? ""),
      side: o.side === 1 || o.side === "SELL" ? "SELL" : "BUY",
      price: String(o.price ?? ""),
      size: String(o.size ?? ""),
      filled: String(o.filled ?? "0"),
      status: String(o.status ?? "OPEN"),
      createdAt: String(o.createdAt ?? ""),
      raw: o,
    }));
  }

  async cancelOrder(orderId: string, profileId: number): Promise<void> {
    await this.authedFetch(
      "DELETE",
      `/trading/order/${encodeURIComponent(orderId)}`,
      undefined,
      { "x-on-behalf-of": String(profileId) },
    );
  }

  async getTrades(profileId: number): Promise<FillRecord[]> {
    const resp = await this.authedFetch<{ trades: Array<Record<string, unknown>> }>(
      "GET",
      `/portfolio/trades?profileId=${profileId}`,
      undefined,
      { "x-on-behalf-of": String(profileId) },
    );
    return (resp.trades ?? []).map((t) => ({
      tradeId: String(t.id ?? t.tradeId ?? ""),
      marketSlug: String(t.marketSlug ?? ""),
      tokenId: String(t.tokenId ?? ""),
      side: t.side === 1 || t.side === "SELL" ? "SELL" : "BUY",
      price: String(t.price ?? ""),
      size: String(t.size ?? ""),
      feeUsdc: String(t.feeUsdc ?? t.fee ?? "0"),
      matchedAt: String(t.matchedAt ?? t.createdAt ?? ""),
      raw: t,
    }));
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

interface MarketInfoRaw {
  slug: string;
  question: string;
  tokens?: { yes?: string; no?: string };
  negRisk?: boolean;
  yesBook?: BookRaw;
  noBook?: BookRaw;
}

interface BookRaw {
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
}

function snapshotFromRaw(tokenId: string, book?: BookRaw): OrderbookSnapshot {
  const parse = (l: { price: string; size: string }): [number, number] => [
    Number.parseFloat(l.price),
    Number.parseFloat(l.size),
  ];
  const bids = (book?.bids ?? []).map(parse).sort((a, b) => b[0] - a[0]);
  const asks = (book?.asks ?? []).map(parse).sort((a, b) => a[0] - b[0]);
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
