# RESEARCH_CIRCLE_POLYMARKET.md

**Question:** How should a Stoa Phase 5 Telegram bot, using Circle wallets for user-facing accounts, place orders on Polymarket V2's CLOB while remaining compliant with V2's deposit-wallet requirement?

**Time-box:** 45 minutes (used ~25). Date: 2026-05-16. Sources cited inline; all primary sources are Circle's `developers.circle.com` and Polymarket's `docs.polymarket.com` retrieved fresh today.

---

## TL;DR — the right Phase-5 architecture

**Use Circle developer-controlled wallets with `accountType: "EOA"` on Polygon PoS (`MATIC`), as the *owner* of a Polymarket V2 deposit wallet.** Each Telegram user gets:

1. A Circle EOA (server-held key) — Circle's API signs EIP-712 typed data on request.
2. A Polymarket deposit wallet (ERC-1967 proxy) whose `owner` is that Circle EOA, deployed gaslessly via Polymarket's relayer `WALLET-CREATE`.

Order flow per trade:
- Construct V2 Order (`maker = signer = deposit wallet address`).
- Wrap in ERC-7739 `TypedDataSign` with `domain.name="DepositWallet", domain.version="1", verifyingContract=depositWalletAddress`.
- Call Circle's `POST /v1/w3s/developer/sign/typedData` on the wrapped typed data → 65-byte ECDSA sig from the Circle EOA.
- Assemble final 317-byte ERC-7739 signature (innerSig + appDomainSep + contentsHash + orderTypeString + typeStringLength).
- Submit to CLOB with `signatureType = SignatureTypeV2.POLY_1271 (3)`, `funder = depositWalletAddress`.
- Polymarket deposit wallet's `isValidSignature()` does plain ECDSA recovery against `owner` → returns `0x1626ba7e` → order accepted. **No EIP-1271 chaining required.**

**Why not Circle SCA / Modular Wallets:** they're ERC-4337/6900 smart contracts, so signing happens via the wallet's own `isValidSignature()`. Polymarket's deposit-wallet implementation does not document recursive ERC-1271 chaining, and we can't validate it works without burning an afternoon of mainnet testing. EOA path is documented, deterministic, and lower risk.

**Trade-off accepted:** EOA owners can't use Circle Paymaster for gas-free withdrawals. This is nearly costless in practice because (a) WALLET-CREATE and exchange approvals are gasless through Polymarket's relayer, (b) CLOB order submission is off-chain, (c) the only user-facing gas is the optional `bridge.polymarket.com/withdraw` path which Polymarket itself sponsors. The Circle Paymaster integration we'd lose has no concrete use case on the Polymarket leg.

---

## Q1 — Does Circle Embedded Wallets produce a Polymarket-compatible proxy/Safe address?

**Answer: No — and that's actually fine.** Circle wallets are *not* themselves Polymarket deposit wallets, and there is no "register existing Circle wallet as a Polymarket proxy" path. The correct mental model is:

```
Circle EOA address (owner)
        ▼
        Polymarket factory.deployDepositWallet(owner)
        ▼
Polymarket deposit wallet address (separate ERC-1967 proxy)
```

The Circle EOA *owns* the Polymarket deposit wallet. They are two addresses.

### Polymarket deposit wallets — what they actually are

