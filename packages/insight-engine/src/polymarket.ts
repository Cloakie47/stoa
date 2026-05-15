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
 * Returns spread, best bid/ask, depth at top-5 levels each side.
 */
export interface OrderbookSummary {
  best_bid?: number;
  best_ask?: number;
  spread_cents?: number;
  bid_depth_5_levels_usdc: number;
  ask_depth_5_levels_usdc: number;
  total_bid_size_usdc: number;
  total_ask_size_usdc: number;
}

export function summarizeOrderbook(book: Orderbook): OrderbookSummary {
  const parseLevel = (l: OrderbookLevel) => ({
    price: Number.parseFloat(l.price),
    size: Number.parseFloat(l.size),
  });
  // Polymarket returns bids sorted descending, asks ascending — we still
  // sort defensively in case that changes.
  const bids = book.bids
    .map(parseLevel)
    .sort((a, b) => b.price - a.price);
  const asks = book.asks
    .map(parseLevel)
    .sort((a, b) => a.price - b.price);

  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  const spreadCents =
    bestBid !== undefined && bestAsk !== undefined
      ? Math.round((bestAsk - bestBid) * 100 * 100) / 100
      : undefined;

  const sum = (levels: typeof bids, n: number) =>
    levels.slice(0, n).reduce((acc, l) => acc + l.price * l.size, 0);

  return {
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_cents: spreadCents,
    bid_depth_5_levels_usdc: Math.round(sum(bids, 5) * 100) / 100,
    ask_depth_5_levels_usdc: Math.round(sum(asks, 5) * 100) / 100,
    total_bid_size_usdc: Math.round(sum(bids, bids.length) * 100) / 100,
    total_ask_size_usdc: Math.round(sum(asks, asks.length) * 100) / 100,
  };
}
