# @stoa/bot

Stoa InsightAgent — Telegram bot on Cloudflare Workers + grammY + D1.

## Alignment with Arc Prediction Markets Blueprint

Arc's [institutional-grade prediction markets blueprint](https://www.arc.io/blog/build-institutional-grade-prediction-markets-on-arc-arc-blueprints) (2026-05-08) names four capabilities that prediction markets on Arc should exercise. The bot is built directly against each one:

| Arc Blueprint capability | How the bot exercises it |
|---|---|
| **Information infrastructure** — "Prediction markets can serve not only as trading venues, but also as onchain information infrastructure. They can aggregate market signals, help participants coordinate around uncertain outcomes, and settle in real time." | Every `/analyze` call runs a 4-agent + Judge reasoning pipeline and **pins a hash of the full reasoning trace to Arc** (`TracePin.pinTrace`) in the same atomic tx that splits the user's fee. The market signal *and* the analysis that produced it are both onchain artifacts. |
| **Deterministic finality** — "Deterministic finality can give markets clear settlement outcomes, while auditability can help support verification and operational trust." | Each `/analyze` and `/confirm` produces a single Arc tx that pulls the user's USDC via EIP-3009, splits 70/20/10 across recipients, and (for `/analyze`) emits a `TracePin` event. One tx = one verifiable outcome. Auditable by tx hash on `testnet.arcscan.app`. |
| **Multi-currency settlement** — "A market tied to European inflation could settle in EURC, while a market focused on US policy expectations could settle in USDC." | `Splitter.sol` is token-agnostic — `distribute(address token, …)`. We've probed EURC at `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` on Arc Testnet and confirmed it is a FiatTokenV2 with EIP-3009 readiness. `apps/bot/scripts/probe-eurc.ts` exercises the EURC split path end-to-end. EURC-denominated fee flows require a second `StoaSettler` deployment bound to EURC; the architecture supports this without changes to the bot's command handlers. (See `NOTES.md` for the EURC verification record.) |
| **Configurable compliance** — "Arc's design helps builders encode requirements such as transfer controls, identity gating, or disclosure flows directly into application logic." | `/start` requires explicit custody disclosure before generating a wallet. The `/withdraw` flow validates destination addresses. Trace-pinning anchors a content-addressed reasoning record per trade — the on-chain prerequisite for any later audit. Future compliance hooks (sanctions screening on `/withdraw`, KYC gating on `/start`) plug into the same command handlers without contract changes. |

Additional Arc primitives the architecture leans on:
- **Stablecoin-denominated gas** — Arc uses USDC as the native gas asset. The bot's operator wallet pays gas in USDC (~$0.001 per `settle`), giving the user fully predictable fiat-denominated fees end-to-end.
- **Stoa-routed split-on-settle** — every paid action produces an atomic *verify-pull-split-pin* on Arc via `StoaSettler.settle()`. No off-chain accounting, no second-tx reconciliation.

## Architecture

```
Telegram User
   │
   ▼
Telegram Webhook ──► Cloudflare Worker (apps/bot — this package)
                       │
                       ├─ Sync commands (D1 direct):
                       │     /start, /preview, /balance, /positions, /withdraw
                       │
                       ├─ Async commands (HMAC-signed POST → Railway):
                       │     /analyze, /confirm
                       │             │
                       │             ▼
                       │     ┌──────────────────────────────────┐
                       │     │ apps/analyzer — Railway/Express  │
                       │     │   runAnalyzePipeline:            │
                       │     │     • multi-agent LLM (~20s)     │
                       │     │     • Stoa settle on Arc (~10s)  │
                       │     │     • IPFS pin (~5s)             │
                       │     │   runConfirmPipeline:            │
                       │     │     • Stoa settle on Arc         │
                       │     │     • (mocked) Limitless trade   │
                       │     │   DM follow-up via Telegram API  │
                       │     └──────────────┬───────────────────┘
                       │                    │
                       │   ◄────────────────┘  HMAC-signed POST /internal/db
                       │   (analyzer reads/writes user wallets, orders,
                       │    fee charges, trace pins via D1 proxy)
                       │
                       └─ D1 (system-of-record): users / wallets / prepared_orders /
                          fee_charges / trace_pins / withdrawals

Shared: packages/bot-core (chains, crypto, wallet helpers, payStoaFee, pipelines)
```