From [docs.polymarket.com/trading/deposit-wallets](https://docs.polymarket.com/trading/deposit-wallets):

- **Type:** ERC-1967 proxy.
- **Factory:** `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` on Polygon mainnet (chain 137).
- **Address derivation:** deterministic CREATE2.
  ```
  walletId = bytes32(owner)            // owner left-padded to 32 bytes
  args    = abi.encode(factory, walletId)
  salt    = keccak256(args)
  ```
  TypeScript SDK exposes `deriveDepositWalletAddress(eoa)`; Python SDK has `get_expected_deposit_wallet()`.
- **Deployment:** submit `{type: "WALLET-CREATE", from: owner, to: factory}` to the Polymarket relayer `/submit` endpoint. **No user signature required.** Polymarket pays the gas. Poll until `STATE_MINED` / `STATE_CONFIRMED`.
- **What it holds:** pUSD (for trading collateral) and conditional tokens (CTF positions).
- **What it does:** signs orders via ERC-1271 (`isValidSignature`) by validating an ERC-7739-wrapped signature from `owner`. Holds collateral and acts as `maker` on orders. Approvals to the CTF Exchange V2 contracts are managed *from inside the deposit wallet* via the relayer "WALLET batch" pattern.

### Owner restrictions

The factory accepts any 20-byte address as `owner` (derivation is just `bytes32(owner)`). However:

- **EOA owner** is the explicitly documented path. The deposit wallet's `isValidSignature` does ECDSA recovery against `owner` — guaranteed to work for any standard EOA.
- **Smart-contract owner** would require the deposit wallet to call `IERC1271(owner).isValidSignature(...)` recursively. This is *possible* per the ERC-1271 spec but **not documented as supported** by Polymarket. Confirmed by reviewing [docs.polymarket.com/trading/deposit-wallets](https://docs.polymarket.com/trading/deposit-wallets) and [polynode.mintlify.app/guides/deposit-wallets](https://polynode.mintlify.app/guides/deposit-wallets) — both describe "owner or session signer" as the EOA producing the inner ECDSA signature, with no mention of recursive 1271.

Until Polymarket confirms recursive 1271 support, **the EOA path is the only safe choice.**

### Circle wallets — what kinds are available

From [developers.circle.com/wallets/supported-blockchains](https://developers.circle.com/wallets/supported-blockchains):

| Product | Account types | Polygon PoS (`MATIC`) |
|---|---|---|
| Developer-Controlled Wallets | EOA, SCA | ✅ |
| User-Controlled Wallets (PIN) | EOA, SCA | ✅ |
| Modular Wallets | MSCA only (ERC-6900) | ✅ |

The chain code in API requests is `MATIC`. All three products support Polygon mainnet. For the Stoa Telegram bot, **Developer-Controlled Wallets with `accountType: "EOA"`** is the chosen path.

---

## Q2 — Can a Circle wallet sign EIP-1271 signatures for Polymarket V2 orders, or only EOA signatures?

**Reframing the question:** The V2 order itself is signed by `owner` as a *plain ECDSA signature*. That ECDSA signature gets wrapped per ERC-7739 by the Polymarket deposit wallet logic (server-side / SDK-side). The deposit wallet then validates the wrapped signature using its own ERC-1271 `isValidSignature`.

So the only thing the Circle wallet needs to do is **produce an EIP-712 ECDSA signature over the wrapped typed data**. This is exactly what `POST /v1/w3s/developer/sign/typedData` does (per [developers.circle.com/api-reference/wallets/developer-controlled-wallets/sign-typed-data](https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/sign-typed-data)).

### What Circle's sign-typed-data API expects

- **Endpoint:** `POST https://api.circle.com/v1/w3s/developer/sign/typedData`
- **Auth:** Bearer API key
- **Body fields:**
  - `walletId` or (`walletAddress` + `blockchain`) — identify which wallet signs
  - `data` — EIP-712 typed data JSON
  - `entitySecretCiphertext` — base64-encoded ciphertext of the entity secret, encrypted with Circle's public key (per-request; freshly generated each call)
- **Supports:** Ethereum and EVM-compatible blockchains (Solana excluded).
- **Returns:** 65-byte ECDSA signature, ready to feed into the ERC-7739 wrapper.

### ERC-7739 wrapping — what we need to build

From [polynode.mintlify.app/guides/deposit-wallets](https://polynode.mintlify.app/guides/deposit-wallets):

1. Take the standard V2 Order EIP-712 (the 11-field Order type, domain `name="Polymarket CTF Exchange", version="2"`, verifyingContract = standard or neg-risk exchange V2).
2. Wrap it in a Solady `TypedDataSign` struct with:
   - `name: "DepositWallet"`
   - `version: "1"`
   - `chainId: 137`
   - `verifyingContract: depositWalletAddress`
   - `salt: bytes32(0)`
3. Sign that wrapper. **This is the call we make to Circle's `signTypedData` API.**
4. Concatenate the final 317-byte signature:
   - `innerSig` (65 bytes) ← the ECDSA sig Circle returned
   - `appDomainSeparator` (32 bytes) ← EIP-712 domain separator of the V2 exchange
   - `contentsHash` (32 bytes) ← hash of the inner Order struct
   - `orderTypeString` (186 bytes) ← the V2 Order type-string per EIP-712 encoding rules
   - `typeStringLength` (2 bytes) ← uint16 length of `orderTypeString`
5. Pass the 317-byte signature to `clob.createAndPostOrder({...}, {tickSize, negRisk}, OrderType.GTC)` with `signatureType=3` and `funder=depositWalletAddress`.

**Open implementation question:** does the `@polymarket/clob-client-v2` SDK auto-handle the ERC-7739 wrapping if you initialize it with `signatureType: POLY_1271` and provide a custom signer? Per the quickstart, it appears so — code samples don't show manual wrapping. We'll verify on the first integration spike by initializing the client with a Circle-backed signer adapter (`viem` custom account that delegates `signTypedData` to Circle's API) and seeing whether the SDK produces the 317-byte sig automatically or whether we need to call the wrapping helpers ourselves. The SDK's source is small (~few hundred lines for V2-specific code); worst case we copy the wrapper logic.

---

## Q3 — Cleanest user flow: Telegram → wallet → fund → trade

```
┌─────────────────────────────────────────────────────────────┐
│  1. User starts the Telegram bot (/start)                   │
│     - grammY handler: lookup user by Telegram ID in DB      │
│     - if new: create wallet (next step)                     │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. Bot creates Circle developer-controlled EOA              │
│     POST /v1/w3s/developer/wallets                          │
│     body: {                                                  │
│       walletSetId: <stoa-wallet-set>,                       │
│       blockchains: ["MATIC"],                               │
│       accountType: "EOA",                                   │
│       count: 1,                                             │
│       metadata: [{name: "tg:<userid>", refId: <userid>}]    │
│     }                                                       │
│     → returns wallet.address (0xAlice EOA)                  │
│     Store in DB. Time: ~1-2s.                                │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. Bot deploys Polymarket deposit wallet for that EOA       │
│     POST <polymarket-relayer>/submit                         │
│     body: {                                                  │
│       type: "WALLET-CREATE",                                │
│       from: 0xAlice,                                        │
│       to: 0x00000000000Fb5C9ADea0298D729A0CB3823Cc07        │
│     }                                                       │
│     Poll until STATE_CONFIRMED.                              │
│     → store depositWallet address (0xDeposit_alice)         │
│     Polymarket pays gas. Time: ~15-30s.                      │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  4. Bot shows user their deposit address + funding options   │
│     "Send USDC to 0xDeposit_alice on Polygon to start"      │
│     OR a deeplink to bridge.polymarket.com pre-filled        │
│     with destination=0xDeposit_alice                         │
│     → user bridges/transfers USDC from anywhere              │
│     Polymarket bridge handles USDC → USDC.e → pUSD wrap      │
│     inside the deposit wallet                                │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  5. User asks bot for a trade idea                           │
│     "/trade https://polymarket.com/event/...$5"             │
│     Bot calls insight-engine.analyzeMarket(url, balance=5)   │
│     Returns FullTrace with side/size/probability/risks       │
│     Bot pins trace to Arc + IPFS (Phase 3 already works)     │
│     Bot replies with recommendation + confirm button         │
└─────────────────────────────────────────────────────────────┘
              │
              ▼ (user taps "Confirm")
┌─────────────────────────────────────────────────────────────┐
│  6. Bot constructs V2 order + ERC-7739 wrap                  │
│     - Build Order struct (maker=signer=0xDeposit_alice,      │
│       tokenId, makerAmount, takerAmount, side, sigType=3,    │
│       timestamp=now_ms, metadata=0x00, builder=STOA_CODE)    │
│     - Wrap typed data in TypedDataSign(DepositWallet/1)      │
│     - Call Circle signTypedData with 0xAlice walletId        │
│       → 65-byte ECDSA sig                                    │
│     - Assemble 317-byte ERC-7739 signature                   │
│     - POST to Polymarket CLOB /order                         │
│     → orderId, builder code attributable                     │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  7. Order matches → builder fee accrues to Stoa profile      │
│     Periodic operator action: bridge.polymarket.com/withdraw│
│     → builder fee USDC on Polygon → CCTP/mirror → Arc        │
│     → Stoa Splitter distributes 60/20/15/5                   │
└─────────────────────────────────────────────────────────────┘
```

**Time-to-first-trade for a new user: ~30-60 seconds (mostly waiting on Polymarket relayer).** No browser, no extension, no PIN — entirely in-chat.

---

## Risks & open questions for Phase 5

### Build-time risks (resolve during Phase 5 integration)

1. **Does `@polymarket/clob-client-v2` auto-wrap ERC-7739 when `signatureType=POLY_1271`?** Most likely yes (the SDK provides this so dApps don't have to). If not, port the wrapping helper from the SDK source (~80 lines).
2. **Does Circle's `signTypedData` accept arbitrary EIP-712 types** (the V2 Order struct is non-standard), or only well-known types? The docs say "EIP-712 typed data" generically — should accept any well-formed `{domain, types, primaryType, message}`. Verify with a single test call before scaffolding.
3. **Circle entity-secret handling.** One-time setup: register entity secret with Circle, generate ciphertext per request using their public key (RSA-OAEP-256). Standard pattern; 5-10 lines of crypto wrapper.
4. **Rate limits.** Circle's developer API has rate limits (need to verify the tier we're on). For a hackathon demo with handful of users this won't bite, but worth checking the limit before claiming "production-ready."

### Trust-model considerations

- **Developer-controlled wallets mean Stoa-the-operator holds the keys.** We must disclose this clearly in the bot's onboarding ("Stoa custodies your funds. Withdraw any time."). Mitigation for self-custody: build an "export wallet" command that hands the user the private key on demand (or migrates them to a user-controlled Circle wallet with a PIN they set).
- **Builder code is on Stoa's profile.** All users' trades attribute to the same builder code. This is correct for revenue capture but means the operator is the "registered builder" — important to make sure the operator's KYC posture matches whatever Polymarket requires of registered builders.

### Things this design intentionally does *not* do (avoid scope creep)

- **No SCA on Polygon for Phase 5.** Wait to validate the Polymarket POLY_1271 + EOA path first; revisit SCA if Polymarket later confirms recursive 1271 support, or if Circle Paymaster gas sponsorship becomes load-bearing.
- **No User-Controlled (PIN) wallets in v0.** Adds a UX step (PIN prompt) and key-recovery complexity. Roadmap item, not Phase-5 launch requirement.
- **No Modular Wallets / passkeys.** Same logic — ERC-6900 is overkill for "user clicks Confirm and an order goes in."

---

## Sources

Polymarket V2:
- [Deposit Wallets — Polymarket Documentation](https://docs.polymarket.com/trading/deposit-wallets)
- [V2 Quickstart — Polymarket Documentation](https://docs.polymarket.com/trading/quickstart)
- [PolyNode — Deposit Wallets Guide](https://polynode.mintlify.app/guides/deposit-wallets) (community-maintained, more detail on ERC-7739 wrapping than the official docs)
- [py-clob-client-v2 Issue #53 — "EOA basic flow rejected"](https://github.com/Polymarket/py-clob-client-v2/issues/53) (confirms the exact error we hit was the V2-migration EOA-rejection cutover, not a config bug)
- [Polymarket V2 migration guide — tradoxvps.com](https://tradoxvps.com/polymarket-v2-migration-how-to-update-your-trading-bots-before-they-stop-working/) (community summary; confirms April 28, 2026 cutover date)

Circle Wallets:
- [Supported Blockchains — Circle Docs](https://developers.circle.com/wallets/supported-blockchains)
- [Onboard Users to Developer-Controlled Wallets — Circle Docs](https://developers.circle.com/wallets/dev-controlled/onboard-users)
- [Sign Typed Data API — Circle Docs](https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/sign-typed-data)
- [Modular Wallets enhancement — Circle Blog](https://www.circle.com/blog/modular-wallets-a-latest-enhancement-to-programmable-wallets)
- [Integrate Cross-Chain USDC Transfers in Telegram Bots — Circle Blog](https://www.circle.com/blog/how-to-integrate-cross-chain-usdc-transfers-in-your-telegram-bot)
