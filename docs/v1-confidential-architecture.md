# V1 Confidential Architecture — design notes for Phase 1

**Status:** design only, no implementation. To be implemented after
Fairblock confirms StableTrust deployment on Circle's Arc Testnet
(chain 5042002) and `apps/analyzer/scripts/init-system-wallets.ts`
has been run successfully against the 3 system wallets.

## What changes from the current code

The Phase 0 shielded-mode chargeFee path (already shipped in
`packages/bot-core/src/pipelines.ts`) sends the user's fee as a
**single** confidential transfer to the operator address and skips the
70/20/10 atomic split entirely. Phase 1 replaces that single transfer
with **three parallel confidential transfers** to operator,
maintainers, and Canteen — the same 70/20/10 split the public
StoaSettler flow does, but each leg is independently encrypted.

## Split math

```
fee_micros            = 150000   // $0.15 /analyze; 200000 for /confirm
operator_micros       = 105000   // 70%
maintainers_micros    =  30000   // 20%
canteen_micros        =  15000   // 10%
                        ──────
                         150000
```

Exact integer math — no division remainders to worry about at these
denominations. For other fee amounts the split helper rounds down on
each leg and assigns the remainder to operator (the largest share).

## New env vars (additions to `BotCoreConfig` + analyzer + Worker)

```ts
// Already exist (public-flow split recipients):
STOA_RECIPIENT_OPERATOR: string;       // 0x...
STOA_RECIPIENT_MAINTAINERS: string;
STOA_RECIPIENT_CANTEEN: string;

// New (confidential-flow recipients — may equal the public ones in V1,
// but kept distinct so the operator can rotate the shielded receivers
// independently). When unset, defaults to the public recipient.
STOA_CONFIDENTIAL_OPERATOR_ADDRESS?: string;
STOA_CONFIDENTIAL_MAINTAINERS_ADDRESS?: string;
STOA_CONFIDENTIAL_CANTEEN_ADDRESS?: string;
```

All three confidential recipients MUST have completed `ensureAccount`
on Fairblock before any confidential transfer can target them. That's
what `init-system-wallets.ts` accomplishes.

## ChargeResult schema extension

```ts
interface ChargeResult {
  mode: "public" | "shielded";
  user_tx: Hex;                  // public: settle tx; shielded: first leg's tx
  trace_pin_tx: Hex | null;      // operator-signed TracePin tx (shielded only)
  amount_micros: bigint;

  // NEW in V1:
  splits?: Array<{
    recipient: Address;
    amount_micros: bigint;
    tx_hash: Hex | null;         // null if this leg failed all retries
    ok: boolean;
  }>;
  pending_obligations_count?: number;  // 0–3, count of failed legs deferred to retry queue
}
```

For public flow, `splits` is undefined (StoaSettler does the split
on-chain, no per-leg tx). For shielded flow, `splits.length === 3`
always — even if some legs failed.

## Core chargeFee pseudocode

