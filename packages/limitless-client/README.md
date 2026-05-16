# @stoa/limitless-client

Thin TypeScript wrapper around the [Limitless Exchange](https://docs.limitless.exchange/) Programmatic API for the Stoa InsightAgent Telegram bot.

## Status

**Scaffold only.** The shape mirrors `@stoa/polymarket-client` but the implementation is unverified end-to-end — Limitless's partner-access endpoint requires a manual application via `help@limitless.network` and a derived scoped token. Until that token is provisioned, the surface compiles but no live call has been executed.

See `RESEARCH_LIMITLESS.md` at repo root for the architecture context.

## Why this exists

Phase 5 of Stoa places prediction-market trades on the user's behalf via the bot. After the Polymarket V2 ERC-1271 / CLOB-side limitation was confirmed (see `NOTES.md`), Limitless became the new trading-venue choice. Its **delegated signing** model eliminates the per-user wallet management complexity that broke Polymarket — Limitless creates and manages a Privy server wallet per sub-account, so the bot never touches user keys for trading.

The Stoa revenue model is venue-agnostic: the bot charges users `$0.10` for `/analyze` and `$0.20` for `/confirm`, split via `StoaSettler` on Arc. Limitless contributes the trading rail; the revenue capture lives in Stoa's own contracts. See the relevant entry in `NOTES.md`.

## Public surface

```ts
import { StoaLimitlessClient } from "@stoa/limitless-client";

const client = new StoaLimitlessClient({
  creds: { tokenId: process.env.LMTS_TOKEN_ID!, secret: process.env.LMTS_TOKEN_SECRET! },
});

// One-time per user (on /start):
const sub = await client.createSubAccount(`tg:${telegramUserId}`);
// → { profileId: 789, account: "0xUserManagedAddrOnBase" }

// User funds 0xUserManagedAddr with USDC on Base, then we ensure allowances:
await client.retryAllowances(sub.profileId);

// Per trade (on /confirm, after Stoa-split fee clears):
const market = await client.getMarket("btc-100k-by-eoy");
const prepared = client.prepareOrder({
  orderType: "GTC",
  marketSlug: market.slug,
  tokenId: market.tokenIds.yes!,
  side: "BUY",
  price: 0.55,
  size: 10,
});
const { orderId } = await client.submitOrder(prepared, sub.profileId);
```

## Known unknowns (verify with real partner token)

1. **HMAC canonical payload format.** Currently using `${ts}|${METHOD}|${path}|${body}`. If Limitless's actual format differs (e.g., colon-separator, or method-lowercased), update `buildAuthHeaders` in `src/index.ts`.
2. **Market lookup endpoint path.** Placeholder `/markets/${slug}` — confirm against the live API.
3. **Order endpoint paths.** `/trading/order`, `/trading/orders`, `/portfolio/trades` are best-guesses derived from the sitemap. Verify and correct on first live call.
4. **Sub-account creation in EOA mode.** Server-wallet mode is what we ship in v0; the EOA-mode flow (`x-account` / `x-signing-message` / `x-signature` headers) is omitted from the wrapper for now.

## Scripts

```sh
pnpm --filter @stoa/limitless-client smoke:markets  # once we add it
```

## Future

Once the partner token is provisioned and the four "known unknowns" above are confirmed, the wrapper hardens into a real SDK. Until then: assume every method needs a live-API run before it's trusted in the bot.
