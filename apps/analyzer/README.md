# @stoa/analyzer

Long-running pipeline service for the Stoa bot. Runs `/analyze` (multi-agent LLM + Stoa atomic split + trace pin) and `/confirm` (Stoa split + Limitless trade) past Cloudflare Workers' 30-second cap.

## Why this service exists

Cloudflare Workers' `waitUntil` has a 30-second hard cap (even on paid plans). The `/analyze` pipeline routinely takes 30-60+ seconds: ~20s of multi-agent LLM calls, ~5-15s of Arc RPC round-trips for the StoaSettler.settle tx, ~5s of Pinata IPFS upload. The Worker can't host that work. This Express service can.

```
Telegram user
   │ /analyze <url>
   ▼
Cloudflare Worker (apps/bot)
   │  1) ack synchronously
   │  2) HMAC-signed POST /jobs/analyze
   ▼
Railway service (this app)
   │  3) returns 202 immediately
   │  4) runs the 30-60s pipeline in-process
   │  5) calls back to Worker /internal/db with HMAC for each D1 op
   │  6) DMs the user via direct Telegram API call
   ▼
Telegram user (follow-up DM)
```

## Architecture

- **Inbound auth**: every `/jobs/*` POST carries `X-Stoa-Timestamp` + `X-Stoa-Signature` headers signed with `ANALYZER_HMAC_SECRET` (HMAC-SHA256 over `${timestamp}.${body}`, ±5min replay window).
- **DB access**: the analyzer holds NO local DB. Each DbClient call POSTs to `${BOT_INTERNAL_URL}/internal/db` with the same HMAC scheme. D1 stays as system-of-record on the Worker.
- **Pipelines**: `runAnalyzePipeline` and `runConfirmPipeline` from `@stoa/bot-core` — exactly the same code the Worker used pre-refactor.
- **Telegram delivery**: direct fetch to `https://api.telegram.org/bot$TOKEN/sendMessage` (no grammY context — that's gone by the time the pipeline finishes).
- **Concurrency model**: in-process Promises. Hackathon scale (handful of users, tens of analyses/day) doesn't justify Redis/BullMQ yet.

## Local development

```sh
cd apps/analyzer
cp .env.example .env       # then fill in the secrets
npx pnpm install
npx pnpm run dev           # tsx watch on src/index.ts
```

The dev server listens on `:3000`. Hit `http://localhost:3000/` for the health check.

To smoke-test the HMAC + dispatch path locally without a deployed bot:

```sh
# In one terminal:
npx pnpm run dev

# In another:
TS=$(date +%s)
BODY='{"chatId":12345,"telegramUserId":12345,"marketUrl":"https://polymarket.com/event/foo","requestId":"abc123"}'
SIG=$(node -e "
  const c = require('crypto');
  const h = c.createHmac('sha256', process.env.ANALYZER_HMAC_SECRET);
  h.update(process.env.TS + '.' + process.env.BODY);
  console.log(h.digest('hex'));
" TS="$TS" BODY="$BODY")

curl -i -X POST http://localhost:3000/jobs/analyze \
  -H "Content-Type: application/json" \
  -H "X-Stoa-Timestamp: $TS" \
  -H "X-Stoa-Signature: $SIG" \
  -d "$BODY"
```

Expected: `HTTP 202`. The pipeline will then run in the background, try to call back to the Worker (will fail if BOT_INTERNAL_URL points at a non-existent deployment — that's fine for HMAC verification testing).

## Required environment variables

Set every one of these in Railway's dashboard under **Variables**. Many duplicate the Worker's secrets — that's intentional; both processes need direct access (no shared secret store at hackathon scale).

| Name | Required | Example | Notes |
|---|---|---|---|
| `PORT` | no | `3000` | Railway injects this automatically; keep your code reading `process.env.PORT`. |
| `HOST` | no | `0.0.0.0` | Default is fine. |
| `BOT_INTERNAL_URL` | **yes** | `https://stoa-bot.stoa-build.workers.dev` | The Worker URL (no trailing slash). The analyzer POSTs `/internal/db` requests here for every D1 access. |
| `ANALYZER_HMAC_SECRET` | **yes** | `<64+ random hex>` | MUST match the value `wrangler secret put ANALYZER_HMAC_SECRET` set on the bot. Generate fresh: `openssl rand -hex 32`. |
| `TELEGRAM_BOT_TOKEN` | **yes** | `123456:ABC-…` | Same as the bot's. The analyzer sends follow-up DMs directly via Telegram's Bot API. |
| `ANTHROPIC_API_KEY` | **yes** | `sk-ant-…` | LLM costs for `/analyze` run here, not on the Worker. |
| `WALLET_ENCRYPTION_KEY` | **yes** | `<64 hex>` | 32-byte master key — MUST match the bot's value or per-user wallets can't be decrypted. |
| `OPERATOR_PRIVATE_KEY` | **yes** | `0x…` | Operator wallet that pays Arc gas + submits StoaSettler.settle. Same as the bot's value. |
| `STOA_RECIPIENT_OPERATOR` | **yes** | `0x…` | 70% recipient. Same as bot. |
| `STOA_RECIPIENT_MAINTAINERS` | **yes** | `0x…` | 20% recipient. Same as bot. |
| `STOA_RECIPIENT_CANTEEN` | **yes** | `0x…` | 10% recipient. Same as bot. |
| `STOA_SETTLER` | **yes** | `0x05a98A1d…` | Arc Testnet StoaSettler contract. |
| `STOA_SPLITTER` | **yes** | `0x114942B5…` | Arc Testnet Splitter contract. |
| `STOA_TRACEPIN` | **yes** | `0x657355b6…` | Arc Testnet TracePin contract. |
| `PINATA_JWT` | no | `eyJ…` | Optional — without it, `/analyze` skips IPFS upload (on-chain trace hash still pinned). |
| `LIMITLESS_TOKEN_ID` | no | — | Mocked until partner token arrives. |
| `LIMITLESS_TOKEN_SECRET` | no | — | Ditto. |
| `ARC_TESTNET_RPC` | no | `https://rpc.testnet.arc.network` | Override only if using a private RPC. |
| `ARC_CHAIN_ID` | no | `5042002` | Default is correct. |
| `BASE_RPC` | no | `https://mainnet.base.org` | Default is correct. |
| `BASE_CHAIN_ID` | no | `8453` | Default is correct. |
| `ARC_USDC` | no | `0x36000…` | Default is correct. |
| `BASE_USDC` | no | `0x833589…` | Default is correct. |
| `STOA_FEE_ANALYZE_USDC` | no | `100000` | $0.10. |
| `STOA_FEE_CONFIRM_USDC` | no | `200000` | $0.20. |

## Operator deployment to Railway

End-to-end, assuming you have a Railway account and the Railway CLI installed (`brew install railway`, `npm i -g @railway/cli`, or scoop/winget):

### 1. Generate the shared HMAC secret

```sh
openssl rand -hex 32
# → e.g. 0123abcd...  (save this for steps 4 and 6)
```

### 2. Create the Railway project + service

```sh
cd /path/to/stoa            # repo root, NOT apps/analyzer/
railway login
railway init                # creates a new project; pick a name like "stoa-analyzer"
railway link                # if you already have a project, pick it here
```

### 3. Tell Railway to build from `apps/analyzer/Dockerfile`

Either:
- Push to a GitHub repo connected to Railway and set **Service Settings → Build → Dockerfile Path** = `apps/analyzer/Dockerfile`, **Root Directory** = `.` (repo root)
- Or rely on `apps/analyzer/railway.toml` (it sets `dockerfilePath = "apps/analyzer/Dockerfile"`) and run `railway up` from the repo root

The Docker build expects the repo root as build context because `apps/analyzer/package.json` references `packages/bot-core` and `packages/insight-engine` via `file:` paths.

### 4. Set the environment variables

From the Railway dashboard, **Variables** tab — paste each from the table above. Or from the CLI:

```sh
railway variables set ANALYZER_HMAC_SECRET="<the secret from step 1>"
railway variables set BOT_INTERNAL_URL="https://stoa-bot.stoa-build.workers.dev"
railway variables set TELEGRAM_BOT_TOKEN="<paste>"
railway variables set ANTHROPIC_API_KEY="<paste>"
railway variables set WALLET_ENCRYPTION_KEY="<same value as on the bot>"
railway variables set OPERATOR_PRIVATE_KEY="<paste>"
railway variables set STOA_RECIPIENT_OPERATOR="<paste>"
railway variables set STOA_RECIPIENT_MAINTAINERS="<paste>"
railway variables set STOA_RECIPIENT_CANTEEN="<paste>"
railway variables set STOA_SETTLER="0x05a98A1dCa17917B6e8B19306c1653fA9FC5d689"
railway variables set STOA_SPLITTER="0x114942B5FeebFDf9F1FA2F161eA9C2A1754C407F"
railway variables set STOA_TRACEPIN="0x657355b621494C5F99253ce9A4c2cE8B9b488B7B"
railway variables set PINATA_JWT="<paste, optional>"
```

### 5. Deploy

```sh
railway up
```

Watch the logs; you should see `[stoa-analyzer] listening on 0.0.0.0:3000` once the container is healthy. Note the Railway-provided URL (e.g. `https://stoa-analyzer-production.up.railway.app`).

### 6. Wire the bot to point at the analyzer

```sh
cd apps/bot
wrangler secret put ANALYZER_URL
# paste the Railway URL from step 5, no trailing slash

wrangler secret put ANALYZER_HMAC_SECRET
# paste the SAME secret from step 1

npx pnpm run deploy
```

### 7. Sanity-check the round-trip

Quick health-check sequence:

```sh
# Worker should be up:
curl https://stoa-bot.stoa-build.workers.dev/

# Analyzer should be up:
curl https://stoa-analyzer-production.up.railway.app/

# Real test: send /analyze in Telegram and watch BOTH log streams.
#   - Worker: wrangler tail (in apps/bot/)
#   - Analyzer: `railway logs` or the Railway dashboard
```

Expected sequence in the logs when you send `/analyze <url>` to the bot:
1. **Worker**: `POST /telegram - Ok` (sub-second; just acks the user)
2. **Analyzer**: `[jobs/analyze] req=… user=… url=…`
3. **Worker** (multiple times): `POST /internal/db` (each DbClient call during the pipeline)
4. **Analyzer**: pipeline completes — `[trace-pinning] …` or the Stoa settle tx hash
5. **Telegram chat**: result DM arrives

If step 2 doesn't fire, check the HMAC secrets match between bot and analyzer. If step 3 fails with 401, same — the analyzer can't sign correctly.

## Local sanity-test (no Railway, no Worker)

You can drive the pipelines locally against real Arc Testnet contracts without involving Railway, Cloudflare, or Telegram. See `apps/bot/scripts/simulate.ts` — it exercises the `payStoaFee` and `readUsdcBalanceArc` paths from `@stoa/bot-core` directly. That covers the on-chain mechanics that the analyzer wraps; if it passes, the analyzer's pipelines will pass too (modulo the HMAC + Telegram delivery edges, which are tiny and well-typed).

```sh
cd apps/bot
npx pnpm run simulate
```

Expected: two real Arc Testnet tx hashes (one for $0.10 analyze, one for $0.20 confirm) printed with arcscan URLs.

## Known limitations (v0)

1. **In-process queue** — if the analyzer container restarts mid-pipeline, the user gets no result and no error DM. Acceptable at hackathon scale; a Redis+BullMQ queue is the v1 upgrade.
2. **No retry on Worker→analyzer dispatch failures** — if Railway is down when the bot fires `/jobs/analyze`, the user sees an "Couldn't reach the analyzer" message and has to retry manually.
3. **DB chatty path** — each pipeline does ~5-7 HTTP round-trips back to the Worker for D1 access (added latency: ~600ms-1.5s on top of the LLM + RPC work). Fine for now; if it becomes the bottleneck, move D1 → Postgres on Railway and let the analyzer query locally.