```ts
async function chargeAnalyzeFee(args): Promise<ChargeResult> {
  // ... existing flag check + balance pre-flight unchanged ...

  if (cfg.STOA_USE_STABLETRUST && availableShielded >= feeMicros) {
    // ── Compute the 3-way split ────────────────────────────────────
    const legs = computeSplitLegs(feeMicros, {
      operator: cfg.STOA_CONFIDENTIAL_OPERATOR_ADDRESS ?? cfg.STOA_RECIPIENT_OPERATOR,
      maintainers: cfg.STOA_CONFIDENTIAL_MAINTAINERS_ADDRESS ?? cfg.STOA_RECIPIENT_MAINTAINERS,
      canteen: cfg.STOA_CONFIDENTIAL_CANTEEN_ADDRESS ?? cfg.STOA_RECIPIENT_CANTEEN,
    });
    // legs = [
    //   { recipient: 0xOP..., amount_micros: 105000n },
    //   { recipient: 0xMT..., amount_micros: 30000n },
    //   { recipient: 0xCN..., amount_micros: 15000n },
    // ]

    // ── Operator-signed TracePin (decoupled from payment legs) ────
    const pinTx = await pinTraceFromOperator({ cfg, traceHash, ipfsCid });

    // ── Three parallel confidential transfers with per-leg retry ──
    const results = await Promise.allSettled(
      legs.map((leg) => sendLegWithRetry({
        cfg,
        userPrivateKey: wallet.privateKey,
        leg,
        maxAttempts: 3,
        requestId,
      }))
    );

    // ── Reconcile + pending-obligations log ───────────────────────
    const splits: ChargeResult["splits"] = [];
    let pendingCount = 0;
    for (let i = 0; i < legs.length; i++) {
      const r = results[i];
      const leg = legs[i];
      if (r.status === "fulfilled") {
        splits.push({ recipient: leg.recipient, amount_micros: leg.amount_micros, tx_hash: r.value.txHash, ok: true });
      } else {
        // 3 attempts all failed — defer to retry queue, fall through
        // to public mode for THIS analyze so the user gets unblocked.
        await db.insertPendingObligation({
          user_wallet: wallet.address,
          recipient: leg.recipient,
          amount_micros: Number(leg.amount_micros),
          trace_id: traceHash,
          last_error: (r.reason as Error).message,
          created_at: Date.now(),
        });
        splits.push({ recipient: leg.recipient, amount_micros: leg.amount_micros, tx_hash: null, ok: false });
        pendingCount++;
      }
    }

    // ── Policy: if ANY leg failed, fall through to public mode ─────
    //   Rationale: a partial shielded charge is worse for the user
    //   than a clean public charge — they've paid SOME confidential
    //   amount but the split is incomplete. Better to refund the
    //   shielded leg(s) that succeeded (via the pending_obligations
    //   sweeper) and charge them via public flow for this analyze.
    //
    //   For V1 we DON'T refund the partial-success legs automatically
    //   — they sit in the operator's accumulated balance until the
    //   sweeper batches them. The user is charged $0.15 again on the
    //   public side. This is a knowingly-imperfect tradeoff: ~3% of
    //   shielded analyses will double-charge in failure cases. V2
    //   adds the automatic refund-and-retry policy.
    if (pendingCount > 0) {
      console.warn(`[stabletrust] ${pendingCount}/3 legs failed; falling through to public flow for analyze ${requestId}`);
      // Fall through to existing public-flow code below.
    } else {
      return {
        mode: "shielded",
        user_tx: splits[0].tx_hash as Hex,    // first leg's tx (operator)
        trace_pin_tx: pinTx,
        amount_micros: feeMicros,
        splits,
        pending_obligations_count: 0,
      };
    }
  }

  // ── Public flow (existing, unchanged) ─────────────────────────────
  // ... payStoaFee via StoaSettler.settle() ...
  return { mode: "public", user_tx: settleTx, trace_pin_tx: null, amount_micros: feeMicros };
}
```

### sendLegWithRetry helper

```ts
async function sendLegWithRetry(args: {
  cfg: BotCoreConfig;
  userPrivateKey: Hex;
  leg: { recipient: Address; amount_micros: bigint };
  maxAttempts: number;
  requestId: string;
}): Promise<{ txHash: Hex }> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    try {
      const r = await stClient.confidentialTransfer({
        privateKey: args.userPrivateKey,
        recipientAddress: args.leg.recipient,
        tokenAddress: cfg.STABLETRUST_ARC_USDC_ADDRESS,
        amount: args.leg.amount_micros.toString(),
        chainId: Number(cfg.ARC_CHAIN_ID),
        useOffchainVerify: false,
        waitForFinalization: true,
      });
      return { txHash: r.tx as Hex };
    } catch (e) {
      lastErr = e as Error;
      const sleepMs = 1000 * Math.pow(2, attempt - 1);  // 1s, 2s, 4s
      console.warn(`[stabletrust] leg to ${args.leg.recipient} attempt ${attempt}/${args.maxAttempts} failed: ${lastErr.message}. Sleeping ${sleepMs}ms.`);
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }
  throw lastErr ?? new Error("sendLegWithRetry exhausted with no error captured");
}
```

