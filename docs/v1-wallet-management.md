# V1 Wallet Management — design notes for Phase 1

**Status:** design only, no implementation. To be implemented after
the Phase 1 confidential-architecture refactor (`v1-confidential-
architecture.md`) lands.

## Goal

Move from the current one-wallet-per-user model to a **multi-wallet
model** where:

* Each user has one or more wallets (default one, created on `/start`).
* Each wallet has a human-readable label ("Main", "Trading", "Test", etc).
* Exactly one wallet is "active" at any time — all `/analyze`,
  `/confirm`, `/balance`, `/shield` operations target the active one.
* Users can create more wallets, switch between them, and export the
  private key of any wallet they own.

V1.0 recommendation: ship single-wallet (the existing behavior, just
with the new schema underneath). Defer the create / switch /
multi-list commands to V1.1 if time permits. The schema is forward-
compatible — V1.0 just always has exactly one row per user.

## D1 schema

```sql
-- Migration apps/bot/migrations/0003_multi_wallet.sql

-- One row per wallet (a user can have many).
CREATE TABLE wallets (
  id TEXT PRIMARY KEY,                       -- UUID v4
  telegram_user_id INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT 'Main',
  address TEXT NOT NULL,                     -- 0x... checksummed
  encrypted_private_key TEXT NOT NULL,       -- base64(12-byte nonce ‖ AES-GCM ciphertext ‖ 16-byte tag)
  created_at INTEGER NOT NULL                -- unix seconds
);

CREATE INDEX idx_wallets_user ON wallets(telegram_user_id);
CREATE UNIQUE INDEX idx_wallets_user_label ON wallets(telegram_user_id, label);

-- Exactly one active wallet per user.
CREATE TABLE active_wallet (
  telegram_user_id INTEGER PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
);
```

### Migration path from the current (single-wallet) schema

Today `apps/bot/migrations/0001_init.sql` defines `wallets` with one
row per `telegram_user_id` (i.e. the user ID is the primary key).
The Phase 1 migration:

1. Renames the existing `wallets` table to `wallets_v0`.
2. Creates the new `wallets` and `active_wallet` tables.
3. Backfills: for every row in `wallets_v0`, insert one row into
   `wallets` with a fresh UUID, `label='Main'`, and the existing
   `encrypted_private_key`. Insert a row into `active_wallet`
   pointing at the new wallet ID.
4. Drops `wallets_v0` after a successful backfill verification.

The backfill is idempotent — re-running it on an already-migrated DB
is a no-op because of the `UNIQUE(telegram_user_id, label)`
constraint.

## Telegram commands

V1.0 (minimum viable):

| Command | Behavior |
|---|---|
| `/start` | Create the user's first wallet labeled "Main" if none exists; set active. Idempotent — re-running shows the funding info but does NOT regenerate the key. (Same as today, just routes through the new schema.) |
| `/wallet` | Show the active wallet's address + label + balances. |
| `/export_key` | DM the private key of the active wallet with a security warning. Requires explicit confirmation (`/export_key confirm`). |

V1.1 (multi-wallet UX):

| Command | Behavior |
|---|---|
| `/accounts` | List ALL the user's wallets with addresses, labels, and per-wallet USDC balance. Mark the active one with `▸`. |
| `/create_account <label>` | Generate a new viem EOA, encrypt + store, prompt for label if not provided. Does NOT auto-switch — the user explicitly issues `/switch` after funding. |
| `/switch` | Inline keyboard showing each wallet as a button. Tap to set as active. |
| `/rename <label>` | Rename the active wallet. Validates `UNIQUE(telegram_user_id, label)`. |
| `/delete <label>` | Delete a non-active wallet. Refuses if the wallet has any USDC balance (Arc or Base). Deletion is local-only — the underlying chain keys are gone but the on-chain wallet is still reachable by anyone with the key. |

The inline keyboard for `/switch` uses grammY's `InlineKeyboardMarkup`:

```ts
const keyboard = new InlineKeyboard();
for (const w of wallets) {
  const prefix = w.id === activeId ? "▸ " : "  ";
  keyboard
    .text(`${prefix}${w.label}  $${fmtBalance(w.balance)}`, `switch:${w.id}`)
    .row();
}
ctx.reply("Select active wallet:", { reply_markup: keyboard });
```

The bot handles `callback_query` with `switch:<wallet_id>`, validates
the wallet belongs to the user, updates `active_wallet`, then edits
the message to confirm. Standard grammY pattern.

## Encryption details

**Algorithm:** AES-256-GCM via Web Crypto (`crypto.subtle`) —
available in both Cloudflare Workers and Node 18+ without imports.

**Key derivation:** the per-message key is the 32-byte
`WALLET_ENCRYPTION_KEY` worker secret, used directly (no HKDF). The
secret is operator-provisioned via `wrangler secret put
WALLET_ENCRYPTION_KEY`. If we ever rotate the master key, the rotation
would re-encrypt every row under the new key (out of scope for V1).

**Blob format** (base64-encoded for storage in `TEXT`):

