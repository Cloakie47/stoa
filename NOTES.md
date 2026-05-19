# NOTES.md — running architecture log

Living document for architecture decisions and the reasons behind them. Newest entry at the top. Pair with `RESEARCH_POLYMARKET.md`, `RESEARCH_CIRCLE_POLYMARKET.md`, and `RESEARCH_LIMITLESS.md` for source citations.

---

## 2026-05-19 — Confidential payments (Fairblock StableTrust) gated off

The Fairblock StableTrust integration shipped earlier today is architecturally complete and feature-flagged off (`STOA_USE_STABLETRUST=false`). Fairblock's docs advertise an "Arc" network at **chain 1244** which is *not* Circle's Arc — Circle's Arc Testnet is **chain 5042002** (per https://docs.arc.io/arc/references/connect-to-arc). One Path 1 deposit attempt with `chainId: 5042002` in the request body still routed to Base Sepolia (RLP chain `0x014a34` = 84532), confirming the API ignores chain hints and Fairblock has not deployed StableTrust contracts on chain 5042002. We will flip the flag on once Fairblock confirms deployment. See `apps/bot/README.md` (§ "Why confidential payments are currently disabled") + `docs/fairblock-issue-draft.md` for the GitHub issue to file.

---

## 2026-05-16 — EURC multi-currency probe + Arc Blueprint alignment