## New D1 table: `pending_obligations`

```sql
CREATE TABLE pending_obligations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_wallet TEXT NOT NULL,
  recipient TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  trace_id TEXT NOT NULL,           -- correlates back to the analyze that birthed the leg
  last_error TEXT,
  created_at INTEGER NOT NULL,
  swept_at INTEGER,                  -- set by the operator's sweeper script when paid out
  swept_tx_hash TEXT
);

CREATE INDEX idx_pending_unswept ON pending_obligations(swept_at) WHERE swept_at IS NULL;
```

The operator runs a periodic sweeper (`apps/analyzer/scripts/sweep-pending-obligations.ts`) that:

1. Reads all rows where `swept_at IS NULL`.
2. Groups by recipient address.
3. Sends a single confidential transfer per recipient covering the
   sum of all owed amounts.
4. Marks each settled row with `swept_at = now, swept_tx_hash = ...`.

V1 sweeper runs manually post-flow (V2 schedules it). This is
acceptable for a hackathon: the failure rate of confidential
transfers in our testing has been low, and the sweeper handles
whatever does fail without losing money.

## Footer rendering (Telegram)

Public flow (existing — unchanged):
```
_Request `req-1234` — $0.15 charged, split 70/20/10 atomic on Arc._
```

Shielded flow with all 3 legs successful:
```
_Request `req-1234` — $0.15 charged confidentially via Fairblock StableTrust.
Confidential txs: [op](https://testnet.arcscan.app/tx/0x...) · [maint](...) · [canteen](...)._
```

Shielded flow with partial failure that fell through to public:
```
_Request `req-1234` — $0.15 charged, split 70/20/10 atomic on Arc.
(Note: confidential mode was attempted; 1 of 3 legs failed and was deferred.)_
```

The fall-through case keeps the user's experience identical to public
mode, with a small italic note disclosing what happened. The
`/analyze` proof block still links the operator-signed TracePin tx
(unchanged) so the analysis attribution is preserved either way.

## Backward compatibility with Phase 0 trace pins

Phase 0 traces have no `splits` field. The formatter must tolerate
both shapes:

```ts
const splitsLine = charge.splits && charge.splits.length === 3
  ? renderThreeSplits(charge.splits)
  : null;
```

When a Phase 0 trace is replayed (e.g. from `/positions` history),
the footer falls back to the single-leg rendering used today. No DB
migration required.

## Implementation order for Phase 1

1. **Extend `BotCoreConfig` + env loaders** for the 3 new optional
   confidential recipient vars. Default to the public recipients.
2. **Add `pending_obligations` D1 migration**
   (`apps/bot/migrations/0002_pending_obligations.sql`) + DbClient
   methods (`insertPendingObligation`, `listUnsweptObligations`,
   `markObligationSwept`).
3. **Implement `computeSplitLegs` + `sendLegWithRetry`** in
   `packages/bot-core/src/stabletrust.ts`.
4. **Refactor `chargeAnalyzeFee` + `chargeConfirmFee`** to use
   `Promise.allSettled` over the 3 legs with the fall-through policy.
5. **Update `ChargeResult` + formatter** to render the 3-leg footer.
6. **Write the sweeper script** at
   `apps/analyzer/scripts/sweep-pending-obligations.ts`.
7. **Add unit tests** for `computeSplitLegs` (rounding, $0.15 +
   $0.20 cases), `sendLegWithRetry` (exhaustion behavior), and the
   chargeFee fall-through policy (mock 2-of-3 success).
8. **Update `apps/bot/README.md`** confidential-payments section to
   reflect the V1 3-way split semantics.

