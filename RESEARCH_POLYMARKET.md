# RESEARCH_POLYMARKET.md

**Date:** 2026-05-14
**Time spent:** ~30 min initial pass + ~50 min confirmed-details pass (network was unblocked by WARP between passes)
**Verdict:** **GO** with one architecture change from the initial brief: **Polymarket leg runs on Polygon mainnet (real USDC, small bankroll), Stoa leg runs on Arc Testnet.** Hybrid mainnet/testnet is forced — neither side has a working alternative.

**Update 2026-05-14 (confirmed pass):** Almost every gap in the initial pass is now closed via the official docs. Real findings overwrote two of my earlier guesses (collateral is **pUSD**, not PMCT; signature types are **0/1/2/3** with semantic names, not L0/L1/L2). One architectural assumption from the brief is invalidated: there is no usable Polymarket testnet, so the fee loop cannot be fully testnet — see §"Confirmed Details" below.

---

## TL;DR

The original brief assumes "real builder fees flow from **Polymarket on Polygon mainnet** → **CCTP** → **Stoa on Arc mainnet**." Two pieces of that don't exist today:

1. **Arc has no mainnet yet.** Arc docs explicitly state *"Arc is currently available on Testnet only."* CCTP V2 lists Arc as **domain 26, Arc Testnet only**. Polygon is **domain 7, mainnet only** on CCTP V2.
2. Therefore the literal route Polygon mainnet → Arc mainnet via CCTP cannot run during the hackathon. CCTP doesn't bridge mainnet ↔ testnet.

The clean pivot — the one judges will accept and is fully working software — is to **run the whole demo on testnet end-to-end**: Polymarket CTF Exchange V2 on Polygon **Amoy**, CCTP V2 Amoy → Arc Testnet, Stoa Splitter on Arc Testnet. This keeps every Circle product in the story (Embedded Wallets, Paymaster, CCTP, USYC if available on Arc testnet, Arc itself) and keeps the agentic loop intact. Testnet txs still satisfy the 30% Traction criterion for a hackathon building on a chain that has no mainnet yet — judges expect this.

If we want Polymarket trades to be **real** (i.e., actually-spent USDC on Polygon mainnet) for the Traction story, we run a **hybrid**: the bot places real mainnet Polymarket trades and we mirror an equivalent fee amount onto Arc testnet for the Stoa split demo. That's described in §6.

---

## The six questions

### 1. What asset is a Polymarket V2 builder fee paid in?

**Strong evidence:** Polymarket CTF Exchange V2 (the on-chain settlement contract for V2 markets) trades in **PMCT (PolyMarket Collateral Token), an ERC20 wrapper around USDC/USDCe** (quoted from the `Polymarket/ctf-exchange-v2` README on GitHub). Orders carry a `builder` field — described as an "origin indicator" — and a "Configurable max fee rate (default 500 bps = 5%)."

**Best inference:** Builder fees are denominated in **PMCT** at the contract level, redeemable 1:1 for USDC/USDC.e. In practice that means after the trade, the builder either holds PMCT and unwraps it to USDC, or the relayer unwraps it before payout.

**Unconfirmed:** Whether the builder receives PMCT, native USDC, or USDC.e at their address. `docs.polymarket.com` was unreachable for this research — every fetch returned ECONNREFUSED. **This needs a 5-minute manual confirmation** (open the site in a browser) before we write payout code. It matters because **CCTP V2 burns native USDC only**, not USDC.e — if builder fees come out as USDC.e we need an extra DEX swap step on Polygon before CCTP.

### 2. What chain does the fee land on?

**Confirmed: Polygon.** From the `ctf-exchange-v2` README: *"The CTF Exchange V2 is the core smart contract system for trading Conditional Token Framework (CTF) assets on Polymarket"* — deployed on **Polygon mainnet** (and **Amoy testnet**). Builder fees flow through the same contracts as the trade, so they land on Polygon.

### 3. Is the recipient a normal EOA, or an escrow/vesting contract?

**Best inference: an EOA the builder controls.** The `builder` field is described as an "origin indicator" attached to the order — the same pattern as Uniswap V3's `recipient` and 0x's `feeRecipient`. There is no mention in the V2 contract README of an escrow, vesting schedule, or claim contract.

