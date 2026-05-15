/**
 * Polymarket public-read API client.
 *
 * Two upstream hosts:
 *   - Gamma API (`gamma-api.polymarket.com`) — market metadata: slug, question,
 *     outcomes, volume, end_date, token IDs. No auth.
 *   - CLOB API (`clob.polymarket.com`) — orderbook, midpoint, recent trades,
 *     price history. No auth for read endpoints.
 *
 * We do NOT need API keys here — those are only needed for order placement,
 * which lives in a separate phase. This module is read-only.
 *
 * All paths are HTTPS GET. Errors throw with descriptive messages so the
 * orchestrator can surface them in the trace.
 */

import type { MarketContext } from "./types.js";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

interface GammaMarketRaw {
  question: string;
  description?: string;
  slug: string;
  conditionId?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
  endDate?: string;
  endDateIso?: string;
  volume?: string | number;
  volumeNum?: number;
  volume24hr?: string | number;
  volume24hrNum?: number;
  active?: boolean;
  closed?: boolean;
  negRisk?: boolean;
}

interface GammaEventRaw {
  slug: string;
  title?: string;
  description?: string;
  markets?: GammaMarketRaw[];
  active?: boolean;
  closed?: boolean;
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

/**
 * Parses an array-or-stringified-array Gamma field. Gamma returns these
 * inconsistently — sometimes JSON arrays, sometimes JSON-encoded strings.
 */
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

/**
 * Parses a polymarket.com URL into its market slug.
 *
 * Supported shapes:
 *   - https://polymarket.com/market/<slug>
 *   - https://polymarket.com/event/<event-slug>/<market-slug>   (uses last segment)
 *   - https://polymarket.com/event/<event-slug>                 (event-only — falls back to event slug)
 *   - Bare slug strings (passed through unchanged)
 */
export function parsePolymarketUrl(input: string): {
  slug: string;
  eventSlug?: string;
} {
  const trimmed = input.trim();
  if (!trimmed.startsWith("http")) {
    return { slug: trimmed };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Not a valid URL: ${input}`);
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Polymarket URL has no path: ${input}`);
  }
  // /market/<slug>
  if (parts[0] === "market" && parts[1]) {
    return { slug: parts[1] };
  }
  // /event/<event-slug>[/<market-slug>]
  if (parts[0] === "event") {
    const eventSlug = parts[1];
    const marketSlug = parts[2];
    if (!eventSlug) {
      throw new Error(`Polymarket /event URL missing slug: ${input}`);
    }
    return { slug: marketSlug ?? eventSlug, eventSlug };
  }
  // Some URLs have query-only forms; fall back to the last path segment.
  const last = parts[parts.length - 1];
  if (!last) throw new Error(`Could not extract slug from URL: ${input}`);
  return { slug: last };
}

/**
 * Fetch a single market by slug from the Gamma API.
 * Returns the first match; throws if none.
 */
export async function getMarketBySlug(slug: string): Promise<GammaMarketRaw> {
  const url = `${GAMMA}/markets?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma /markets returned ${res.status} for slug=${slug}`);
  }
  const body = (await res.json()) as GammaMarketRaw[] | GammaMarketRaw;
  const arr = Array.isArray(body) ? body : [body];
  if (arr.length === 0) {
    throw new Error(`No Gamma market found for slug=${slug}`);
  }
  return arr[0]!;
}

/**
 * Fetch an event (collection of sub-markets) by slug from the Gamma API.
 * Polymarket /event/... URLs map to events; each event holds N markets, each
 * with its own YES/NO outcomes and CLOB token IDs.
 */
export async function getEventBySlug(slug: string): Promise<GammaEventRaw> {
  const url = `${GAMMA}/events?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma /events returned ${res.status} for slug=${slug}`);
  }
  const body = (await res.json()) as GammaEventRaw[] | GammaEventRaw;
  const arr = Array.isArray(body) ? body : [body];
  if (arr.length === 0) {
    throw new Error(`No Gamma event found for slug=${slug}`);
  }
  return arr[0]!;
}