The split exists because Cloudflare Workers' `waitUntil` caps at 30 seconds even on paid plans, and `/analyze` pipelines routinely take 30-60+ seconds. The analyzer handles the long work; the Worker stays as the cheap, fast Telegram-facing interface.

## Commands

| Command | Cost | Behavior |
|---|---|---|
| `/start` | free | Generate viem EOA for the user, encrypt PK, store in D1, return funding address + disclosure |
| `/preview <url>` | free | Single-LLM-call summary; no Stoa fee, no trace pin |
| `/analyze <url>` | $0.15 | Full multi-agent analysis + trace pin. Pre-charges via StoaSettler |
| `/confirm <orderId>` | $0.20 | Submits the trade to Limitless. Pre-charges via StoaSettler. Limitless leg is MOCKED in v0. |
| `/balance` | free | USDC on Base (real) + open positions (D1) |
| `/positions` | free | Open Limitless orders (D1) |
| `/withdraw <addr> <amount>` | gas only | Real USDC transfer from user's bot-managed wallet on Base |

## Deploy

```sh
# 1. Install
pnpm install

# 2. Create the D1 database
wrangler d1 create stoa-bot-db
# Copy returned database_id into wrangler.toml.

# 3. Apply schema
pnpm db:init:remote

# 4. Set secrets (each prompts for the value)
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put WALLET_ENCRYPTION_KEY            # 32 bytes hex
wrangler secret put OPERATOR_PRIVATE_KEY             # 0x...
wrangler secret put STOA_RECIPIENT_OPERATOR          # 0x... (70%)
wrangler secret put STOA_RECIPIENT_MAINTAINERS       # 0x... (20%)
wrangler secret put STOA_RECIPIENT_CANTEEN           # 0x... (10%)
wrangler secret put ANALYZER_URL                     # https://stoa-analyzer-…up.railway.app
wrangler secret put ANALYZER_HMAC_SECRET             # 64+ hex chars; must match Railway side
wrangler secret put PINATA_JWT                       # optional

# 5. Deploy
pnpm deploy

# 6. Tell Telegram where the webhook lives
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://stoa-bot.<your-subdomain>.workers.dev/telegram"
```

## Local simulation (no Telegram required)

```sh
# Hits real Arc Testnet StoaSettler + real Base USDC. Limitless mocked.
pnpm simulate
```

The simulator drives the bot's command handlers as plain functions with a
hardcoded test user. Requires `TEST_USER_PRIVATE_KEY` in `.env` at repo root
to have ≥ $0.50 USDC on Arc Testnet and (optionally) USDC on Base. The
simulator prints every tx hash produced.

### Probe EURC (multi-currency settlement)

```sh
pnpm tsx scripts/probe-eurc.ts
```

Reads EURC metadata on Arc Testnet, checks deployer balance, and — if balance
allows — runs a `Splitter.distribute()` 70/20/10 round-trip in EURC. With no
EURC in the deployer wallet, the probe reports metadata + EIP-3009 readiness
and instructs the operator to top up via the Circle faucet. See `NOTES.md`
for the full architectural record.

## Known limitations (v0)

1. **Limitless trade is MOCKED.** `/confirm` charges the $0.20 fee for real on
   Arc but does not actually place an order on Base — it stores a fake
   `LMTS-MOCK-<uuid>` orderId in D1. Real Limitless submission is wired the
   moment the partner token is provisioned (see `RESEARCH_LIMITLESS.md`).
2. **Fees are non-refundable on trade failure.** If `/confirm`'s Stoa split
   succeeds but the (mocked or real) trade fails afterward, the $0.20 is
   not refunded. Disclosed on `/start`. Refund flow is post-hackathon polish.
3. **Bot custodies user keys.** Standard Telegram-bot trade-off for hackathon
   speed. The `/withdraw` flow exists so users can exit any time. A future
   "export wallet" command would let users claim self-custody.
