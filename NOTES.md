# NOTES.md — running architecture log

Living document for architecture decisions and the reasons behind them. Newest entry at the top. Pair with `RESEARCH_POLYMARKET.md` for source citations.

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