**EURC is deployed on Arc Testnet** at `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` (canonical address per https://docs.arc.io/arc/references/contract-addresses). Probed via `apps/bot/scripts/probe-eurc.ts`:

- `name = "EURC"`, `symbol = "EURC"`, `version = "2"`, `decimals = 6`
- `DOMAIN_SEPARATOR = 0x649ec6b0…ebf160` — present, confirms EIP-712 / EIP-3009 readiness (same FiatTokenV2 family as Arc USDC at `0x36…0000`)
- Deployer balance: **0 EURC**. End-to-end split UNVERIFIED — need to hit https://faucet.circle.com (Arc Testnet + EURC) before re-running the probe

**Architectural truth on multi-currency**:
- `Splitter.sol` is **token-agnostic** — first arg of `distribute()` is `address token`. Any ERC-20 works. (Verified by reading the source: `contracts/src/Splitter.sol:42`.)
- `StoaSettler.sol` **binds USDC immutably** in the constructor (`IERC20 public immutable usdc;`). An EURC-denominated fee path would need a **second StoaSettler instance** deployed with EURC as `_usdc`.
- The probe runs `Splitter.distribute()` directly with EURC (skipping StoaSettler) — when the deployer has EURC, it will verify the 70/20/10 split fires correctly on a non-USDC token.

**Status:** EURC support compiled-in and architecturally sound, but unverified on-chain at hackathon time (no testnet EURC in the deployer wallet). Operator action: request EURC from Circle faucet → re-run `pnpm tsx scripts/probe-eurc.ts` → expect a successful `Splitter.distribute` tx hash. If the demo needs an EURC fee flow, deploy a second StoaSettler:

```sh
forge create contracts/src/StoaSettler.sol:StoaSettler \
  --constructor-args 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a $SPLITTER $TRACEPIN \
  --rpc-url $ARC_RPC --private-key $DEPLOYER_PRIVATE_KEY
```

Then set a per-currency `STOA_SETTLER_EURC` env var alongside the existing `STOA_SETTLER` (USDC).

---

## 2026-05-16 — Phase 5 trading venue: Limitless on Base + Stoa-routed payment flows (strategic reframe)

**Decision locked.** Phase 5 trades happen on **Limitless Exchange** on Base. Revenue capture moves from "platform-side builder fees" to "**Stoa-routed execution fees**" — every user interaction in the bot pays a Stoa-split micropayment on Arc before the trade is placed. Full plan and reasoning in `RESEARCH_LIMITLESS.md` top banner.

### Two payment flows in the bot

1. **`/analyze`** — $0.10 USDC. Split via `StoaSettler` on Arc testnet: $0.07 operator / $0.02 insight-engine maintainers / $0.01 Canteen ecosystem pool. Runs `insight-engine.analyzeMarket()` and pins FullTrace to Arc + IPFS after the split clears.
2. **`/confirm`** — $0.20 USDC. Same split scheme, same recipients (70/20/10). Same `StoaSettler` contract. **Executes BEFORE** the Limitless `delegatedOrders.createOrder` call. If split fails → trade does not happen. If trade fails post-split → fee is **non-refundable in v0** (document as known limitation in bot onboarding text; revert flow is post-hackathon polish).

### Why the reframe is stronger than chasing venue revenue

- Polymarket builder fees would be inaccessible until 2026-05-22 (7-day rate-update cooldown started 2026-05-15 13:02 UTC). Hackathon ends 2026-05-25. That's a 3-day window where rates would be live, against a 9-day total build window. Net revenue ≈ negligible regardless.
- Limitless has **no on-chain builder fees at all** — confirmed in research. Their referral program rewards in LMT tokens / points (pre-token, illiquid), not USDC, and only attributes user-to-user invites via web URL — not programmatic partner submissions.
- Stoa-routed fees are **venue-agnostic**: every trade through the bot produces a verifiable on-chain Arc tx via contracts **we control**. The Splitter and TracePin both fire on real Arc USDC. This is a far stronger demo than "we *would* earn fees if the platform's program were live and configured."
- We dogfood Stoa for real, in the demo path, on every user interaction. Judges can verify the tx hashes on Arc explorer.

### Wallets: DIY viem EOAs, not Circle dev-controlled wallets

- **Circle mainnet wallet provisioning requires KYB** we cannot complete in 9 days. Sandbox-only doesn't help — Base mainnet trades need mainnet-tier credentials.
- Wallet creation per user is just `viem`'s `generatePrivateKey()` + `privateKeyToAccount()`. Keys are stored encrypted at rest in D1, decrypted on demand for signing.
- **The Circle product story survives.** We still use: Arc (chain), Circle Bridge / CCTP (USDC movement), Circle Paymaster (USDC gas), Circle USYC (operator-share yield), Circle's Compliance Engine (sanctions screening on withdrawals — needs confirmation), Circle Gateway (cross-chain wallet — not yet evaluated). That's still 5-7 Circle products surface. Dropping Embedded Wallets does not break the 20% Circle-stack score.
- "Web2 UX" is preserved via Telegram's existing account system, not via Circle's Privy-like wallet primitive. Users authenticate to the bot via Telegram identity; the bot generates and custodies their viem EOA. Same end-user experience.

### Limitless partner-access fallback

If Limitless's partner-application approval lags past the hackathon window, the bot falls back to placing **all users' trades from a single operator partner account** (the operator's own approved sub-account). Acceptable trade-off because:
- Revenue isn't venue-side, so attribution at the trading layer doesn't matter
- The Stoa-split flow still fires per user per trade — that's the demo
- The on-chain trace per user is still produced (different mechanism: bot tags trades with the user's Telegram ID off-chain in D1, and the Arc tx + IPFS CID per `/confirm` is the verifiable user-tied artifact)

This is the rejected "shared-operator-EOA" pattern from yesterday's Phase 5 modifications, BUT the rejection reasoning no longer applies because:
1. **Market manipulation concern:** still real, but the operator account is the *trading*-side entity, not the *custody*-side. Funds live in per-user wallets; the operator just submits. Different posture.
2. **Custody story:** preserved — user funds are in per-user viem-EOA addresses, never pooled.

We use this fallback only if forced. Primary path is per-user Limitless sub-accounts.

### Code plan (2-day time-box)

- **Day 1 AM:** `packages/limitless-client/` — minimal SDK wrapper. Mirror the polymarket-client surface where shape applies (getMarket, prepareOrder, submitOrder, cancelOrder), but use Limitless's delegated-signing model so the wrapper exposes per-user `subAccountId` parameters instead of per-user signers.
- **Day 1 PM:** `apps/bot/` scaffold — Cloudflare Workers + grammY + D1 schema (users, wallets, orders, trace pins). Wire viem EOA generation per user. Implement `/start` → wallet creation flow.
- **Day 2 AM:** Wire `StoaSettler` integration — both `/analyze` and `/confirm` payment flows. Test on Arc testnet.
- **Day 2 PM:** End-to-end demo trade: `/analyze` → split fires → trace pinned → `/preview` → `/confirm` → split fires → Limitless order placed. At least one full happy path executed on mainnet (Base for trade, Arc for split).
- **Days 3-4:** Real users for testing + bug fixes.
- **Day 5:** Submission.

### What stays from yesterday's Phase-5 modifications

- ✅ **/analyze + /preview + /confirm three-command structure** — unchanged.
- ✅ **Stoa-split dogfooding for /analyze** — unchanged ($0.10 split).
- ✅ **Inline /confirm UX** showing order details, max-loss, CID + Arc tx hash link — unchanged.
- ❌ **/confirm cooldown disclosure (Polymarket builder-fee rate)** — *removed* (no platform fee to disclose).
- ✅ **Strong onboarding disclosure language** — unchanged; now includes "fees are non-refundable on trade failure in v0" + "bot custodies your trading key, exportable on demand."
- ❌ **Operator-only Polymarket spike** — *complete and definitively concluded* (see entry below). Won't be revisited unless Polymarket support replies with a new path.

The Polymarket V2 finding stays documented for the **$500 Feedback Incentive** submission. Operator is sending the email tonight; if Polymarket responds with the missing pattern, we may circle back post-hackathon. Not in scope for the 2-day code window.

---

## 2026-05-16 — Path B-1 spike: CLOB /auth/api-key does NOT support ERC-1271 (definitive)

End-to-end test of the depositWallet-bound API key flow. Result: **CLOB's L1 auth endpoint accepts only EOA ECDSA signatures**. ERC-7739-wrapped ERC-1271 signatures are rejected at the headers layer (HTTP 401 "Invalid L1 Request headers") before the server reaches the on-chain validation step. This rules out the documented V2 SDK pattern (`signatureType: POLY_1271` + `funderAddress: depositWallet`) for end-to-end agentic order submission via CLOB.

### What B-1 proved

1. **WALLET-CREATE works** with HMAC builder-API-key auth on `https://relayer-v2.polymarket.com/submit`. Endpoint exists, payload is `{type: "WALLET-CREATE", from: ownerEOA, to: factoryAddr}`, no inner sig required. Operator paid ~$0 (Polymarket relayer covers gas).
2. **Deposit wallet address extraction:** the wallet PROXY emits `OwnershipTransferred(0x0, ownerEOA)` during construction; its address is the emitter of that log. **Do NOT** use the factory's own event `data` field — that's a different shared contract.
3. **Real deposit wallet** for deployer EOA `0x5342…12435` is `0xF4be72ae8Dd864f6Cb0E48b15fA54E56f3D4E529` (proxy at this address, `owner()` returns the EOA, `eip712Domain()` returns `DepositWallet/1/<self>`).
4. **ERC-7739 wrap is correct on-chain.** Mirrored the SDK's order-side wrap for the L1 `ClobAuth` attestation, signed with the EOA. Calling `IERC1271.isValidSignature(hash, wrappedSig)` on the deposit wallet returns **0x1626ba7e (magic value)** for the "sign over app's domain" variant. Wrap structure: 202 bytes = `innerSig(65) | appDomainSep(32) | contentsHash(32) | typeString(71) | uint16(len)`. App domain = `ClobAuthDomain v1` (3-field EIP712Domain, no verifyingContract). Test script: `packages/polymarket-client/scripts/verify-1271.ts`.
5. **CLOB server-side rejection.** POST `/auth/api-key` and GET `/auth/derive-api-key` both return `401 {"error":"Invalid L1 Request headers"}` when given:
   - `POLY_ADDRESS` = depositWallet (lowercased)
   - `POLY_SIGNATURE` = our verified-correct 202-byte ERC-7739 wrap
   - `POLY_TIMESTAMP`, `POLY_NONCE=0`
   Because our wrap passes on-chain `isValidSignature`, the only remaining explanation is that CLOB's L1 verification path does not invoke ERC-1271 — it ECDSA-recovers the signature and direct-compares to `POLY_ADDRESS`. With a 202-byte non-ECDSA sig, the parser fails before the server reaches an on-chain check.

### Implications for Phase 5

- The documented V2 SDK pattern (`signatureType: POLY_1271` + EOA-bound API key + `funderAddress: depositWallet`) does NOT actually work end-to-end. The order build succeeds and the on-chain settlement layer (the deposit wallet contract) would accept it, but the CLOB's order-submission API gate doesn't. Earlier observation: posting a POLY_1271 order with the EOA-bound API key returned `"the order signer address has to be the address of the API KEY"` — same root cause (CLOB binds API key strictly to its `POLY_ADDRESS` value, which can only be set to an ECDSA-recoverable address).
- The **only** way to submit deposit-wallet-funded orders through the live CLOB today is via an API key registered with `POLY_ADDRESS = depositWallet`, which requires CLOB to support ERC-1271 — it doesn't.
- For Phase 5 this means **deposit-wallet trading is blocked at the CLOB API layer**. Options going forward (open for operator decision):
  1. Email `builder@polymarket.com`: ask whether (a) there is an undocumented endpoint to register a deposit-wallet-bound API key, (b) ERC-1271 support is planned for `/auth/api-key`, or (c) we should use a different pattern.
  2. Switch the bot architecture from per-user deposit wallets to per-user EOA wallets (Circle developer-controlled EOAs that sign directly). Per-user EOA holds pUSD, signs orders directly with `signatureType: EOA`, no proxy involved. **Loses:** the deposit-wallet bridging UX (operator-paid gas, batch approvals, the Polymarket-native deposit experience). **Keeps:** per-user custody, builder-code attribution, the full Stoa split + trace flow.
  3. Per-user proxy wallets + operator-facing intermediation: the operator (Stoa) holds an EOA-bound API key on CLOB, and orders go through THAT API key but with `funder` set to the user's deposit wallet. Still requires CLOB to honor "API key submits orders for funders other than itself" — which it explicitly doesn't (`order.signer == POLY_ADDRESS` check).
- **Recommended next step (when this is picked up):** option 2 (per-user Circle EOAs). It maps cleanly onto Circle's developer-controlled-EOA primitive (which is what we'd ship anyway), drops the proxy/1271 complexity, and unblocks the entire Phase 5 flow on a single architecture the docs actually describe. The cost is the "Polymarket-style deposit wallet" UX which we never had a strong reason to copy in the first place.

### Side investigation: pre-existing 131.99 pUSD on `0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB`

During spike Phase 1 I mis-identified the deposit wallet as `0x58CA52eb…` (the address in the factory event's `data` field). Probing both candidates revealed that **`0x58CA52eb…` is a shared Polymarket contract** (full bytecode, returns its own address from `eip712Domain()` but `owner() = 0x0`). It is NOT a per-owner deposit wallet — likely a shared implementation or liquidity pool used by many deposit wallet proxies.

The 131.99 pUSD balance on `0x58CA52eb…` is **NOT ours**. It belongs to whatever shared mechanism that contract serves. Per the deterministic-CREATE2 derivation, our real deposit wallet's address depends on our owner EOA, and that wallet (`0xF4be72ae…`) had **0 pUSD** prior to our auto-funding step. The spike auto-funded 3 pUSD from the deployer EOA → real deposit wallet (tx `0x9c5ee2a059e5cdfb31f2c0295bfbe0f60297f91afd93ff9575ba22cfe839a8e8`). 1.99 pUSD remains on the deployer EOA.

**Operator-facing implication:** the deployer EOA holds 1.99 pUSD; the real deposit wallet holds 3 pUSD (now locked in there until we either successfully trade with it or call a withdrawal flow). Both are spendable assets we control. The 131.99 pUSD elsewhere is not ours and should not be referenced in future Phase 5 calculations.

### Key artifacts

- `packages/polymarket-client/scripts/spike-deposit-wallet.ts` — full Path B + B-1 spike
- `packages/polymarket-client/scripts/verify-1271.ts` — empirical confirmation of the wrap
- `packages/polymarket-client/scripts/probe-wallet.ts` — wallet probe (eip712Domain, owner)
- `packages/polymarket-client/scripts/verify-hash-math.ts` — appDomainSep + contentsHash hash math sanity
- `packages/polymarket-client/scripts/.spike-state.json` — operator-controlled state (gitignored)

---

## 2026-05-16 — Phase 5 architecture approved with three modifications

Phase 5 (Telegram bot + Circle Embedded Wallets) is greenlit per the proposal in chat. Three operator-driven modifications applied before any code is written.

### Modification 1: rejected fallback — shared-operator-EOA

The original spike-failure contingency listed "single operator EOA signs all users' orders" as Plan B. **This pattern is rejected.** Reasons:

1. **Looks like market manipulation.** One address placing many trades on behalf of many users — even if every order was a sincere user request — creates the on-chain appearance of coordinated activity. Polymarket monitoring, exchange rules, and any later regulatory attention treat one high-volume address differently from N independent addresses. The pattern is indistinguishable from a single actor running multiple personas to move prices.
2. **Degrades the custody story.** Stoa's pitch is "your funds, your wallet, intelligence served on top." That fundamentally requires per-user wallets. Intermingling user funds in an operator wallet makes the bot a custodian-of-record for pooled funds and changes the regulatory posture.
3. **Builder code attribution doesn't require it.** Per-user wallets attribute to the same builder code without any sharing. The fallback's only "benefit" (a single signer for all orders) provides nothing the per-user design can't.

**Replacement spike-failure contingencies (in priority order):**
- (a) Try **Circle Modular Wallets (MSCA)** as the owner instead of Circle EOA. Accept the cost of validating Polymarket's 1271-chaining behavior.
- (b) **Scope-down to no-on-chain-submit:** ship the bot with insight-engine + Splitter + trace pinning, mock the Polymarket order submission as a "you would have placed this order — open Polymarket UI to actually do it" hand-off. Loses the autonomous trading story but preserves everything else.

### Modification 2: /analyze command + Stoa dogfooding the split

Bot command tree is **/analyze → /preview → /confirm**, with a real on-chain fee at /analyze:

- **`/analyze <url>`** runs `insight-engine.analyzeMarket()` against the URL, pins FullTrace to Arc + IPFS, and returns a summary message. **Costs $0.10 USDC** paid from the user's Circle wallet, settled via the Stoa `stoa-split-evm` scheme through `StoaSettler` on Arc testnet:
  - `$0.07` → operator treasury address
  - `$0.02` → insight-engine maintainers address
  - `$0.01` → Canteen/Agora pool address
  Split is atomic in the StoaSettler call. Trace pin happens after the split clears. **This makes the bot a real Stoa client, not a special-case freeloader.**
- **`/preview`** shows the analysis output formatted as a confirmable order (token, side, price, size, max loss). No additional fee.
- **`/confirm`** submits the prepared order to Polymarket CLOB. Builder-code attribution captures the Polymarket revenue. No additional /confirm fee — the Polymarket builder fee is the revenue capture for this step.

**Open architectural detail (defer to Phase 5 implementation):** /analyze fee lives on Arc, Polymarket trades live on Polygon. Likely path: provision each user's Circle wallet on **both** chains (Circle's `blockchains: ["MATIC", "ARC-TESTNET"]` does this in one API call), so the user has a Polygon balance for Polymarket and an Arc balance for the /analyze fee. Settles cleanly; avoids cross-chain bridging on every analysis call. Verify Circle supports Arc Testnet during the spike.

### Modification 3: /confirm UX requirements

Every `/confirm` message must show inline:
1. **Order details:** token, side, price, size, total exposure (USDC notional).
2. **Current builder fee rate** read from the builder profile API at message-build time, with an explicit **cooldown-disclosure line** when we're still inside the cooldown window: *"Builder fee currently 0/0 bps; rate update unlocks 2026-05-22 13:02 UTC."* After the cooldown, drop the disclosure and just show the rate.
3. **Max-loss line:** *"If this resolves against you, you lose: $X.XX"* — computed from size × (1 − limit_price) for a BUY, or size × limit_price for a SELL.
4. **IPFS CID** for the FullTrace as an inline link to the gateway URL.
5. **Arc tx hash** for the trace-pin tx as an inline link to the Arc explorer.

These five lines are non-negotiable for /confirm — they are how the bot keeps the user informed enough to consent meaningfully, and how Stoa demonstrates the "auditable agent" story to judges.

### Open questions answered

- Storage: D1.
- Onboarding: strong disclosure that wallets are server-custodied; bot links to `/keys` (future export command, not in v0).
- Funding: surface all three paths (raw deposit-wallet address for direct USDC sends, `bridge.polymarket.com` deeplink for other-chain bridging, manual instructions).
- Trace surfacing: inline IPFS CID + Arc explorer link in every /confirm and /preview message.
- Spike: start now, before bot scaffolding.

### Next step

Operator-only spike script: one Circle EOA + one Polymarket deposit wallet + one $1-3 V2 BUY order at limit-below-best-bid, signed via Circle's `signTypedData`, submitted with `signatureType=3 POLY_1271`. Cancel immediately. Budget: ~$3 of pUSD (recoverable on cancel) + a few cents in POL gas. No LLM spend.

### Sig-type confusion resolved authoritatively: WALLET-CREATE deposit wallets = POLY_1271 (3)

Resolved a discrepancy in the spike plan: the original instruction said `signatureType: 1 POLY_PROXY` but the V2 deposit-wallet path requires `signatureType: 3 POLY_1271`. The SDK's source code (`@polymarket/clob-client-v2@1.0.6`) is the authoritative answer. Three pieces of evidence converge:

1. **Enum docstrings** in `dist/order-utils/model/signatureTypeV2.d.cts`:
   - `POLY_PROXY = 1`: *"EIP712 signatures signed by EOAs that own Polymarket Proxy wallets"* — refers to the **legacy Magic-link Proxy product** (email sign-up flow), a different contract type deployed by a different factory.
   - `POLY_1271 = 3`: *"EIP1271 signatures signed by smart contracts. To be used by smart contract wallets or vaults"* — refers to the **V2 deposit wallet**, which is the ERC-1967 proxy deployed by WALLET-CREATE that implements ERC-1271 + ERC-7739 validation.

2. **The ERC-7739 wrapping code path** in `dist/order-utils/exchangeOrderBuilderV2.js`, function `buildOrderSignature`, fires only when `msg.signatureType === SignatureTypeV2.POLY_1271`. It produces the 317-byte envelope (`innerSig + appDomainSeparator + contentsHash + ORDER_TYPE_STRING + lenHex`) with inner typed data using the `"DepositWallet"` domain name and the deposit-wallet address as `verifyingContract`. That envelope is precisely what the V2 deposit wallet's `isValidSignature()` expects. The other three sig types (0/1/2) all skip the wrap and emit a plain EIP-712 signature, which the V2 deposit wallet rejects.

3. **WALLET-CREATE factory `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07`** is the V2 deposit-wallet factory (per [docs.polymarket.com/trading/deposit-wallets](https://docs.polymarket.com/trading/deposit-wallets)). Not the legacy Magic-link Polymarket Proxy factory. The same source explicitly says the deployed wallet uses ERC-1271 validation — i.e., POLY_1271 (3).

The naming is genuinely confusing because "proxy" appears in both products and the V2 deposit wallet *is* technically an ERC-1967 proxy. The disambiguation: POLY_PROXY (1) is for the *historical Polymarket-branded* Magic-link product specifically. POLY_1271 (3) is the generic ERC-1271 path that the new V2 deposit wallet implements.

Locked: **spike uses `SignatureTypeV2.POLY_1271 (3)`**. Documented here so Phase 5 bot code doesn't re-derive this from scratch.

---

## 2026-05-15 — insight-engine end-to-end working, first FullTrace pinned to Arc

**Status:** Phase 3 (multi-agent Polymarket analysis) done. `packages/insight-engine/` ships `analyzeMarket(url, balance)` — 4 specialist Claude agents (News, Sentiment, Historical, Market Structure) fanned out in parallel, Sonnet 4.6 Judge aggregator, FullTrace hashed + pinned to IPFS via Pinata + anchored on-chain via `TracePin.pinTrace()`.

### First successful run (proof of life)

- Input URL: `polymarket.com/event/what-will-trump-say-during-bilateral-events-with-xi-jinping` (event with 33 sub-markets)
- Auto-selected highest-volume sub-market: `"Will Trump say 'Iran' during events with Xi Jinping?"` ($484k volume)
- Total real LLM spend: $0.3334 (one analysis, end-to-end)
- Arc tx: `0xf754404bf78221785708ae802083d9d43e2a74a30f91bf4dfbd976e99a8a590d` @ block 42285533
- IPFS CID: `QmUvQtmL8E8DqM2kwsRZg7udnHCnAc3fzLNf9ZFzHfmFfH` (Pinata)
- Trace hash: `0x04f6f5ea402ae96e502eb2ebd356f221050b4e44e8fec8658bab63c15e4062e4`

### Three bugs hit on the way to a clean run

All three were Anthropic `output_config.format` structured-outputs constraint violations that the per-SDK doc warns about but I missed:

1. **Integer `minimum`/`maximum` rejected.** `confidence: {type: "integer", minimum: 0, maximum: 100}` → 400. Removed numeric bounds from the schema; relying on the model + client-side clamping for size enforcement.
2. **Number `minimum` on `recommended_size_usdc` rejected** — same root cause. Removed.
3. **`additionalProperties: { type: "object", ... }` rejected** — must be `false`. Rewrote `agent_signals` from a record-with-additional-properties schema to a fixed 4-key shape (`news`/`sentiment`/`historical`/`market_structure`). More precise anyway.

**Lesson:** structured-outputs schemas accept only the JSON-Schema subset listed in the API docs. Type+enum+required+`additionalProperties:false`. No `minimum`/`maximum`/`minLength`/`pattern`/`additionalProperties:<object>`. Validate client-side.

### Cloudflare 403 challenge on judge call

Run #4 hit a Cloudflare interstitial (HTML response, not JSON) on the Sonnet 4.6 Judge call after all 4 specialists succeeded. Looked like a WARP↔Cloudflare interaction — first 4 calls fine, the 5th tripped a heuristic. Added a `createWithRetry` wrapper in `src/claude.ts` that handles 403/408/429/5xx with 2s/4s exponential backoff (the SDK's auto-retry doesn't cover 403). 400/401/404 are never retried — those are caller bugs.

### Architecture decisions worth remembering

- **Model split:** Haiku 4.5 for News, Sentiment, Market Structure (task-bound work). Sonnet 4.6 + adaptive thinking for Historical (deep reasoning) and Judge (highest-leverage call). Substituted `claude-sonnet-4-6` for "Sonnet 4.7" since the latter doesn't exist (latest Sonnet is 4.6).
- **Prompt caching wired throughout.** System prompts sized past each model's minimum cacheable prefix (4096 tok Haiku, 2048 Sonnet). Verified — Historical's first run showed 2020 cache_read tokens on a re-warm.
- **Budget cap enforced mid-pipeline.** If 4 specialists spend >50% of budget cap, the orchestrator aborts before committing to the expensive Sonnet Judge call.
- **Pin pipeline degrades gracefully.** Missing IPFS backend → empty CID on-chain (hash still anchored). Pinata preferred over Storacha because Storacha needs a one-time CLI ritual to mint a UCAN delegation proof; Pinata is just a JWT.
- **Event-URL handling.** `fetchMarketContext()` tries `/markets?slug=` first, falls back to `/events?slug=` and picks the highest-volume sub-market when the URL is an event. Logs the selection.

### Known issues from the first run (queued for next iteration)

- **News + Sentiment agents silently failed** on the Trump/Xi run; orchestrator dropped the errors because the `agentTraces.length < 2` failure gate didn't trip. Patched `src/index.ts` to always `console.warn` failed specialists. Root cause TBD — needs a re-run with diagnostic logging on a non-resolved market.
- **Market Structure burned 115k input tokens** on the orderbook tool round-trip. The tool currently dumps raw `price_history_1d` arrays which are large. Need to compress to compact stats only.

---

## 2026-05-15 (later) — both bugs above fixed

### Root cause of News + Sentiment failures: `web_search_20260209` defaults to PTC mode

When diagnostic logging surfaced the error, it was crystal clear:

```
'claude-haiku-4-5-20251001' does not support programmatic tool calling.
The following tools have `allowed_callers` that require it: web_search.
Explicitly set `allowed_callers=["direct"]` on these tools, or use a
model that supports programmatic tool calling.
```

**Why this bites:** Anthropic's newer `web_search_20260209` tool defaults to **programmatic tool calling (PTC)** mode — the model writes Python code inside the code-execution container, the code calls `web_search()` as a function, and only the *final* return value flows back to the model. PTC requires a model that supports it; Haiku 4.5 doesn't. Sonnet does.

The classic shape — `tool_use` → `tool_result` round-trip — is opt-in on `web_search_20260209` via `allowed_callers: ["direct"]`. The older `web_search_20250305` version doesn't have PTC, so it would have worked out of the box, but I picked the newer version off the live-sources table without spotting the PTC default.

**Fix:** added `allowed_callers: ["direct"]` to both News and Sentiment agents' web_search tool definitions (`src/agents/news.ts`, `src/agents/sentiment.ts`). One-line each. Re-ran — all 4 specialists now succeed.

**Lesson for Phase 4+:** when adding a server-side tool with a date-suffixed version, check the tool's defaults table. PTC is opt-in for older models even when the tool itself is the latest version.

### Market Structure compression: 115,232 → 6,109 input tokens (94.7% reduction)

Refactored the tool to drop raw `price_history_1d` arrays and return only signal-dense summaries:

| Old (115k tokens) | New (6.1k tokens) |
|---|---|
| Full 1d price history (often 100+ raw timestamp/price tuples per side) | `trajectory`: `pct_change_{1h,6h,24h}` + one-word label (rising/falling/sideways/volatile) |
| `OrderbookSummary` with top-5 depth + total | `OrderbookSummary` with top-3 depth (price, size_usdc) tuples + mid |
| No flow data | `FlowSummary` from `data-api.polymarket.com/trades?market=<condition_id>` — sample size, notional total, large-trade count >$1k, largest trade, 24h volume from Gamma metadata |

Helpers live in `src/polymarket.ts`: `summarizeOrderbook`, `summarizePriceHistory`, `getFlowSummary`. Each tool response now ~1KB.

**Bonus finding:** the compressed signal is *more* useful, not less. Market Structure went from confidence 42 on the bloated input to 72-88 on the compact input — clearer data = more decisive agent.

### Prompt cache hits showing up

Final run telemetry:
- Historical: input=3, output=2074, cache_read=**2020** — the entire system prompt served from cache
- Judge: input=4115, output=4465, cache_read=**2950** — Judge prompt cached too

Cache reads cost ~10% of base input, so this is real money saved on repeat analyses. The minimum-prefix sizing (system prompts past 2048 tok for Sonnet, 4096 for Haiku) is paying off as designed.

### Open follow-up: position sizing ignores market price

Side-effect of running the Starmer market (YES at 5.5¢) — Judge recommended `$10` (10% of $100 bankroll) on a NO signal with 68% subjective probability, but Kelly fraction is **0.00%**. Buying NO at 94.5¢ requires subjective probability > 0.945 to be +EV; ours is 0.68. The orchestrator's "confidence 60-70 → 10%" heuristic doesn't consult the market price, so it sizes positions that Kelly says have negative expected value.

**Fix to consider in next iteration:** have the Judge see `current_yes_price` and integrate Kelly into its size logic, or apply a Kelly cap server-side in `enforceSizeBounds`. Not urgent but worth knowing about before any real money goes through the pipeline.

---

## 2026-05-14 (later) — CCTP mainnet→testnet route resolved: NOT supported, mirror service plan locked

### Finding

CCTP V2 attestation services are environment-isolated. Two pieces of evidence:

1. **Separate IRIS hosts.** Mainnet: `https://iris-api.circle.com`. Testnet/sandbox: `https://iris-api-sandbox.circle.com`. The two services run independent attester sets and signing keys (per Circle's docs).
2. **Disjoint domain ID spaces.** Arc Testnet is domain `26` in the *testnet* CCTP V2 registry. Polygon mainnet is domain `7` in the *mainnet* CCTP V2 registry. A mainnet `TokenMessengerV2.depositForBurn(amount, destinationDomain=26, ...)` either reverts because mainnet does not recognize `26` as a registered destination, or burns successfully but no attestation is ever produced because mainnet IRIS does not sign for testnet destinations.

The docs do not explicitly say "no cross-environment routes are supported" in those words, but the architecture and tooling all point in that direction. There is no plausible interpretation under which a mainnet Polygon burn can be minted on Arc Testnet via CCTP. **Treat as unsupported.**

### Consequence: mirror service required

To complete the demo loop (Polymarket builder fees on Polygon mainnet → Stoa Splitter on Arc Testnet), we need a small off-chain mirror that watches one wallet on each side and re-emits matching transfers across environments. Roughly:

```
┌──────────────────────────────────────────────────────────────┐
│  Polygon mainnet                                              │
│  - "operator-bridge" EOA receives native USDC from            │
│     bridge.polymarket.com/withdraw                            │
│  - Mirror watcher reads Transfer events to this address       │
└──────────────────────────────────────────────────────────────┘
                          │ (off-chain notification)
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  Mirror service (Cloudflare Worker cron, ~30 lines)           │
│  - For each detected Polygon receipt of N USDC                │
│  - Sends N testnet-USDC on Arc Testnet from "mirror" EOA      │
│    to the configured destination (Splitter / StoaSettler)     │
│  - Records the cross-env mapping (polygon tx hash ↔ arc tx)   │
│    for audit                                                  │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
                  Arc Testnet, StoaSettler / Splitter
```

**Trust model.** The mirror's authority is centralized (operator-controlled key). The dashboard surfaces every mirror tx with its corresponding Polygon source tx so the operation is fully auditable. For the hackathon demo this is acceptable; production would replace this with either (a) a real mainnet→mainnet CCTP route once Arc launches mainnet, or (b) a permissioned attestation contract that any party can call with a signed mainnet message.

**Funding the mirror's testnet wallet.** ~50 testnet USDC from Circle faucet on Arc Testnet is plenty for the hackathon volume (sub-1-USDC trades).

**Implementation scope.** Not building this yet. Punt to Phase 4 (after StoaSettler is live and the bot can call `bridge.polymarket.com/withdraw`). Estimated ~30 lines of TS in a CF Worker cron + ~15 lines for the audit log table.

### Open items closed by this entry

- [x] Does CCTP V2 attestation API accept Polygon-mainnet (7) → Arc-testnet (26)? **No.** Mirror service required.

### Open items still open

- [ ] USYC on Arc Testnet — confirmed deployed at `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` (resolved 2026-05-14 earlier via docs.arc.io/arc/references/contract-addresses).
- [ ] Confirm Polymarket builder fee transfer is atomic-on-settlement vs batched (still requires live trade observation).
- [ ] Read `api-reference/geoblock.md` before wiring up the bot.
- [ ] Apply for Polymarket Verified tier (day-2 todo, email `builder@polymarket.com`).

---

## 2026-05-14 (late) — Phase 1 kickoff: clarifications & contract address table

### Key clarification: operator funding model

**Users bring their own USDC for bets. We do NOT fund user bets.** This is materially different from a "we operate a trading pot" model and should be stated explicitly in the README and bot UX.

- Operator only needs ~**$5 of MATIC on Polygon** for operator admin transactions: builder profile setup, periodic fee withdrawals via `bridge.polymarket.com/withdraw`, and any one-off contract calls. That's the entire operator bankroll requirement on the Polygon side. No bankroll on Arc side (USDC is the gas asset and testnet USDC is faucet-able).
- Each user supplies their own pUSD (which they get by depositing USDC into Polymarket from any supported chain). The Telegram bot guides them through this with the Circle Embedded Wallet + Polymarket bridge endpoint.
- Builder fees are denominated as a percentage of the user's *own* trade size, so revenue scales with user volume, not with operator capital. The operator's downside is zero on individual trades — at worst, a user takes a bad recommendation, but the operator's USDC was never at risk.
- Risk note #1 in the prior entry ("real-money exposure, cap at 50 USDC bankroll, hard size limit per trade") is **no longer applicable** — there is no operator bankroll. **Supersedes that risk note.** The relevant risk is reputational: a user blindly trusts a recommendation and loses their own money. Mitigation: every recommendation surfaces Kelly fraction, Bayesian probability, top-3 risks, and a confirm step before the bet is placed.

### Quick-reference contract addresses (sourced from RESEARCH_POLYMARKET.md)

| Contract | Address | Network |
|---|---|---|
| CTF Exchange V2 (standard) | `0xE111180000d2663C0091e4f400237545B87B996B` | Polygon mainnet |
| CTF Exchange V2 (neg-risk) | `0xe2222d279d744050d28e00520010520000310F59` | Polygon mainnet |
| Conditional Tokens (CTF) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | Polygon mainnet |
| pUSD (proxy) | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` | Polygon mainnet |
| CollateralOnramp (USDC.e → pUSD) | `0x93070a847efEf7F70739046A929D47a521F5B8ee` | Polygon mainnet |
| CollateralOfframp (pUSD → USDC.e) | `0x2957922Eb93258b93368531d39fAcCA3B4dC5854` | Polygon mainnet |
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | Polygon mainnet |
| Deposit Wallet Factory | `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` | Polygon mainnet |

The agent code must always select between the standard and neg-risk exchange addresses based on `market.neg_risk` returned from the CLOB. Hard-coding either one is a latent bug.

### Canonical agent setup (lock this in `apps/bot/src/polymarket/client.ts`)

```ts
import { ClobClient, SignatureTypeV2, Side, OrderType } from "@polymarket/clob-client-v2";

const client = new ClobClient({
  host: "https://clob.polymarket.com",
  chain: 137,                              // Polygon mainnet — no testnet exists
  signer,                                  // EOA signer (private key)
  creds: apiCreds,                         // from createOrDeriveApiKey()
  signatureType: SignatureTypeV2.POLY_1271, // value 3 — deposit wallet
  funderAddress: depositWalletAddress,     // smart-account, deployed via relayer WALLET-CREATE
});

// Per-order — read tick size and negRisk fresh every time
const market = await client.getMarket(conditionId);
const response = await client.createAndPostOrder(
  { tokenID, price, size, side: Side.BUY, builderCode: BUILDER_CODE_BYTES32 },
  { tickSize: String(market.minimum_tick_size), negRisk: market.neg_risk },
  OrderType.GTC,
);
```

### Operator day-2 todos (do not forget)

- [ ] Email `builder@polymarket.com` with the registered API key + use case + expected daily volume to apply for **Verified tier** (10K relayer txns/day, up from 100). Phrase the use case as "open-source agentic facilitator routing user-confirmed trades through Polymarket with builder attribution, settling proceeds via Circle CCTP to Arc."
- [ ] Verify USYC is deployed on Arc Testnet before wiring the operator-share auto-deposit. If only on mainnet, stub it with a yield-token mock on Arc Testnet (operator share goes to mock vault, dashboard shows "would be USYC" rendered).
- [ ] Confirm CCTP V2 accepts mainnet-source → testnet-destination (Polygon domain 7 → Arc Testnet domain 26). If not, build the 30-line mirror service (pre-funded testnet USDC EOA that emits matching transfers when it sees receipts on the Polygon mainnet EOA).

### Reaffirmed (no change from prior entry)

- pUSD → native USDC redeem path is `POST https://bridge.polymarket.com/withdraw` with `toChainId: 137` and `toTokenAddress = native USDC`. Instant, free, permissionless.
- Per-order `builderCode` (bytes32) attached to every `createAndPostOrder` call. No retroactive attribution.
- L1 vs L2 in the docs = API access tiers, not signature types. Signature types are 0/1/2/3 = EOA/POLY_PROXY/GNOSIS_SAFE/POLY_1271.
- Stoa contracts (Splitter + TracePin) live on Arc Testnet regardless of how USDC arrives. Same code whether the fee path is CCTP-direct or mirror-service.

---

## 2026-05-14 — Polymarket research pass forces hybrid mainnet/testnet architecture

### What changed

The initial brief assumed a "fees flow Polymarket on Polygon mainnet → CCTP → Stoa on Arc mainnet" loop. Today's doc-learning pass invalidates that, in two directions:

1. **Arc is testnet-only** (already known from yesterday — confirmed in CCTP V2 supported chains: Arc = domain 26, testnet only).
2. **Polymarket is mainnet-only.** The CLOB, pUSD, builder leaderboard, deposit wallets, and bridge endpoints all run on Polygon mainnet (chain 137) with no Amoy equivalent. Confirmed from `docs.polymarket.com/resources/contracts.md` (*"all Polymarket contracts are deployed on Polygon mainnet"*) and the API introduction page (only mainnet hosts listed).

These two facts together rule out **both** a full-mainnet loop and a full-testnet loop. A hybrid is the only path.

### New architecture (locked in)

```
┌─────────────────────────────────────────────────────────┐
│  POLYGON MAINNET (real USDC, small bankroll)            │
│  - Agent has deposit wallet (POLY_1271, signatureType 3)│
│  - Agent has Unverified-tier builder code (bytes32)     │
│  - Trades CTF Exchange V2 with builderCode on order     │
│  - Builder fee lands as pUSD in the builder profile     │
│    wallet, per-trade (verify atomic vs batched after    │
│    first live fill)                                     │
│  - Agent calls POST bridge.polymarket.com/withdraw      │
│    to convert pUSD → native USDC on Polygon (instant,   │
│    free, permissionless)                                │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼  (native USDC on Polygon)
┌─────────────────────────────────────────────────────────┐
│  CCTP V2 — Polygon (domain 7) → Arc Testnet (domain 26) │
│  *** OPEN QUESTION: does CCTP V2 allow                  │
│  mainnet-source → testnet-destination? ***              │
│  If yes: direct CCTP burn + mint, ~8-20s finality.      │
│  If no: "mirror service" (~30 lines TS) watches the     │
│  Polygon USDC receipt and re-emits an equivalent        │
│  pre-funded testnet USDC transfer on Arc Testnet.       │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼  (USDC on Arc Testnet)
┌─────────────────────────────────────────────────────────┐
│  ARC TESTNET (USDC-native gas, all Circle products)     │
│  - Stoa facilitator (Cloudflare Worker)                 │
│  - Splitter.sol — 60% operator / 20% user / 15% Polyseer│
│    / 5% Canteen/Agora                                   │
│  - TracePin.sol — pins reasoning-trace hashes           │
│  - Operator's 60% auto-deposits to Circle USYC          │
│    (verify USYC is on Arc Testnet before locking this)  │
│  - Circle Embedded Wallets via App Kit (Telegram users) │
│  - Circle Paymaster (users pay gas in USDC)             │
└─────────────────────────────────────────────────────────┘
```

### Why this is still good for judging

- **Traction (30%):** trades are real Polygon mainnet txs with real Polymarket builder fees. Judges can verify on Polygonscan.
- **Circle (20%):** all five Circle products still in the loop — Arc, USDC, CCTP V2, Embedded Wallets, Paymaster, USYC. Touching every Circle product remains the goal.
- **Agentic (30%):** the Polymarket-mainnet leg means the agent is committing real capital to its own decisions, which is more agentic than placing fake trades.
- **Innovation (20%):** the cross-chain split-on-settle pattern (Polymarket mainnet trade → CCTP → atomic Arc settlement that simultaneously distributes to 4 stakeholders and earns USYC yield) is the unique synthesis. The hybrid setup is honest, not a workaround.

### Risks introduced by the change

1. **Real-money exposure.** Bankroll is real. Cap it: agent operates with ≤ 50 USDC on Polygon, hard size limit per trade (e.g., ≤ 5 USDC), refuses to trade if balance < 5 USDC. Encode the cap in code, not config.
2. **Builder relayer cap is 100 txns/day on Unverified.** Wallet deployment + approvals burn ~3 of those upfront. Withdrawals also count. The actual order placements don't appear to count (CLOB does them off-relayer), but every fee bridge-out does. Plan: batch fee withdrawals — only call `bridge.polymarket.com/withdraw` once per session/day, not after every fill. **File for Verified-tier upgrade on day 2** (email builder@polymarket.com with API key + use case + expected volume).
3. **CCTP mainnet→testnet routing.** Open question; needs verification before we write the CCTP integration. If unsupported, the mirror service is fine but adds a small attack surface (the mirror's pre-funded testnet wallet is a trust point in the demo). Mitigation: scope the mirror's authority tightly — it can only emit testnet USDC equal to amounts it sees received on its specified Polygon address.
4. **USYC on Arc Testnet.** Not yet verified — if USYC is mainnet-only, we either drop the auto-deposit step (lose part of the Circle story) or simulate it with a stub yield-token contract on Arc Testnet. Verify before scaffolding the operator-share flow.
5. **No Polymarket testnet means we can't run integration tests against a real CLOB without spending mainnet USDC.** Mitigation: mock the Polymarket client in unit tests, and treat the first 5-10 mainnet trades as "integration tests" with sub-$1 sizes.

### Decisions locked

- **signatureType: 3 (POLY_1271, deposit wallet) for the agent.** Pairs with relayer for gas-free approvals and CTF ops, and is the recommended path for new API users.
- **Bridge endpoint, not direct CollateralOfframp call, for fee unwrap.** One call instead of two; Polymarket pays the gas; gets us native USDC directly.
- **Per-order builderCode field.** Set on every `createAndPostOrder` invocation. No retroactive attribution.
- **Two exchange-contract code paths.** Always read `market.neg_risk` and pass it through to order options. Don't hard-code `negRisk: false`.
- **Tick size read from the market object before each order.** Don't hard-code `"0.01"`.

### Open items still to verify (do these inside the next 24h)

- [ ] Does CCTP V2 attestation API accept Polygon-mainnet (7) → Arc-testnet (26)? If no, build the mirror service.
- [ ] Is USYC deployed on Arc Testnet, and what's the deposit interface?
- [ ] Confirm builder fee transfer is atomic-on-settlement vs batched (check CTF Exchange V2 source on Polygonscan, or observe our own first live trade).
- [ ] Read `api-reference/geoblock.md` — make sure our origin and registered country aren't restricted.
- [ ] Try the Polymarket MCP tool (`SearchPolymarketDocumentation`) next session as a cross-check of today's WebFetch findings — especially on builder fee payout mechanics, since that's the corner of the docs that was thinnest.

### Reaffirmed from initial pass

- 4-way revenue split: 60% operator / 20% user / 15% Polyseer / 5% Canteen-Agora (per project memory).
- Stack: TS everywhere except Solidity in `/contracts`. Foundry for tests. Cloudflare Workers + Hono for facilitator. Next.js + Tailwind for dashboard. grammY for Telegram bot.
- Phase 1 next: scaffold the monorepo and write Splitter.sol + TracePin.sol with Foundry tests on Arc Testnet. The architecture above doesn't change that — Splitter/TracePin are the same regardless of whether USDC arrives via CCTP or via the mirror service.

---

## Polymarket builder fees, V2 order schema, and `feeRateBps` (2026-05-15)

Surfaced from the Phase-4 smoke-test review: the prepared order showed `fee_rate_bps: 0` and we needed to know whether builder revenue still flows under that condition. Tracing it through both Polymarket docs and the SDK source resolved a few things at once.

### Authoritative answer: builder fees DO flow with `feeRateBps=0` — because V2 dropped the field entirely

Per [Polymarket Builder Fees](https://docs.polymarket.com/builders/fees):

- **Builder fees are configured off-chain in your builder profile**, not on the order. Two knobs: `builder_taker_fee_bps` (max 100 bps = 1%) and `builder_maker_fee_bps` (max 50 bps = 0.5%). Set at polymarket.com/settings?tab=builder.
- **Fees flow automatically when `builderCode` is on the order** — "When a builder attaches their unique builder code to an order and that order matches, a builder fee is collected alongside any platform fee."
- **Builder fees stack additively on top of platform fees** — they don't replace them.
- **Platform fees themselves are set at match time** in V2, not on the order ([Polymarket Changelog](https://docs.polymarket.com/changelog)). The order's old `feeRateBps` field was removed in the April 2026 V2 upgrade.

So: there's no per-order fee rate to configure for builder revenue, and the smoke-test output showing `fee_rate_bps: 0` was a phantom from a V1-shaped reconstruction in our wrapper — not a real V2 field. **Builder revenue is gated on (a) having registered as a builder, (b) setting non-zero rates on the builder profile, and (c) including `builderCode` on each order.** The on-chain order struct itself doesn't carry a rate.

### Operational follow-up for ourselves

The smoke test will show `builder: 0xff2fdfbfe1…` matching `POLY_BUILDER_CODE`. That's the necessary condition. For the **sufficient** condition (actually earning fees), the operator (or the autonomous bot in Phase 5) must have:

1. Registered the builder profile at polymarket.com/settings?tab=builder against the **funder address** that posts the orders.
2. Set `builder_taker_fee_bps` and/or `builder_maker_fee_bps` > 0 on that profile.

Without step 2, `getBuilderTrades()` will return rows with `fee: "0"`. Worth verifying via a single submitted order before scaling.

### V2 EIP-712 Order schema — authoritative from the SDK

Both the docs and `clob-client-v2@1.0.6` source (`dist/order-utils/model/ctfExchangeV2TypedData.js`, `dist/order-utils/exchangeOrderBuilderV2.js`) agree on this exact V2 Order type:

```
Order(
  uint256 salt,
  address maker,
  address signer,
  uint256 tokenId,
  uint256 makerAmount,
  uint256 takerAmount,
  uint8   side,           // 0 = BUY, 1 = SELL
  uint8   signatureType,
  uint256 timestamp,      // ms; replaces V1's nonce for per-address uniqueness
  bytes32 metadata,
  bytes32 builder
)
```

- **Removed from V1:** `taker`, `nonce`, `feeRateBps`. (Docs also list `expiration` as removed; the SDK source keeps `expiration` on the SignedOrder wire format but does NOT include it in the EIP-712 hash. So orders with `expiration > 0` are still GTD-style, but the field doesn't affect the signed hash.)
- **Added in V2:** `timestamp` (ms), `metadata`, `builder`.
- **Domain version bumped from `"1"` to `"2"`.** Domain name stays `"Polymarket CTF Exchange"`. `verifyingContract` is `exchangeV2` for standard markets (`0xE111180000d2663C0091e4f400237545B87B996B`) and `negRiskExchangeV2` for neg-risk (`0xe2222d279d744050d28e00520010520000310F59`).

### Fix landed in `packages/polymarket-client/src/index.ts`

The wrapper's `prepareOrder` was reconstructing EIP-712 typed data with the V1 schema. Operators inspecting `prepared.typedData` would have seen V1 field names (`feeRateBps: "0"`, `nonce: "0"`, `taker: 0x…`) for an order the SDK actually signed against the V2 schema — the signature would not verify against the reconstruction. Now corrected:

- `ORDER_EIP712_TYPES` mirrors `CTF_EXCHANGE_V2_ORDER_STRUCT` from the SDK.
- Domain version is `"2"`.
- Typed-data message includes `timestamp`, `metadata`, `builder` and drops the V1-only fields.
- Summary surfaces `timestamp`, `metadata`, `builder` (the actual on-order field) plus our configured `builder_code` and the wire-only `expiration`. No more phantom `fee_rate_bps`.

10 mocked unit tests still pass; live e2e is gated and untouched.

---

## Polymarket Builder Profile: 7-Day Fee Update Cooldown (2026-05-15)

Polymarket enforces a **7-day cooldown between `builder_taker_fee_bps` / `builder_maker_fee_bps` updates** on the builder profile. Discovered the hard way trying to update fees on **2026-05-15**; next allowed update is **2026-05-22 13:02 UTC**.

### Implications

- **Initial profile setup should set realistic non-zero values immediately, not zero defaults.** A new builder who registers with `0/0` (because they're "just setting it up first") locks themselves out of fee revenue for the next 7 days. Pick your taker/maker rates in advance and set them on the very first save.
- **For demos inside the cooldown window, on-chain builder code attribution still works.** Trades attributed to our `builder` field continue to show up in `getBuilderTrades()` — the cooldown only gates the *rate change*, not the attribution mechanism. So the Stoa demo can still prove the attribution flow end-to-end on Polymarket mainnet even while fees are stuck at zero; revenue numbers from the cooldown window will read $0, but the trade-attribution evidence is intact.
- **Recommended Polymarket UX improvement:** warn users at profile creation that **"0 means you earn nothing for the next 7 days"** — a single inline note next to the fee inputs at first save would prevent this. The cooldown itself is reasonable anti-abuse behavior, but defaulting to zero with no warning makes the default the trap.

### Feedback-incentive angle (Circle developer tooling, $500)

By extension, any developer onboarding Polymarket as a payment leg via Circle's stack hits this same trap. Circle's Polymarket integration docs (and any "your prediction-market-payments quickstart" surface Circle ships) should surface the 7-day cooldown explicitly — ideally with a "set non-zero rates on first save" callout in the builder-profile section of the quickstart. Worth raising in the hackathon feedback channel since:

1. The trap is invisible until the developer ships and notices zero revenue 24h later, by which point they've already lost ~6 days of attribution they could have been earning on.
2. The fix is a one-line doc addition, not a protocol change.
3. It compounds Circle's value prop ("we make Polymarket-on-Circle frictionless") if the docs catch this and Polymarket's own UI doesn't.

### Recovery plan for Stoa

- **2026-05-15 → 2026-05-22:** continue smoke testing and Phase 5 wallet wiring; trades on Polymarket mainnet in this window earn $0 fees but still produce attribution rows in `getBuilderTrades()` that we can show judges as proof-of-flow.
- **2026-05-22 13:02 UTC:** as soon as the cooldown clears, set `builder_taker_fee_bps = X` and `builder_maker_fee_bps = Y` (TBD — pick conservative values well under the 100/50 bps caps to avoid being noticeably more expensive than competing front-ends). Lock in the rates before the demo recording.
- After this initial update, treat the 7-day cooldown as load-bearing: don't tweak rates again unless we genuinely have to.

---

## Polymarket V2 Proxy Wallet Requirement (2026-05-15)

The Phase-4 live submission attempt surfaced this: **Polymarket V2 CLOB rejects direct EOA orders on mainnet.** Every signed order we tried (V2 EIP-712, valid signature, valid builder code) was rejected at the API layer with HTTP 400 and:

```
{"error":"maker address not allowed, please use the deposit wallet flow","status":400}
```

…even though wallet state was fully set up (pUSD held by the EOA, MaxUint256 allowances to both standard and neg-risk CTF Exchange V2 contracts, valid POL for gas).

### What's actually required

The CLOB rate-limits `maker` addresses by their *registration path*. Three signature types exist:

| value | name | maker = | accepted on mainnet? |
|---|---|---|---|
| 0 | `EOA` | EOA itself | ❌ rejected |
| 1 | `POLY_PROXY` | Magic-link proxy wallet (UI sign-up flow) | ✅ |
| 2 | `POLY_GNOSIS_SAFE` | Gnosis Safe-style proxy (self-custody connect flow) | ✅ |
| 3 | `POLY_1271` | EIP-1271 smart-contract signature wallet | ✅ (this is what we want for Phase 5) |

The EOA-direct path (`signatureType = 0`, `maker = signer = EOA`) appears to be reserved for SDK testing — production CLOB rejects it. Maker has to be a proxy/safe/1271 contract registered through Polymarket's deposit flow, which:

1. Deploys a deterministic proxy contract for the EOA (via Polymarket's factory at `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07`).
2. Registers the proxy in Polymarket's `Deposit Wallet` registry.
3. Funds the proxy with pUSD (the UI handles the USDC → USDC.e → pUSD path inside the proxy).
4. Sets allowances *from the proxy* to the CTF Exchange V2 contracts.

After that, orders signed by the EOA but with `maker = proxy_address` and `signatureType = 1, 2, or 3` are accepted.

### What the smoke test does and doesn't prove

**Proven (gold by the operator-gated smoke test):**

- V2 EIP-712 typed data is reconstructed correctly in `packages/polymarket-client` (11-field Order, domain version 2, all V2 fields surfaced).
- Order is signed correctly — signature recovers to the EOA we configured.
- Builder code is attached on the `builder` bytes32 field (`0xff2fdfbfe1…`).
- pUSD is held + approved on Polygon mainnet to both standard and neg-risk exchange V2 contracts.
- Polygon mainnet setup script (`setup-pusd.ts`) is idempotent and works end-to-end: 4 mainnet txs total cost 0.074 POL gas (~$0.04).

**Not proven:**

- Live order acceptance on the CLOB. The path is gated on the proxy-wallet registration step we did not perform with the deployer EOA.

### Why we're deferring rather than completing the proxy flow

The cleanest path to a registered proxy involves logging the deployer EOA into the polymarket.com UI (browser wallet), which would mean exporting the deployer's hot private key into MetaMask. Marginal demo value (a single $1 order sitting in the book) is not worth the operational risk or the ~1-2 hours to script around it.

**Phase 5 obviates this entirely.** When users deposit through the Telegram bot, their funds land in a Circle Embedded Wallet — an ERC-4337 smart account that signs via EIP-1271. That's `signatureType = 3 (POLY_1271)`, which is the same flow Polymarket's docs recommend as the modern path for new integrations. The user's Circle wallet IS the deposit wallet from Polymarket's perspective; no separate proxy registration step.

So the Phase-4 deferral isn't a gap — it's a deliberate choice not to duplicate work that the production user flow solves natively.

### Feedback-incentive angle (Circle developer tooling, $500)

Two surfaces worth flagging:

1. **Polymarket docs.** The "deposit wallet" requirement is mentioned in V2's onboarding flow but the docs don't clearly say "direct EOA orders are rejected on mainnet." A developer building an agentic/programmatic integration from scratch will spend hours on this. One sentence in the order-submission docs ("Orders must be submitted from a registered deposit wallet — see [link]") would have saved the entire afternoon. Suggested copy already drafted; will submit to feedback@polymarket.com after the hackathon.
2. **Circle's Polymarket story.** Circle's Embedded Wallets are a *natural* fit for Polymarket's POLY_1271 path — every Circle smart account is already an EIP-1271 signer. Circle's quickstart for "Polymarket on Circle" (if/when it exists) should make this an explicit two-step recipe: (a) provision a Circle wallet, (b) register as a Polymarket deposit wallet by depositing through `bridge.polymarket.com` from the Circle wallet address. Stoa's Phase 5 will validate this flow live; we can write up the recipe for Circle's docs as part of the hackathon feedback submission.

### Wallet state after deferral

Deployer `0x5342ac8383c39bf680a4035C02EcACdc8E412435` is left in this state — useful to know if we ever resume this path:

- 19.78 POL (gas headroom for any future Polygon-mainnet operator action)
- 0 USDC.e (wrapped)
- 4.99 pUSD (sitting in the EOA — would need to be transferred to a registered proxy to be tradeable)
- MaxUint256 allowance pUSD → standard CTF Exchange V2
- MaxUint256 allowance pUSD → neg-risk CTF Exchange V2

If we ever resurrect the operator-EOA submission path (e.g., for a one-off mainnet trade signed by Stoa rather than by a user), the work needed is: deposit the EOA into Polymarket via UI to deploy a proxy, transfer 4.99 pUSD to the proxy, set proxy-side allowances, then re-run smoke:submit with `signatureType` switched to 1 or 2 and `funderAddress` pointed at the proxy.
