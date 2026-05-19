# Fairblock GitHub Issue Draft

**Operator action**: review the content below, then file as a new issue
on https://github.com/Fairblock/stabletrust-sdk/issues from your own
GitHub account. Do NOT mention this draft was machine-generated.

---

## Title

Request: StableTrust deployment on Circle's Arc Testnet (chain ID 5042002)

## Body

### Summary

The `Supported Networks` table in the
[HTTP API docs](https://stabletrust-docs.fairblock.network/api) lists
"Arc" at chain ID **1244**. This appears to be a separate project that
shares the name; **Circle's institutional Arc network** is at chain ID
**5042002** (testnet) per the canonical
[Arc documentation](https://docs.arc.io/arc/references/connect-to-arc).
We would like to use StableTrust for confidential USDC payments on
Circle's Arc Testnet and would appreciate clarification or, ideally,
deployment of StableTrust on chain 5042002.

### Why this matters

We're building a Telegram-based prediction-market analysis bot
("Stoa") on Circle's Arc Testnet that pulls user `/analyze` and
`/confirm` fees via Stoa-routed atomic settlement (EIP-3009 +
`StoaSettler` contract). We want to offer users the option to pay
those fees *confidentially* via StableTrust so that fee-payment
patterns don't leak which markets a user is analyzing. Our integration
is architecturally complete and feature-flagged off
([source](https://github.com/<your-org>/stoa/blob/main/packages/stabletrust-client)),
pending Fairblock support for chain 5042002.

### Evidence of the chain mismatch

A single deposit POST with `chainId: 5042002` in the body still
routes to Base Sepolia. Request and response captured verbatim:

```
Request:
  POST https://stabletrust-api.fairblock.network/deposit
  Content-Type: application/json
  body: {
    "privateKey": "0x[MASKED]",
    "tokenAddress": "0x3600000000000000000000000000000000000000",
    "amount": "200000",
    "waitForFinalization": true,
    "chainId": 5042002
  }

Response:
  status: 500
  body: {
    "success": false,
    "error": "Failed to ensure account: insufficient funds for intrinsic
              transaction cost (transaction=\"0x02f8d183014a34...\",
              info={ \"error\": { \"code\": -32003, \"message\":
              \"insufficient funds for gas * price + value: have 0
              want 2508374000000\" } }, code=INSUFFICIENT_FUNDS,
              version=6.16.0)"
  }
```

Decoding the EIP-1559 transaction envelope: the chain-ID bytes at
offset 5–7 of the RLP are `0x01 0x4a 0x34` = **0x014a34 = 84532 =
Base Sepolia**. The `chainId: 5042002` parameter in the body had no
effect on routing.

The operator wallet (`0x5342…2435`) holds 40+ USDC on Arc Testnet
(chain 5042002) but zero on Base Sepolia, which is why the gas-funds
check fails. The error itself is misleading from a user perspective
because it implies the user should fund the wallet, when in fact the
API is targeting the wrong network entirely.

`0x3600000000000000000000000000000000000000` is Circle's Arc Testnet
native USDC ([contract reference](https://docs.arc.io/arc/references/contract-addresses)).

### What would unblock us

Any of these would help, in order of preference:

1. **Deploy StableTrust on Circle's Arc Testnet (chain 5042002)**.
   We'd update our `STABLETRUST_ARC_USDC_ADDRESS` to whatever USDC
   address Fairblock chooses for the chain (or keep `0x3600…0000`
   if compatible), then flip our feature flag.

2. **Document a chain-selection parameter** in the HTTP API if one
   exists undocumented (we tried `chainId` in the body — it appears
   to be silently ignored).

3. **Clarify in the docs** that Fairblock's "Arc" is chain 1244 and
   not Circle's Arc. The name collision cost us several hours of
   debugging before we narrowed it down.

If chain 5042002 support is on your roadmap, a rough timeline would
help us plan. Happy to provide any additional context, RPC details,
or testnet wallets needed for testing.

### Reproducer

The captured response is committed at
[`docs/fairblock-arc-test-response.txt`](https://github.com/<your-org>/stoa/blob/main/docs/fairblock-arc-test-response.txt)
in our repo. The diagnostic script that produced it is
[`apps/analyzer/scripts/debug-stabletrust-arc.ts`](https://github.com/<your-org>/stoa/blob/main/apps/analyzer/scripts/debug-stabletrust-arc.ts).

Thanks for building StableTrust — confidential settlement on
prediction markets is a real unlock if we can land this.