function parse24hVolume(m: GammaMarketRaw): number | undefined {
  if (typeof m.volume24hrNum === "number") return m.volume24hrNum;
  if (typeof m.volume24hr === "number") return m.volume24hr;
  if (typeof m.volume24hr === "string") {
    const n = Number.parseFloat(m.volume24hr);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function buildContextFromMarketRaw(
  url: string,
  raw: GammaMarketRaw,
): MarketContext {
  const outcomes = parseArrayField<string>(raw.outcomes);
  const prices = parseArrayField<string>(raw.outcomePrices).map((p) =>
    typeof p === "string" ? Number.parseFloat(p) : (p as number),
  );
  const tokenIds = parseArrayField<string>(raw.clobTokenIds);

  // Binary market convention: outcomes[0] = "Yes", outcomes[1] = "No".
  const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(o));
  const noIdx = outcomes.findIndex((o) => /^no$/i.test(o));

  const yesTokenId = yesIdx >= 0 ? tokenIds[yesIdx] : tokenIds[0];
  const noTokenId = noIdx >= 0 ? tokenIds[noIdx] : tokenIds[1];
  const yesPrice = yesIdx >= 0 ? prices[yesIdx] : prices[0];

  return {
    url,
    slug: raw.slug,
    question: raw.question,
    description: raw.description,
    outcomes,
    current_yes_price: Number.isFinite(yesPrice) ? yesPrice : undefined,
    end_date: raw.endDateIso ?? raw.endDate,
    volume_usdc: parseVolume(raw),
    volume_24h_usdc: parse24hVolume(raw),
    condition_id: raw.conditionId,
    token_ids: {
      yes: yesTokenId,
      no: noTokenId,
    },
  };
}

/**
 * Map a polymarket.com URL → normalized {@link MarketContext}.
 *
 * Strategy:
 *   1. Try the slug as an individual market (Gamma /markets?slug=).
 *   2. If that returns nothing, try it as an event (Gamma /events?slug=) and
 *      pick the highest-volume sub-market. Logs the selection.
 *
 * This handles BOTH polymarket.com/market/<slug> (one market) and
 * polymarket.com/event/<slug> (an event containing many sub-markets).
 */
export async function fetchMarketContext(url: string): Promise<MarketContext> {
  const { slug } = parsePolymarketUrl(url);

  // 1. Try as a single market
  let marketErr: Error | null = null;
  try {
    const raw = await getMarketBySlug(slug);
    return buildContextFromMarketRaw(url, raw);
  } catch (e) {
    marketErr = e as Error;
  }

  // 2. Fall back to event
  let event: GammaEventRaw;
  try {
    event = await getEventBySlug(slug);
  } catch (eventErr) {
    throw new Error(
      `Could not resolve ${url} as either a market or an event.\n  Market lookup: ${marketErr?.message ?? "?"}\n  Event lookup: ${(eventErr as Error).message}`,
    );
  }

  if (!event.markets || event.markets.length === 0) {
    throw new Error(
      `Gamma event ${event.slug} has no sub-markets — cannot analyze.`,
    );
  }

  // Filter to active markets if any are active; otherwise fall back to all.
  const activeMarkets = event.markets.filter(
    (m) => m.active !== false && m.closed !== true,
  );
  const candidates = activeMarkets.length > 0 ? activeMarkets : event.markets;

  // Pick highest-volume sub-market.
  const sorted = [...candidates].sort((a, b) => parseVolume(b) - parseVolume(a));
  const picked = sorted[0]!;

  // Tell the caller (and surface in CI logs) which sub-market we selected.
  const others = sorted
    .slice(1, 4)
    .map((m) => `"${m.question.slice(0, 50)}" ($${Math.round(parseVolume(m)).toLocaleString()})`)
    .join(", ");
  console.log(
    `[fetchMarketContext] Event URL — ${event.markets.length} sub-markets found. Selected highest-volume: "${picked.question}" (volume=$${Math.round(parseVolume(picked)).toLocaleString()}, slug=${picked.slug}). Others in top: ${others}`,
  );

  return buildContextFromMarketRaw(url, picked);
}

interface OrderbookLevel {
  price: string;
  size: string;
}

export interface Orderbook {
  market: string;
  asset_id: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp?: string;
}

export async function getOrderbook(tokenId: string): Promise<Orderbook> {
  const url = `${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CLOB /book returned ${res.status} for token_id=${tokenId}`);
  }
  return (await res.json()) as Orderbook;
}

export async function getMidpoint(tokenId: string): Promise<number> {
  const url = `${CLOB}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `CLOB /midpoint returned ${res.status} for token_id=${tokenId}`,
    );
  }
  const body = (await res.json()) as { mid: string };
  return Number.parseFloat(body.mid);
}

export async function getLastTradePrice(tokenId: string): Promise<number> {
  const url = `${CLOB}/last-trade-price?token_id=${encodeURIComponent(tokenId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `CLOB /last-trade-price returned ${res.status} for token_id=${tokenId}`,
    );
  }
  const body = (await res.json()) as { price: string };
  return Number.parseFloat(body.price);
}