**Unconfirmed:** Whether `Polymarket/builder-relayer-client` (which exists on GitHub but has a thin README focused on auth/relay plumbing) wraps the EOA payout in a relayer-controlled flow. **This needs eyeballs on `builder-relayer-client`'s source** (not just its README) before we wire payouts.

### 4. Is CCTP currently live on Arc? Is the Polygon → Arc bridge path live?

**Confirmed (from `developers.circle.com/cctp/concepts/supported-chains-and-domains`):**

| Chain | CCTP version | Domain | Network |
|---|---|---|---|
| Polygon PoS | V2 | 7 | **Mainnet only** |
| Arc | V2 | 26 | **Testnet only** |

**Consequence:** Polygon **mainnet** → Arc **mainnet** is not a CCTP route today, because Arc has no mainnet. Polygon **Amoy** → Arc **testnet** is the route that exists today. Both are CCTP V2, so transfers use **fast finality (~8–20s)** rather than V1's 13–19 min, which is excellent for a live demo.

**Arc docs confirm:** *"Arc is currently available on Testnet only"* and *"USDC is the native gas token."* App Kit's Bridge component *"abstracts the underlying CCTP flow so you can bridge without orchestrating the low-level burn, attestation, and mint steps yourself."* No third-party bridges (LayerZero, Hyperlane, Wormhole) are listed as live on Arc.

### 5. If Polygon mainnet → Arc mainnet isn't live, what's the cleanest fallback?

Three options, ranked by hackathon fit:

**(A) Full-testnet loop (RECOMMENDED).** Trade Polymarket CTF Exchange V2 on Polygon **Amoy**, take builder fees in test-PMCT on Amoy, CCTP V2 Amoy → Arc Testnet, Stoa Splitter on Arc Testnet. Every Circle product in the story still works (Embedded Wallets on Arc testnet, Paymaster gas-in-USDC on Arc testnet, CCTP V2 fast transfer, USYC if available — needs verification). Honest narrative: *"Stoa is built on Arc; Arc launches mainnet next quarter; the moment it does, every line of this code runs against mainnet Polymarket fees with zero changes."*

**(B) Hybrid (BEST FOR TRACTION SCORE).** The Polymarket trades themselves run on **mainnet** (real USDC, real fees, real Traction), and the Stoa split demo runs on Arc **testnet** with a backend mirror that watches the builder-fee EOA on Polygon mainnet and reproduces each fee event as an equivalent Arc-testnet USDC transfer into the Splitter. Cost is real: at 100bps on $X notional you're paying $X/100 in actual money for the demo. Risk is also real: builder onboarding may have KYC gates that aren't surmountable in 10 days. Worth it only if onboarding turns out to be a same-day form.

**(C) Skip Arc, settle on a CCTP V2 mainnet destination instead** (Base, Arbitrum, Optimism). This works, costs nothing, has real Traction — but it kills the Circle-stack story (Arc, USYC, Paymaster are all Arc-specific), which is 20% of the score. **Don't pick this unless A and B both blow up.**

### 6. Restrictions on becoming a builder (KYC, deposits, application)?

**Unknown. This is the one open gating item.** `docs.polymarket.com` was unreachable for this entire research session (ECONNREFUSED on every path). The `learn.polymarket.com` and `polymarket.com/builders` pages also refused connections. Sources I *could* reach (GitHub READMEs) confirm builder codes are first-class in the contract but say nothing about onboarding policy.

**Highest-leverage next step:** open `docs.polymarket.com/trading/clients/builder` and `polymarket.com/builders` in a regular browser (the WebFetch tool was being blocked; a browser will work). If onboarding is a self-serve form or just an address-registration call to the relayer — green light. If it's a manual application that takes weeks or requires entity KYC — pivot to **option C** (settle on Base/Arbitrum with our own InsightAgent fees instead of Polymarket builder fees).

---

## Recommended path forward