```
┌─────────┬──────────────────────────┬─────────┐
│ 12 byte │ AES-GCM ciphertext       │ 16 byte │
│ nonce   │ (length = plaintext len) │ auth tag│
└─────────┴──────────────────────────┴─────────┘
```

The nonce is fresh-random per encryption (12 bytes from `crypto
.getRandomValues`). The auth tag is the GCM-appended 16-byte
authenticator. Decryption verifies the tag; tampering rejects with a
clear error.

```ts
// packages/bot-core/src/crypto.ts — current shape (already implemented).
export async function encryptPrivateKey(plaintext: Hex, masterKey: Hex): Promise<string>;
export async function decryptPrivateKey(ciphertext: string, masterKey: Hex): Promise<Hex>;
```

These functions already exist in bot-core. The multi-wallet change is
purely in the **DB schema + wallet-loading helpers**, not in the
crypto layer.

## Wallet-loading helpers (Phase 1)

```ts
// packages/bot-core/src/wallet.ts — new signatures
export async function loadActiveWallet(
  db: DbClient,
  cfg: BotCoreConfig,
  telegramUserId: number,
): Promise<UserWallet | null>;

export async function listWallets(
  db: DbClient,
  cfg: BotCoreConfig,
  telegramUserId: number,
): Promise<Array<UserWallet & { label: string; balance_micros: bigint }>>;

export async function createWallet(
  db: DbClient,
  cfg: BotCoreConfig,
  telegramUserId: number,
  label: string,
): Promise<UserWallet>;

export async function setActiveWallet(
  db: DbClient,
  telegramUserId: number,
  walletId: string,
): Promise<void>;
```

The existing `loadUserWallet` is renamed to `loadActiveWallet` with
the same external semantics. All existing call sites
(`runAnalyzePipeline`, `runConfirmPipeline`, `handleBalance`, etc.)
continue to compile after a search-and-replace.

## Security / UX considerations

1. **`/export_key` gating.** The bot custodies user keys today. Adding
   `/export_key` makes the custody story softer — users can claim
   self-custody whenever they want. Recommend:
   * Two-step confirmation (`/export_key` shows a warning; `/export_key
     confirm` actually DMs the key).
   * The DM includes the address + label + a "delete this message
     after copying" reminder.
   * Log every export in a new `audit_log` table (`event_type =
     'key_export', user_id, wallet_id, at`).

2. **Wallet ownership check on every command.** The inline keyboard
   `switch:<wallet_id>` payload is user-controllable. The handler MUST
   re-verify `wallet.telegram_user_id === ctx.from.id` before applying
   the switch, even though the callback came from this user's chat —
   defense in depth against any future routing bug.

3. **Wallet labels are user-visible PII-adjacent.** They appear in
   `/accounts` lists and inline keyboards. Reject control characters,
   max 32 chars, allow Unicode letters/digits/space/`-_`. Reject
   reserved label `Main` for `/rename` to avoid name confusion with
   the auto-created first wallet (you can still create one called
   `MainTwo`).

4. **No cross-user wallet sharing.** Two Telegram users with the same
   `address` (e.g. they imported the same hardware wallet) get
   SEPARATE rows because the primary key is `wallets.id` not
   `address`. Each has their own `encrypted_private_key` blob. This
   is correct — Stoa doesn't try to detect or merge shared underlying
   keys; the bot's accounting is per Telegram-user.

## Out of scope for V1

* Wallet import (paste an existing private key into the bot to add as
  a wallet). The UX requires explicit clipboard handling and adds a
  meaningful key-exposure attack surface. Deferred.
* Hardware-wallet support. Telegram bots can't speak WalletConnect or
  Ledger natively. V2 would require a companion web UI.
* Multi-sig wallets. Not a hackathon-relevant primitive.
* Per-wallet shielded balance display. The current `/shielded_balance`
  command shows the ACTIVE wallet's shielded balance only; multi-wallet
  shielded UX is V1.1.

## Implementation order for Phase 1

1. **Write the migration** `apps/bot/migrations/0003_multi_wallet.sql`
   with the backfill.
2. **Refactor wallet helpers** in `packages/bot-core/src/wallet.ts`
   to expose `loadActiveWallet`, etc. Internal-only rename of
   `loadUserWallet` → `loadActiveWallet`; update all call sites in
   `pipelines.ts`, commands.
3. **Update `/start`** to write through the new schema (insert into
   `wallets` + `active_wallet`).
4. **Add `/wallet` command** (V1.0 minimum) — shows active wallet
   address + balances.
5. **Add `/export_key` command** (V1.0 minimum) with two-step
   confirmation + `audit_log` insert.
6. **Add unit tests** for `loadActiveWallet` against a seeded D1 with
   2 wallets per user, asserting only the active one returns.
7. **(V1.1)** `/accounts`, `/create_account`, `/switch`, `/rename`,
   `/delete` — sequenced after the V1.0 baseline ships.

Estimated work for V1.0 (single-wallet through new schema +
`/wallet` + `/export_key`): 3–4h. V1.1 (full multi-wallet UX): +4–5h.