export interface PriceHistoryPoint {
  t: number; // unix seconds
  p: number; // price 0-1
}

/**
 * Returns a series of (timestamp, price) for the given token, useful for
 * the market_structure agent to see recent price trajectory.
 *
 * @param interval One of "1h", "6h", "1d", "1w", "1m", "max". Default "1d".
 */
export async function getPriceHistory(
  tokenId: string,
  interval: "1h" | "6h" | "1d" | "1w" | "1m" | "max" = "1d",
): Promise<PriceHistoryPoint[]> {
  const url = `${CLOB}/prices-history?market=${encodeURIComponent(tokenId)}&interval=${interval}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `CLOB /prices-history returned ${res.status} for token_id=${tokenId}`,
    );
  }
  const body = (await res.json()) as { history?: PriceHistoryPoint[] };
  return body.history ?? [];
}

/**
 * Compact summary of orderbook depth for the agent's tool result.
 *
 * Returns top-3 levels per side as small numeric tuples (price, size_usdc)
 * plus aggregate stats. Designed to stay small — total JSON ≈ 200-300 bytes
 * per side, so a full tool response fits well under 1KB.
 */
export interface OrderbookSummary {
  best_bid?: number;
  best_ask?: number;
  mid?: number;
  spread_cents?: number;
  /** Top-3 bid levels: [price, size_in_usdc] descending. */
  top_bids: Array<[number, number]>;
  /** Top-3 ask levels: [price, size_in_usdc] ascending. */
  top_asks: Array<[number, number]>;
  /** USDC value of top-3 levels each side. */
  bid_depth_top3_usdc: number;
  ask_depth_top3_usdc: number;
}

export function summarizeOrderbook(book: Orderbook): OrderbookSummary {
  const parseLevel = (l: OrderbookLevel): [number, number] => {
    const price = Number.parseFloat(l.price);
    const size = Number.parseFloat(l.size);
    return [price, Math.round(price * size * 100) / 100];
  };
  const bids = book.bids
    .map(parseLevel)
    .sort((a, b) => b[0] - a[0]);
  const asks = book.asks
    .map(parseLevel)
    .sort((a, b) => a[0] - b[0]);

  const bestBid = bids[0]?.[0];
  const bestAsk = asks[0]?.[0];
  const mid =
    bestBid !== undefined && bestAsk !== undefined
      ? Math.round(((bestBid + bestAsk) / 2) * 10_000) / 10_000
      : undefined;
  const spreadCents =
    bestBid !== undefined && bestAsk !== undefined
      ? Math.round((bestAsk - bestBid) * 100 * 100) / 100
      : undefined;

  const top3Bids = bids.slice(0, 3);
  const top3Asks = asks.slice(0, 3);
  const bidDepth = top3Bids.reduce((acc, [, s]) => acc + s, 0);
  const askDepth = top3Asks.reduce((acc, [, s]) => acc + s, 0);

  return {
    best_bid: bestBid,
    best_ask: bestAsk,
    mid,
    spread_cents: spreadCents,
    top_bids: top3Bids,
    top_asks: top3Asks,
    bid_depth_top3_usdc: Math.round(bidDepth * 100) / 100,
    ask_depth_top3_usdc: Math.round(askDepth * 100) / 100,
  };
}

/**
 * Compute price-change percentages from a 1-day history series WITHOUT
 * returning the raw array. The market_structure agent only needs to know
 * "what's the price doing" — directional summaries are vastly more useful
 * (and cheaper) than 100+ raw points.
 */
export interface PriceTrajectory {
  current_price?: number;
  /** Percentage move (signed) over the past hour, vs the closest point. */
  pct_change_1h?: number;
  /** Percentage move over the past 6 hours. */
  pct_change_6h?: number;
  /** Percentage move over the past 24 hours. */
  pct_change_24h?: number;
  /**
   * One-word trajectory label based on volatility and direction over the
   * trailing window. Useful for the agent's reasoning prose.
   */
  trajectory: "rising" | "falling" | "sideways" | "volatile" | "unknown";
  /** Sample size used to derive these stats. */
  num_points: number;
}

export function summarizePriceHistory(
  history: PriceHistoryPoint[],
): PriceTrajectory {
  if (history.length === 0) {
    return { trajectory: "unknown", num_points: 0 };
  }
  // History from CLOB comes in ascending time order; double-check.
  const sorted = [...history].sort((a, b) => a.t - b.t);
  const now = sorted[sorted.length - 1]!.t;
  const current = sorted[sorted.length - 1]!.p;

  const findAt = (secondsAgo: number): number | undefined => {
    const target = now - secondsAgo;
    // Find the point closest to target time, scanning backward.
    let best = sorted[0]!;
    let bestDist = Math.abs(best.t - target);
    for (const p of sorted) {
      const d = Math.abs(p.t - target);
      if (d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    // Only return if the closest sample is within 50% of the desired window
    // (otherwise the comparison is meaningless — e.g. asking for 1h ago but
    // only having a 6h-old data point).
    if (bestDist > secondsAgo * 0.5 && secondsAgo > 0) return undefined;
    return best.p;
  };

  const pct = (then: number | undefined): number | undefined => {
    if (then === undefined || then === 0) return undefined;
    return Math.round(((current - then) / then) * 10_000) / 100;
  };

  const c1h = pct(findAt(3_600));
  const c6h = pct(findAt(21_600));
  const c24h = pct(findAt(86_400));

  // Trajectory heuristic: look at recent direction and dispersion.
  let trajectory: PriceTrajectory["trajectory"] = "sideways";
  if (c24h !== undefined) {
    const minP = Math.min(...sorted.map((p) => p.p));
    const maxP = Math.max(...sorted.map((p) => p.p));
    const range = maxP - minP;
    if (range > 0.15 && Math.abs(c24h) < 5) trajectory = "volatile";
    else if (c24h > 3) trajectory = "rising";
    else if (c24h < -3) trajectory = "falling";
    else trajectory = "sideways";
  }

  return {
    current_price:
      current !== undefined
        ? Math.round(current * 10_000) / 10_000
        : undefined,
    pct_change_1h: c1h,
    pct_change_6h: c6h,
    pct_change_24h: c24h,
    trajectory,
    num_points: sorted.length,
  };
}

/**
 * Trade snapshot from Polymarket's data-api. Public, no auth. Only the
 * fields we use are typed — the upstream returns more.
 */
interface DataApiTrade {
  /** USDC notional of the trade — `size` * `price`. */
  size?: number;
  price?: number;
  taker?: string;
  maker?: string;
  side?: string;
  timestamp?: number;
}

export interface FlowSummary {
  /** Trades fetched (we cap at /trades?limit=N). */
  trade_count_sampled: number;
  /** Notional sum across the sampled trades, USDC. */
  notional_total_usdc: number;
  /** Trades whose notional exceeded $1000. */
  large_trade_count_over_1000_usdc: number;
  /** Largest single-trade notional in the sample. */
  largest_trade_usdc?: number;
  /** Trailing 24h volume — pulled from Gamma metadata, not the trades feed. */
  volume_24h_usdc?: number;
  /** Note if the trades endpoint was unreachable. */
  trades_endpoint_error?: string;
}

/**
 * Pull recent trades for a market via the data-api. Best-effort: if the
 * endpoint errors, returns a partial FlowSummary with `trades_endpoint_error`
 * populated so the agent's trace records that flow data was unavailable.
 *
 * @param conditionId The market's CTF conditionId (Gamma `conditionId` field).
 * @param limit How many recent trades to sample.
 */
export async function getFlowSummary(
  conditionId: string,
  limit = 50,
): Promise<FlowSummary> {
  const url = `https://data-api.polymarket.com/trades?market=${encodeURIComponent(conditionId)}&limit=${limit}&takerOnly=true`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return {
        trade_count_sampled: 0,
        notional_total_usdc: 0,
        large_trade_count_over_1000_usdc: 0,
        trades_endpoint_error: `data-api /trades returned ${res.status}`,
      };
    }
    const body = (await res.json()) as DataApiTrade[];
    const trades = Array.isArray(body) ? body : [];
    let notional = 0;
    let largeCount = 0;
    let largest = 0;
    for (const t of trades) {
      if (typeof t.size !== "number" || typeof t.price !== "number") continue;
      const usdc = t.size * t.price;
      notional += usdc;
      if (usdc > 1000) largeCount++;
      if (usdc > largest) largest = usdc;
    }
    return {
      trade_count_sampled: trades.length,
      notional_total_usdc: Math.round(notional * 100) / 100,
      large_trade_count_over_1000_usdc: largeCount,
      largest_trade_usdc:
        largest > 0 ? Math.round(largest * 100) / 100 : undefined,
    };
  } catch (e) {
    return {
      trade_count_sampled: 0,
      notional_total_usdc: 0,
      large_trade_count_over_1000_usdc: 0,
      trades_endpoint_error: `data-api fetch threw: ${(e as Error).message}`,
    };
  }
}