4. **Stoa recipient addresses must be configured manually** via `wrangler
   secret put`. There are no on-chain registry semantics — operator chooses
   the three addresses.

## Test user setup (operator)

1. Generate a fresh viem private key for testing: `cast wallet new`.
2. Send it ~$3 USDC on Arc Testnet (from your faucet or the existing deployer
   wallet — Arc uses USDC as native gas).
3. Optionally send some USDC on Base for the `/withdraw` smoke test.
4. Put the PK in `.env` as `TEST_USER_PRIVATE_KEY` (NEVER commit).
5. Run `pnpm simulate`.

## Confidential payments (experimental)

Stoa optionally charges `/analyze` ($0.15) and `/confirm` ($0.20) fees
*confidentially* via [Fairblock StableTrust](https://stabletrust-docs.fairblock.network/api).
The feature is **off by default** behind the `STOA_USE_STABLETRUST`
wrangler var; flip it to `"true"` only after the integration test below
runs green on the operator's Arc Testnet wallet.

### What changes when the flag is on

* **Three new commands**:
  * `/shield <amount>` — move USDC from the user's public Arc balance into
    their confidential StableTrust balance.
  * `/unshield <amount>` — move it back.
  * `/shielded_balance` — read the current confidential balance. (Note:
    Telegram command names use underscores, not hyphens.)
* **`/analyze` + `/confirm` payment routing**: when the user has enough
  shielded balance, the fee is charged via a user→operator *confidential
  transfer* through the Fairblock API. The 70/20/10 atomic split is
  **skipped** in this mode — the operator's StableTrust balance accumulates
  the fees and the split is performed manually post-flow (V1 trade-off).
* **TracePin decoupling**: in shielded mode the `TracePin.pinTrace(...)`
  emission is a *separate* Arc tx, signed by the operator key, not bundled
  into the user's payment. That decouples the on-chain trace from the
  encrypted fee transfer so the analysis is not attributable to any
  specific user.
* **Telegram footer** branches:
  * Public flow (default): `Request <id> — $0.15 charged, split 70/20/10 atomic on Arc.`
  * Shielded flow: `Request <id> — $0.15 charged confidentially via Fairblock StableTrust. [Confidential tx](...)`

### Fall-back behavior

The shielded path **never crashes the user-facing flow**. Any of:
1. user has insufficient shielded balance,
2. Fairblock API returns a non-2xx,
3. circuit breaker is open (3+ consecutive failures within 60s),
4. circuit breaker fail-fast (the next 5 minutes after tripping),

→ falls through to the existing public StoaSettler flow with no
visible difference to the user. Distinguishable in the operator's logs
via the `[stabletrust] mode=public reason=<…>` line.

### Integration test (REQUIRED before flipping the flag)

```bash
cd apps/analyzer

# Required for the test:
export TEST_USER_PRIVATE_KEY=0x...     # ≥ $1.6 public USDC on Arc Testnet
export TEST_RECIPIENT_ADDRESS=0x...    # second test wallet (any address)

# Optional (defaults shown):
# export FAIRBLOCK_API_URL=https://stabletrust-api.fairblock.network
# export STABLETRUST_ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000

npx tsx scripts/test-stabletrust.ts
```

The script runs ten steps end-to-end: `getShieldedBalance` →
`depositToShield 1 USDC` → balance check → `confidentialTransfer 0.5 USDC`
→ balance check → `withdrawToPublic 0.5 USDC` → balance check → schema
asserts. Exits 1 with the failing-step's error on any failure.

### Enabling

After the integration test runs green, flip the var:

```bash
# In apps/bot/wrangler.toml [vars] section, change to:
STOA_USE_STABLETRUST = "true"

# On Railway, set the env var:
STOA_USE_STABLETRUST=true

# Optionally also set the dedicated operator shielded-receipt key:
# (when unset, the V1 default uses OPERATOR_PRIVATE_KEY's address)
wrangler secret put STOA_OPERATOR_STABLETRUST_PRIVATE_KEY
```

Redeploy the Worker and Railway analyzer; existing public-flow users
continue uninterrupted.