1. **Today (you, 10 minutes, manually in a browser):** confirm Polymarket builder onboarding is self-serve, not KYC-gated. If it is gated, we pivot the *fee source* away from Polymarket builder codes (option C above) but keep everything else.
2. **Today / tomorrow:** I read the `Polymarket/builder-relayer-client` source on GitHub (not just README) to confirm the fee asset & recipient. Then update this file with confirmed answers and remove the asterisks.
3. **Architecture lock:** assume **option A (full-testnet)** is baseline. Build everything on Polygon Amoy + Arc Testnet. Add a feature-flag to swap Polygon source to mainnet if option B becomes affordable. Document this clearly in README so judges see the design accounts for Arc not having mainnet yet.

---

## What I could not confirm and why

- `docs.polymarket.com/*` — every URL returned `ECONNREFUSED`. May be blocking the fetcher's user agent. Manual browser confirmation needed.
- `polymarket.com/builders` — same.
- `learn.polymarket.com/*` — same.
- Polymarket builder fee **asset at the moment of payout** (PMCT vs unwrapped USDC vs USDC.e) — inferred from the V2 exchange contract, not confirmed from a payout flow.  *(Resolved below — collateral is **pUSD**, an ERC-20 wrapper of USDC.e; fees can be unwrapped on demand.)*
- Polymarket builder fee **recipient type** (EOA vs escrow) — inferred, not confirmed.  *(Resolved below — fees route to "the wallet associated with your builder profile," which is the address registered when you self-claim a builder code at polymarket.com/settings?tab=builder.)*
- Polymarket builder **onboarding policy** — unknown.  *(Resolved below — self-serve, Unverified tier starts immediately with no approval, 100 relayer txns/day cap; Verified tier needs an email application.)*
- USYC availability on **Arc testnet** specifically — not verified in this session. Needs a 5-min check before we commit to auto-depositing the operator share there.

---

## Confirmed Details (added 2026-05-14, second pass)

All facts in this section come from `docs.polymarket.com/*.md` pages fetched directly (network unblocked via WARP). The Polymarket MCP tool wasn't loaded in this session, so MCP cross-check is deferred to the next session. WebFetch alone was sufficient for everything below; the only items that remain partially open are flagged explicitly.

### 1. Builder fee asset — CONFIRMED

