# RESEARCH_LIMITLESS.md

> **2026-05-16 — DECISION: Option A locked, with strategic reframe.** Phase 5 ships against Limitless on Base. Revenue capture is **Stoa-routed**, not venue-side. The bot charges users two Stoa-split micropayments per trade flow:
>
> - `/analyze` → **$0.10 USDC** (split 0.07 operator / 0.02 maintainers / 0.01 Canteen pool)
> - `/confirm` → **$0.20 USDC** (split 0.14 / 0.04 / 0.02; same recipients)
>
> Both flow through the existing `stoa-split-evm` scheme on Arc testnet via `StoaSettler` (already deployed at `0x114942B5FeebFDf9F1FA2F161eA9C2A1754C407F`). The `/confirm` split executes **atomically before** the Limitless `delegatedOrders.createOrder` call — if the split fails, the trade does not happen; if the trade fails post-split, the fee is **non-refundable in v0** (revert flow is post-hackathon polish, document as a known limitation in the bot's onboarding text).
>
> **Why this is stronger than chasing venue-side revenue:**
> - Polymarket builder fees would be inaccessible until 2026-05-22 (cooldown). Limitless has no on-chain builder fees at all.
> - Stoa-routed execution fees are **venue-agnostic** — every user interaction produces a verifiable on-chain Arc tx through contracts *we* control. That's a stronger demo artifact than waiting on third-party platform programs.
> - The Stoa Splitter gets exercised on real Arc USDC for every trade — pure dogfooding of our own primitive.
>
> **Updated Phase 5 plan (locked):**
> 1. **Operator sends partner-access email** to `help@limitless.network` today. Code work does not block on this — if approval lags past the hackathon window, fall back to a single operator partner account placing trades on behalf of all users (acceptable trade-off because revenue isn't venue-side).
> 2. Build `packages/limitless-client/` — minimal SDK wrapper around delegated-signing API; mirror the `polymarket-client` surface shape for consistency.
> 3. Build `apps/bot/` — Cloudflare Workers + grammY + D1. **Wallets: DIY viem-generated EOAs per user, NOT Circle developer-controlled wallets.** (Circle mainnet wallet provisioning requires KYB we can't satisfy in 9 days, and the rest of our Circle product surface — Arc, Paymaster, CCTP, USYC, Bridge — still ships, so the "uses 7+ Circle products" narrative survives.)
> 4. Skip a Limitless spike-first step. Build directly. The docs are detailed enough that the unknowns are smaller than Polymarket V2's turned out to be.
> 5. **Time-box: 2 days for limitless-client + bot scaffold + two Stoa-routed payment flows + ≥1 end-to-end demo trade. Then 2-3 days real users. Then submission (deadline 2026-05-25).**
>
> The Polymarket V2 finding (below + in NOTES.md) stays documented for the **$500 Feedback Incentive** submission. We don't delete it; it's a genuine technical contribution to the V2 SDK + CLOB ecosystem.
>
> Sections below are the pre-decision research that led to this conclusion. Treat them as supporting evidence; the locked plan is the block above.

---

**Date:** 2026-05-16
**Time spent:** ~35 min (within the 45-min time-box)
**Context:** Polymarket V2 spike confirmed CLOB does not accept ERC-1271 for L1 auth (see NOTES.md top entry). Pivoting Phase 5's trading venue. Evaluating Limitless Exchange on Base as the replacement.

---

## TL;DR

**Limitless is a technically clean fit and a weak revenue fit.**

- ✅ **Technical fit (strong):** First-class delegated signing via server-managed Privy wallets eliminates every Phase-5 wallet-management pain we hit on Polymarket. No proxy contracts, no ERC-1271 envelopes, no L1 attestation gymnastics. The bot creates a sub-account, USDC sits in a managed address, the API server signs orders. Two lines of SDK code per trade.
- ❌ **Revenue fit (weak):** There is no on-chain builder/referral field in Limitless's Order struct, no USDC-denominated partner-fee share, and no documented API parameter that attaches a partner's referral code to orders the partner submits on behalf of sub-accounts. The retail referral program rewards in **LMT tokens / points** (pre-token, not yet liquid) for *user-to-user invites via web-app URL codes* — a structurally different program from "programmatic partner earns on user trades."
- ⚠️ **Operational gate:** Programmatic API access requires a **partner application via email** (`help@limitless.network`) before scoped tokens can be derived. Not self-serve. Latency unknown — could be hours or days.

**Recommendation:** Limitless replaces Polymarket on the *trading* leg cleanly. But the hackathon's "real revenue capture from order flow" story dies on Limitless — there's no equivalent of Polymarket's `builderCode`. Revenue capture in Phase 5 collapses to the **`/analyze` $0.10 fee** path that Modification 2 already covered. The Stoa Splitter still gets exercised on real on-chain USDC, just from `/analyze` fees rather than from trading-fee rebates. Trade-off is in the demo narrative ("Stoa captures % of every trade" → "Stoa is paid for the analysis itself, trading is free"), not in the architecture.

If we want order-flow revenue capture *and* a Phase-5 trading venue, neither Polymarket V2 (blocked by CLOB ERC-1271 gap) nor Limitless (no programmatic referral) solves the full problem today. The next venues to investigate are **Myriad Markets** (Linea/Polygon) and **Drift BET** (Solana), flagged below — but only if you want to push on that thread.

---

## What Limitless is

| Attribute | Value |
|---|---|
| Chain | **Base** (chainId 8453) |
| Asset | **USDC** (native — `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) |
| Market structure | **CLOB** (also has AMM markets for some shares) |
| Order types | GTC, FOK |
| Settlement model | Conditional Token Framework — YES/NO shares fully collateralized 1:1 with USDC, winners pay $1.00 |
| Architecture | **Polymarket V1 fork** (Limitless CTF Exchange v1/v2/v3 + NegRisk variants) |
| Token | LMT (pre-token; airdrop / IDO phase) |
| API base URL | `https://api.limitless.exchange` |
| WebSocket | `wss://ws.limitless.exchange` |
| SDKs | TypeScript, Python, Go, Rust (official) |

Source: [Limitless API Reference](https://docs.limitless.exchange/api-reference/introduction), [Smart Contracts](https://docs.limitless.exchange/user-guide/smart-contracts).

---

## Q1 — Builder code / referral attribution program?

**On-chain (Order struct): NO.**

The Limitless Order struct has 12 fields — `salt, maker, signer, taker, tokenId, makerAmount, takerAmount, expiration, nonce, feeRateBps, side, signatureType`. **No `builder` / `referral` / `feeRecipient` field.** Source: [EIP-712 Order Signing](https://docs.limitless.exchange/developers/eip712-signing).

The contract list at [Smart Contracts](https://docs.limitless.exchange/user-guide/smart-contracts) has no referral router, builder router, or attribution router. Only exchange/settlement contracts.

**Off-chain (programs that exist):**

1. **Retail referral program** (web-app, points/LMT): users share their personal referral link. Referrer earns "a portion of the trading + LP LMT" of referred users. Bonus: 6% if you refer 5+ users. Source: [Limitless GitBook — Referrals](https://limitless.gitbook.io/limitless/incentives-and-tokenomics/referrals). **This program is not programmatic** — there's no documented API parameter to attach a partner's referral code to orders submitted on behalf of partner sub-accounts.
2. **Partner program** (programmatic API): the API surface partners get access to is operational (sub-account creation, delegated signing, allowance management, withdrawals). **No partner-fee endpoints documented** at the [Partner Accounts](https://docs.limitless.exchange/api-reference/partner-accounts/create-partner-account) reference. The [Programmatic API guide](https://docs.limitless.exchange/developers/programmatic-api) does not mention partner fees, revenue share, or commissions. Sub-accounts are children of the partner profile, but there is no documented mechanism that says "this partner earns N bps on every sub-account trade."

**Conclusion:** Today, the bot operator has no documented path to earn revenue from order-flow on Limitless. The retail referral exists for user→user invites only. If we want order-flow revenue we'd need to negotiate a custom partnership directly with Limitless (out-of-band) — latency and acceptance unknown.

---

## Q2 — Signature scheme & smart-wallet compatibility?

**EIP-712 over the Limitless CTF Exchange domain. EOA-first; smart-wallet undocumented.**

EIP-712 domain (from docs):
```json
{
  "name": "Limitless CTF Exchange",
  "version": "1",
  "chainId": 8453,
  "verifyingContract": "<exchange contract address — Simple v3 = 0x05c748...23fa5; NegRisk v3 = 0xe3E0...5C47>"
}
```

Order struct fields (`Order`): `salt, maker, signer, taker, tokenId, makerAmount, takerAmount, expiration, nonce, feeRateBps, side, signatureType`. This is the **Polymarket V1 schema** — V1's `feeRateBps` is back, V2's `timestamp/metadata/builder` are absent.

`signatureType`: documented values 0 (EOA). The schema reserves 0-3 but the docs only specify EOA. **No ERC-1271 / ERC-7739 specifics documented.** If we use delegated signing, the documentation says the server "handles EIP-712 signing for you via managed wallets" — meaning Privy server wallets sign as EOAs server-side, and we never see the signature.

`signer == maker` for EOA wallets. The 12-field schema with `signer != maker` is *technically* expressible but undocumented as a usage pattern — we'd be guessing what works.

**Implication for our use case:** delegated signing solves the problem differently than POLY_1271. Instead of "EOA owns smart wallet, smart wallet signs via ERC-1271," it's "Limitless server holds an EOA on behalf of the user, EOA signs orders directly." Simpler protocol; trade-off is custodial — the server holds the user's keys (under Privy's managed-wallets infrastructure).

---

## Q3 — API key / auth model?

**HMAC-SHA256 with scoped tokens. Three scopes; partner approval gated.**

Source: [API Reference — Introduction](https://docs.limitless.exchange/api-reference/introduction), [Programmatic API](https://docs.limitless.exchange/developers/programmatic-api), [API Token Capabilities](https://docs.limitless.exchange/api-reference/api-tokens/get-capabilities).

**Headers (every authenticated request):**
- `lmts-api-key` — the token's public ID
- `lmts-timestamp` — Unix seconds
- `lmts-signature` — HMAC-SHA256 of canonical request signed with token's secret

(Legacy `X-API-Key` exists for older integrations but isn't issued for new accounts.)

**Scopes** (3 available, partner-controlled which are granted):
- `trading` — submit/cancel orders, read portfolio
- `account_creation` — create partner sub-accounts
- `delegated_signing` — submit orders on behalf of sub-accounts without per-order signature

**Onboarding (the operational gate):**
1. Create a normal Limitless account via wallet login → get `profileId`.
2. **Email `help@limitless.network`** to apply for programmatic API access. The capabilities endpoint shows allowed scopes only after Limitless flips a flag on your profile. *This is the only documented onboarding path — it is not self-serve.*
3. Derive a scoped token via `POST /auth/api-tokens/derive` with your Privy identity token. Get back `{tokenId, secret}` to use as HMAC creds.
4. Optionally, expose your own sub-tokens to sub-accounts (multi-tenant pattern).

**Rate limits per token:** 2 concurrent requests, 300ms minimum delay between calls. 429 on overage.

**Comparison to Polymarket V2:** Limitless has simpler off-chain auth (HMAC only, no L1 EIP-712 attestation) but adds an explicit manual-approval gate. Polymarket V2 was self-serve but used a two-stage L1+L2 auth.

---

## Q4 — Cleanest autonomous bot flow

This is where Limitless is dramatically cleaner than Polymarket V2. Full per-user flow:

```
┌─────────────────────────────────────────────────────────────┐
│  1. Operator-once setup                                      │
│     - Apply at help@limitless.network for programmatic API   │
│     - Derive scoped token with scopes:                       │
│       [trading, account_creation, delegated_signing]          │
│     - Store tokenId + secret in operator backend             │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. User starts Telegram bot (/start)                        │
│     - grammY handler: lookup user by TG id in DB             │
│     - if new:                                                │
│        await client.partnerAccounts.createAccount({          │
│          displayName: `tg:${tgUserId}`,                      │
│          createServerWallet: true,                           │
│        })                                                    │
│     - returns { profileId, account: "0xUserManagedAddr" }    │
│     - Store profileId in DB                                  │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. Bot shows user their on-chain address + USDC bridge link │
│     - User sends USDC to 0xUserManagedAddr ON BASE           │
│     - No bridging needed (USDC native on Base)               │
│     - No proxy/factory deployment needed                     │
│     - No relayer ceremony                                     │
│     - Bot calls checkAllowances(profileId); if not approved, │
│       retryAllowances(profileId) to set USDC + CTF approvals │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  4. /analyze: insight-engine produces FullTrace              │
│     - User pays $0.10 USDC for the analysis                  │
│     - Split via Stoa Splitter on Arc testnet (60/20/15/5)    │
│     - Trace pinned to Arc + IPFS                             │
│     - (This is where the bot earns its operator share)       │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  5. /preview → /confirm: place the trade                     │
│     await client.delegatedOrders.createOrder({               │
│       marketSlug, orderType: OrderType.GTC,                  │
│       onBehalfOf: user.profileId,                            │
│       args: { tokenId, side, price, size },                  │
│     })                                                       │
│     Limitless server signs as the user's managed wallet.     │
│     Order lands in book. Done.                                │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  6. Track filled trades                                       │
│     - client.portfolio.trades(profileId)                     │
│     - WebSocket subscriptions for fill notifications         │
│     - PnL queryable via portfolio endpoints                  │
└─────────────────────────────────────────────────────────────┘
```

**Time-to-first-trade for a new user: ~5-10 seconds** (no on-chain deploys, no relayer polls — sub-account creation + USDC arrival).

**Where the operator earns money:**
- `/analyze` fee on Arc — $0.07 per analysis goes to operator treasury via Stoa Splitter.
- Order-flow trading fees: **operator earns nothing today**. Limitless's taker fees flow to Limitless. Future LMT-token revenue share is speculative.

---

## Side-by-side: Polymarket V2 vs Limitless

| Dimension | Polymarket V2 | Limitless |
|---|---|---|
| **Chain** | Polygon (137) | Base (8453) |
| **Settlement asset** | pUSD (USDC.e wrapper) | USDC native |
| **Bridging cost for users** | USDC → bridge → pUSD on Polygon | USDC → Base (cross-chain only if user's USDC lives elsewhere) |
| **Per-user wallet model** | ERC-1967 deposit wallet proxies, deployed via Polymarket relayer | Server-side Privy-managed EOAs (or user-supplied EOA in Web3 mode) |
| **Wallet deployment cost** | Free (Polymarket pays relayer gas) | Free (no on-chain deploy needed) |
| **Wallet deployment latency** | ~15-30s (relayer mining) | <1s (DB row + Privy creates wallet) |
| **Order signature scheme** | EIP-712, sigType ∈ {0, 1, 2, 3}; for deposit wallets, 317-byte ERC-7739 wrap | EIP-712, sigType 0 (EOA); delegated mode = server signs as EOA |
| **Order schema fields** | 11 (V2): salt, maker, signer, tokenId, makerAmount, takerAmount, side, signatureType, timestamp, metadata, **builder** | 12 (V1-style): salt, maker, signer, taker, tokenId, makerAmount, takerAmount, expiration, nonce, **feeRateBps**, side, signatureType |
| **On-chain builder/referral field** | **YES** — `builder` bytes32 on every order | **NO** |
| **API key auth model** | L1 (EOA EIP-712 attestation) + L2 HMAC | HMAC-only with scoped tokens |
| **Smart wallet support for API key creation** | **Blocked** — CLOB rejects ERC-1271 wraps (today's finding) | Not needed — server-wallet sub-accounts are EOAs |
| **Onboarding for partners/bots** | Self-serve at polymarket.com/settings + email for Verified tier (100→10K/day relayer cap) | **Manual application** via `help@limitless.network` |
| **Builder-fee program (USDC revenue to bot operator)** | Yes — 1-2% of taker fees attributable to bot per trade | **No documented USDC revenue path** |
| **Retail referral program** | Not documented as a separate program | Yes — LMT/points, user-to-user via web URL |
| **Builder-fee cooldown / rate-update gates** | 7-day cooldown on rate adjustments | N/A (no fee participation) |
| **Withdrawal UX** | `bridge.polymarket.com/withdraw` — free, instant native USDC out | `partnerAccounts.addWithdrawalAddress()` + transfer; managed via Privy |
| **TVL / liquidity** | Multi-billion notional; deep books | Smaller market (DefiLlama lists < $50M TVL as of recent data) — verify before assuming any market has fillable orders |
| **Hackathon-Traction story** | Strong (real Polymarket trade volume) | Weaker (smaller markets, less recognizable to non-crypto judges) |
| **Architecture validation status** | Blocked at CLOB ERC-1271 today | Validation pending; SDK looks clean but unverified end-to-end |

---

## Implications for Phase 5

If we choose Limitless as the trading venue, three things change in the Phase 5 plan locked yesterday:

1. **Wallet model simplifies enormously.** Drop Circle developer-controlled EOAs *for the Polymarket leg*. Limitless creates and manages user wallets natively via its sub-account API. We still want Circle wallets for the **`/analyze` fee leg on Arc** (Stoa Splitter is on Arc testnet, fees collected there) — so each user gets a Circle Arc wallet *just* for paying the analysis fee. The Polymarket leg is fully Limitless-managed.

2. **The Polymarket-builder-fee revenue narrative disappears.** No on-chain attribution, no commission per trade. The Stoa Splitter exists *only* for the `/analyze` fee split now. The bot's commercial story shifts: instead of "we earn a slice of every prediction-market trade we facilitate," it's "we charge for the analysis itself, the trading is on you." Honest, defensible — and arguably stronger because it isolates the AI-analysis value from the trading venue.

3. **`/confirm` UX simplifies.** Modification 3's "current builder fee rate with cooldown disclosure" requirement disappears (no fee, no cooldown). The other inline elements (order details, max-loss, CID + Arc tx hash) remain.

The architectural skeleton stays the same: Telegram bot + per-user wallet + insight-engine + Stoa Splitter + TracePin. We're replacing one wallet/exchange leg, not redesigning the bot.

---

## Other CLOB-based prediction venues (only if Limitless is rejected)

You mentioned Myriad Markets and Drift BET as escape valves. Quick frame:

- **Myriad Markets** ([myriadmarkets.com](https://myriadmarkets.com)) — Polymarket competitor, multi-chain (Linea, Polygon). Less documentation public. Worth a 30-min look if Limitless's lack of partner-fee program is a deal-breaker.
- **Drift BET** ([drift.trade](https://drift.trade)) — Drift's prediction market on **Solana**. Different chain ecosystem entirely; pulls us off EVM and away from Circle/Arc story. Likely too disruptive.
- **PolyMarket V1 endpoints** — V1 is deprecated but may still run for some markets; not viable as a forward-looking choice.
- **SX Bet** ([sx.bet](https://sx.bet)) — sports-focused on Polygon/SX Network. Has affiliate program with real revenue share. Mostly sports/political markets, less crypto.
- **Augur Turbo / Stellaroad** — abandoned / sub-scale.

**Honest verdict on alternatives:** Limitless is currently the cleanest non-Polymarket EVM prediction-market option. Myriad is worth investigating if the no-builder-fee finding is a dealbreaker. The others either drag us off Base/EVM or aren't viable.

---

## Three options for the Phase 5 trading venue (your call)

**Option A — Adopt Limitless, drop trading-fee revenue narrative.**
- Build Phase 5 against Limitless. Revenue story collapses to `/analyze` fees.
- Lowest engineering risk; cleanest UX; ~5-10s onboarding per user.
- Loses: on-chain attribution / "Stoa earns from every trade" narrative.
- **My recommendation** for the hackathon timeline (9 days left).

**Option B — Investigate Myriad Markets first, decide after.**
- 30-min spike to confirm Myriad's signature + auth + builder-attribution.
- If Myriad has a USDC-denominated builder/referral program, switch to it.
- If not, fall back to Option A.
- Cost: 30 min of research. Slight risk of further fragmentation (third venue investigated and rejected).

**Option C — Hybrid: Limitless for trading, send Polymarket email tonight, retry V2 after their reply.**
- Build Phase 5 on Limitless now (Option A's flow). When Polymarket support replies with the missing piece for the V2 deposit-wallet flow, swap the trading leg back to Polymarket and recover the builder-fee revenue.
- Pros: not blocked, preserves optionality.
- Cons: two trading-venue integrations, double the test surface, scope risk in the final days of the hackathon.

If I had to pick: **Option A.** Limitless's delegated-signing model is the most aligned with what a Phase-5 bot actually wants to do (the bot operator does not want to handle user keys), and the `/analyze` revenue split is genuinely interesting on its own merits — it's the part judges will find most distinctive, since "AI agent that earns from analysis" is novel and "AI agent that earns from order-flow rebates" is common (every market-maker bot does it).

---

## Sources

- [Limitless API Reference — Introduction](https://docs.limitless.exchange/api-reference/introduction)
- [Limitless — EIP-712 Order Signing](https://docs.limitless.exchange/developers/eip712-signing)
- [Limitless — Programmatic API guide](https://docs.limitless.exchange/developers/programmatic-api)
- [Limitless — Create Partner Sub-Account](https://docs.limitless.exchange/api-reference/partner-accounts/create-partner-account)
- [Limitless — Check Allowances](https://docs.limitless.exchange/api-reference/partner-accounts/check-allowances)
- [Limitless — Create Order](https://docs.limitless.exchange/api-reference/trading/create-order)
- [Limitless — API Token Capabilities](https://docs.limitless.exchange/api-reference/api-tokens/get-capabilities)
- [Limitless TypeScript SDK — Partner Accounts](https://docs.limitless.exchange/developers/sdk/typescript/partner-accounts)
- [Limitless TypeScript SDK — Delegated Orders](https://docs.limitless.exchange/developers/sdk/typescript/delegated-orders)
- [Limitless — Smart Contracts](https://docs.limitless.exchange/user-guide/smart-contracts)
- [Limitless — Fees](https://docs.limitless.exchange/user-guide/fees)
- [Limitless GitBook — Referrals](https://limitless.gitbook.io/limitless/incentives-and-tokenomics/referrals)
- [DappRadar — Limitless Guide](https://dappradar.com/blog/the-ultimate-guide-to-defi-prediction-markets-with-limitless-on-base)
- [DefiLlama — Limitless Exchange](https://defillama.com/protocol/limitless-exchange)