Estimated work: 6–8h for an experienced engineer with bot-core
context. Lower if the sweeper deferred to V1.1.

## Trace privacy

Stoa pins reasoning traces to IPFS for verifiability. In confidential
mode, user-specific economic fields are stripped from the trace before
pinning. Public mode pins the full trace unchanged.

The Telegram message the user receives is identical in both modes —
the redaction only affects the publicly-fetchable IPFS artifact and
the on-chain trace hash (which is computed over the redacted bytes
so a verifier fetching the CID can recompute and match).

### Why this matters

Without redaction, an observer can fetch the IPFS CID emitted by
TracePin (which records the hash + URI on Arc) and read the original
JSON. That JSON contains `user_balance_usdc`, `recommended_size_usdc`,
`kelly_fraction`, and `recommendation_reason` (which embeds free-text
mentions like "Sized at 12% of $28.94 bankroll"). With the bankroll
in hand, the observer correlates against on-chain balance state to
identify the user wallet behind the confidential transfer — defeating
the cryptographic privacy Fairblock StableTrust provided for the
payment leg. Partial removal is not enough: `kelly_fraction` ×
`recommended_size_usdc` re-derives the bankroll mathematically, so
all related fields must go together.

### Fields removed in confidential mode

At every nesting level:
- `user_balance_usdc` (top-level)
- `recommended_size_usdc` (top-level, `judge_trace`,
  `judge_ensemble.aggregate`, every `judge_ensemble.runs[].trace`)
- `kelly_fraction` (in every mirror above)
- `recommendation_reason` (in every mirror above)

Everything else stays: `market_question`, all 4 specialist
`agent_traces`, the Judge ensemble's `reasoning`/`thesis`/
`counter_arguments`/`risk_decomposition`/`evidence`/
`model_probability_yes`/`calibration_adjustment`, `final_signal`,
`final_confidence`, `trace_hash`, `schema_version`, timestamps, and
`token_usage`. The redacted trace still cryptographically commits to
the non-economic reasoning chain, so the audit story for "which
agents emitted what claims" is preserved.

The implementation is a single pure function,
`stripTradeplanFromTrace`, in `packages/bot-core/src/insight.ts`.
The /analyze pipeline computes a `redactPin` flag equal to the
shielded-attempt predicate (`STOA_USE_STABLETRUST && paymentMode
!== "public"`) and passes it to `runFullAnalysis`, which hashes and
pins the stripped clone in that case. Privacy is preferred over
consistency: if the shielded charge later falls through to public
(insufficient balance, Fairblock unreachable, or a leg failure), the
pinned trace stays stripped because the user's *intent* was
confidential.

### Privacy model

Trace redaction is operator-mediated discretion — the operator
commits to not publishing user-specific data in confidential mode.
This is a strictly weaker guarantee than the cryptographic privacy
Fairblock StableTrust provides for payment amounts: a malicious
operator (or a compromised one) could still log the unredacted
trace internally. The redaction blocks passive observers who fetch
the IPFS CID; it does not protect against the operator itself.

The on-chain `trace_hash` recorded by TracePin matches the
*redacted* JSON's hash in confidential mode, so verifiers fetching
the CID and recomputing get a clean match. There is no separate
"private hash" — the audit trail commits to exactly the bytes that
are publicly available.

### V1.5 roadmap

To remove the operator from the trust boundary on this dimension,
V1.5 plans asymmetric encryption of the user-specific trace fields
using keys derived from the user's wallet pubkey. The pinned trace
would contain a ciphertext block of the redacted fields that only
the user's wallet can decrypt, making trace privacy trust-minimized
(operator cannot decrypt after pinning) for non-custodial users.

For custodial bot users (everyone who exported via `/start` without
later supplying an external wallet) this remains discretion-based
until V2 introduces external-wallet-connection options — at that
point the operator-managed key is no longer in the loop and the
asymmetric scheme provides end-to-end privacy.