The collateral asset on Polymarket V2 is **pUSD** (Polymarket USD), not pmUSD or PMCT. pUSD is an ERC-20 token wrapping **USDC.e** (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` on Polygon).

> *"pUSD is a standard ERC-20 wrapper that represents a USDC claim."* — concepts/pusd

Builder fees are denominated in **pUSD** at the protocol level. The `get-builder-trades` endpoint returns `fee` (pUSD raw amount, 6 decimals) and `feeUsdc` (USDC-equivalent amount) per trade. The trading-fees doc separately states *"Taker fees are calculated in USDC"* — these are consistent because pUSD is 1:1 with USDC.e, which in turn unwraps to native USDC.

Important: **CCTP V2 burns NATIVE USDC, not USDC.e.** That means our agent must unwrap pUSD → USDC.e → swap to native USDC before bridging to Arc. The pUSD docs spell out the unwrap path; see §5.

### 2. Fee payout cadence — CONFIRMED (mostly)

Fees are **per-trade**, not accrued to a separate balance with a claim flow. Each filled order with a `builderCode` attached creates a builder-attributed trade where the `fee`/`feeUsdc` amount is included in the on-chain settlement. The builder-fees doc states *"Collected builder fees are distributed to the wallet associated with your builder profile."* That wallet is the builder address you set when registering your builder code at `polymarket.com/settings?tab=builder`.

What I could not nail down: whether the per-trade fee transfer happens **atomically inside the Exchange contract's settlement call** (so the builder wallet's pUSD balance updates on every fill) or whether Polymarket's operator batches builder-fee transfers periodically. The Exchange contract's atomic-settlement quote — *"transfers tokens from seller to buyer, transfers pUSD from buyer to seller"* — doesn't explicitly mention a builder leg. **Action item:** read CTF Exchange V2 source (Polygonscan: `0xE111180000d2663C0091e4f400237545B87B996B`) to confirm whether the builder transfer is in the same tx, or fetch one of our own builder trades after a smoke test and inspect the tx. Either is a 10-minute verification once we're live.

### 3. pUSD → native USDC redeem path — CONFIRMED, no redesign needed

The original concern (*"if no on-demand unwrap, the entire CCTP flow needs a redesign"*) is **resolved**. pUSD has two complementary on-demand unwrap paths, both fully documented, both permissionless:

**Path A — direct contract call (one swap step):**
- `CollateralOfframp.unwrap(amount)` at `0x2957922Eb93258b93368531d39fAcCA3B4dC5854` returns **USDC.e** 1:1
- We then swap USDC.e → native USDC via a Uniswap v3 pool ourselves before CCTP burn

**Path B — Polymarket bridge endpoint (does both steps in one call):**
- `POST https://bridge.polymarket.com/withdraw` with `toChainId: 137` and `toTokenAddress` = native USDC returns **native USDC** directly
- The bridge unwraps pUSD via CollateralOfframp then swaps USDC.e → native USDC through Uniswap v3 internally
- Per docs: *"Withdrawals are instant and free — Polymarket does not charge withdrawal fees"*

**Implication for Stoa:** the fee flow is `Polymarket fill (pUSD)` → `bridge.polymarket.com/withdraw` (native USDC on Polygon) → `CCTP V2 burn on Polygon` → `mint on Arc Testnet` → `Stoa.settle()` calls Splitter. Both legs use existing Polymarket and Circle infra; no custom unwrap contract on our side.

Other supported withdrawal destinations from the same endpoint: Ethereum, Arbitrum, Base, Optimism, Solana, Bitcoin, Tron. We don't need them but it's good for the README narrative.

### 4. createAndPostOrder + builder code — CONFIRMED

Full pattern (TypeScript, from `trading/clients/builder.md`):

```typescript
import { ClobClient, SignatureTypeV2, Side, OrderType } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const signer = createWalletClient({ account, transport: http() });
const depositWallet = process.env.DEPOSIT_WALLET_ADDRESS!; // smart-account, deployed via relayer

const tempClient = new ClobClient({ host: HOST, chain: CHAIN_ID, signer });
const apiCreds = await tempClient.createOrDeriveApiKey();

const client = new ClobClient({
  host: HOST,
  chain: CHAIN_ID,
  signer,
  creds: apiCreds,
  signatureType: SignatureTypeV2.POLY_1271, // 3 — deposit-wallet smart account
  funderAddress: depositWallet,
});

const response = await client.createAndPostOrder(
  {
    tokenID: "OUTCOME_TOKEN_ID",
    price: 0.55,
    size: 100,
    side: Side.BUY,
    builderCode: process.env.POLY_BUILDER_CODE!, // bytes32 hex from polymarket.com/settings?tab=builder
  },
  { tickSize: "0.01", negRisk: false },
  OrderType.GTC,
);
```

**signatureType enum (corrected):** Polymarket does **not** use L0/L1/L2 for signature types. Those names refer to *API access tiers*, not signatures. The four signature types are:

| Value | Name | Meaning |
|---|---|---|
| 0 | EOA | Direct EOA signature — user pays own gas, no relayer |
| 1 | POLY_PROXY | Polymarket-specific proxy wallet (legacy web app users) |
| 2 | GNOSIS_SAFE | Gnosis Safe smart account |
| 3 | POLY_1271 | Deposit wallet (ERC-1967 proxy) validated via ERC-1271 — **recommended for new API users** |

**Funder address:** the address that holds the pUSD collateral. With `signatureType: 0` (EOA) this is your EOA. With `signatureType: 3` (POLY_1271 deposit wallet) this is the **deposit wallet contract address**, deployed via a relayer `WALLET-CREATE` request from the deposit-wallet factory at `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07`. The `signer` (your EOA) co-signs orders via ERC-7739 wrapper, the `funder` (the deposit wallet) is the on-chain account that custody and settlement happen against.

**L1 vs L2 methods (clarified):**
- **L1 methods** (`trading/clients/l1.md`): require a wallet signer (private key). Used for `createApiKey`, `deriveApiKey`, `createOrDeriveApiKey`, `createOrder`, `createMarketOrder`. These produce signed payloads but don't talk to the CLOB. Headers: `POLY_ADDRESS`, `POLY_SIGNATURE`, `POLY_TIMESTAMP`, `POLY_NONCE`.
- **L2 methods** (`trading/clients/l2.md`): require API credentials from L1. Used for `createAndPostOrder`, `postOrder`, `cancelOrder`, `getOpenOrders`, `getTrades`, `getBalanceAllowance`, etc. Headers: `POLY_ADDRESS`, `POLY_SIGNATURE` (HMAC-SHA256), `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE`.

### 5. Negative risk markets — CONFIRMED

A negative-risk market is a multi-outcome event where *"a No share in any market can be converted into 1 Yes share in every other market"* — capital-efficient cross-outcome trading. The Gamma API exposes a boolean `negRisk` (and the augmented variant via `enableNegRisk` + `negRiskAugmented`) on event and market objects.

When placing an order on a neg-risk market, you **must** pass `negRisk: true` in the order options or the order will route through the wrong exchange contract. There are two distinct exchange addresses:

- Standard CTF Exchange: `0xE111180000d2663C0091e4f400237545B87B996B`
- Neg Risk CTF Exchange: `0xe2222d279d744050d28e00520010520000310F59`

**Builder code attribution on neg-risk markets:** the docs don't say it differs. The example in `trading/clients/builder.md` shows `negRisk: false` but doesn't flag any restriction on neg-risk markets. Treat as "works on both" until I see evidence otherwise. **Action item:** confirm by placing a test trade on each market type.

### 6. Tick sizes — CONFIRMED

Tick size is **fixed per market** (not per outcome token within a market). Four possible values: `0.1`, `0.01`, `0.001`, `0.0001`. Fetch via:

- `client.getTickSize(tokenID)` → returns the canonical tick string
- Or read `minimum_tick_size` field from the market object returned by `client.getMarket(conditionID)` or the Markets API

Orders with non-conforming prices return `INVALID_ORDER_MIN_TICK_SIZE`. The robust pattern (used in the quickstart example) is to read both `minimum_tick_size` and `neg_risk` from the market object before constructing the order.

### 7. CLOB API rate limits — CONFIRMED (well within agent budget)

Cloudflare-throttled (requests are queued/delayed rather than rejected with a hard 429). Key numbers:

| Endpoint | Limit |
|---|---|
| General | 9,000 / 10s |
| `/book` | 1,500 / 10s |
| `/price`, `/midpoint` | 1,500 / 10s |
| `/prices-history` | 1,000 / 10s |
| Market tick size | 200 / 10s |
| `POST /order` | 5,000 / 10s, 48,000 / 10 min |
| `DELETE /order` | 5,000 / 10s, 48,000 / 10 min |
| API key endpoints | 100 / 10s |
| GET balance/allowance | 200 / 10s |

The CLOB API limits are far above what an analysis agent will use. The **real bottleneck** is the **builder relayer txn cap**, not the CLOB rate limit — see §10.

### 8. Gasless transactions — PARTIAL

Polymarket's relayer sponsors gas for: **wallet deployment, token approvals, CTF operations (split/merge/redeem), and transfers**. Order placement and cancellation are notably *not* listed in the gasless docs — but `POLY_1271` deposit wallets work through the CLOB matching engine without users sending on-chain txs per order, because the CLOB operator (Polymarket) submits settlements on-chain in batches. So in practice, orders feel gasless to the user even though "gasless" in the docs specifically refers to relayer-sponsored wallet ops.

What this means for the agent:
- Approvals (one-time pUSD allowance to the exchange) → free via relayer
- Wallet deployment (once per user) → free via relayer
- Order placement → free in the sense that Polymarket's operator pays settlement gas
- Withdrawal (calling CollateralOfframp.unwrap() ourselves) → user pays gas
- Or use bridge endpoint `POST bridge.polymarket.com/withdraw` → free (Polymarket pays gas), instant

### 9. Authentication — CONFIRMED

L1 (initial setup, signer-based): four headers — `POLY_ADDRESS`, `POLY_SIGNATURE` (EIP-712), `POLY_TIMESTAMP`, `POLY_NONCE`. The EIP-712 message is the auth attestation *"This message attests that I control the given wallet"*.

L2 (trading, API-cred-based): five headers — `POLY_ADDRESS`, `POLY_SIGNATURE` (HMAC-SHA256 of canonical request using API secret), `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE`.

The CLOB client v2 handles both header sets internally — you just instantiate with `signer` + `creds`.

### 10. Gotchas — CONFIRMED

**(a) Tier-based relayer transaction cap.** This is the single biggest operational constraint and was not obvious upfront.

| Tier | Daily relayer txn cap | How you get there |
|---|---|---|
| Unverified | **100 / day** | Default, self-serve at polymarket.com/settings?tab=builder |
| Verified | 10,000 / day | Email builder@polymarket.com with use case + expected volume |
| Partner | Unlimited | Invite-only, strategic-partnership tier |

This cap counts relayer-sponsored transactions: wallet deployments, approvals, CTF ops, transfers. Order placements via L2 do not appear to count against it. **Withdrawal via the bridge endpoint counts**, so the agent can't withdraw fees more than ~100 times per day on the Unverified tier. For our hackathon volume this is fine. For scale-up we'd need to apply for Verified within the first week.

**(b) Builder code is `bytes32`, attached per-order.** Not a header, not an account-level config. Every order's `builderCode` field must be set. If omitted, the trade is not attributed and no builder fee is collected on that order. There's no retroactive attribution — the docs say *"The process requires builderCode in the initial order submission."*

**(c) Two exchange contracts (standard vs neg-risk).** Routing to the wrong one (mismatched `negRisk` flag) → order rejected. Always read the market's `neg_risk` field before constructing the order.

**(d) Revocability and minimum-volume rules.** Not mentioned in any doc I read. The leaderboard endpoint and tier upgrade flow imply Polymarket monitors volume but the docs don't say codes can be revoked for inactivity. **Assume codes are persistent unless we hear otherwise.** Not a hackathon-window concern.

**(e) No Polymarket testnet for the orderbook / pUSD / builder system.** Repeated in every doc — *"all Polymarket contracts are deployed on Polygon mainnet (Chain ID: 137)"*. CTF Exchange V2 has an Amoy deployment (per the GitHub README from the initial pass), but the CLOB, pUSD, deposit wallets, builder leaderboard, and bridge endpoints all run on mainnet only. This forces the mainnet leg in our architecture — see "Architecture impact" below.

**(f) Geographic restrictions exist.** `api-reference/geoblock.md` is in the doc index. Not fetched in this pass — needs a quick check before we wire up the bot, in case our origin IP or registered builder country is restricted.

### Architecture impact (read this if nothing else)

The initial-pass plan (option A, "full-testnet loop") is **not viable** because Polymarket runs only on mainnet. Final architecture:

- **Polymarket leg → Polygon mainnet, real pUSD/USDC.** The agent uses a real Polymarket account, real deposit wallet, real Unverified-tier builder code. Bankroll the agent with a small amount (single-digit USDC equivalent) for the hackathon demo. Builder fees come back as real pUSD per fill.
- **Withdrawal leg → `bridge.polymarket.com/withdraw`** to get **native USDC on Polygon** in the operator's bridging EOA.
- **CCTP leg → CCTP V2 fast transfer**, Polygon mainnet (domain 7) → Arc Testnet (domain 26). *Open question: does CCTP V2 actually allow mainnet → testnet routes?* If not, we need an intermediate "mirror" service that watches the Polygon mainnet USDC receipt and re-emits an equivalent USDC transfer to Arc Testnet using pre-funded testnet USDC. **Action item:** verify CCTP V2 attestation API accepts mainnet→testnet domain pairs. If yes, life is easy. If no, the mirror is ~30 lines of TS.
- **Stoa leg → Arc Testnet.** Splitter, TracePin, USYC deposit all happen on Arc Testnet. Confirm USYC is deployed on Arc Testnet before locking the operator-share auto-deposit.

The 60% / 20% / 15% / 5% split runs on Arc Testnet with the mirrored fee amount. Judges see real Polymarket trades on Polygon mainnet (real Traction) and real on-chain Stoa split + USYC deposit on Arc Testnet (Circle product breadth). Best of both: Traction story stays real, Circle/Arc story stays whole.
