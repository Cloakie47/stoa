/**
 * StableTrust integration test — ten-step Arc Testnet diagnostic.
 *
 * MUST be run successfully BEFORE the operator flips STOA_USE_STABLETRUST=true
 * in any deployed environment. It verifies:
 *   - Fairblock API is reachable from the host (locally or Railway)
 *   - Private key signing works through the API's server-side proof layer
 *   - Confidential balance reads return well-formed values
 *   - A complete deposit → balance → transfer → balance → withdraw cycle
 *     completes on Arc Testnet without errors
 *
 * Usage:
 *   cd apps/analyzer && npx tsx scripts/test-stabletrust.ts
 *
 * Env vars required:
 *   TEST_USER_PRIVATE_KEY       — 0x-hex Arc Testnet wallet PK with ≥1.6 USDC public balance
 *   TEST_RECIPIENT_ADDRESS      — 0x address of a second wallet to receive the confidential transfer
 *   STABLETRUST_ARC_USDC_ADDRESS — defaults to Arc Testnet USDC 0x3600...
 *   FAIRBLOCK_API_URL           — defaults to https://stabletrust-api.fairblock.network
 *
 * Optional:
 *   STABLETRUST_ARC_CONTRACT_ADDRESS — when set, threaded into every API call as
 *                                       `contractAddress` body param. Required for chains
 *                                       not yet in Fairblock's server-side registry
 *                                       (e.g. 5042002 as of 2026-05-19).
 *
 * .env.debug fallback (repo-root): when an expected `TEST_*` process.env
 * var is missing, the script reads `.env.debug` (same UTF-16 BOM handling
 * as init-system-wallets.ts) and uses `OPERATOR_PRIVATE_KEY` as both
 * sender and recipient. This is the Phase 1 verification mode.
 *
 * Self-transfer detection: when the sender's address equals RECIPIENT,
 * Step 5 and Step 10 assertions are adjusted to expect net-zero motion
 * on the transfer leg (the round-trip math becomes DEPOSIT - WITHDRAW).
 *
 * Exits 0 on full success, 1 on any step failure (with the error message logged).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { StableTrustClient } from "@stoa/stabletrust-client";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

function parseEnvFile(path: string): Record<string, string> {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return {};
  }
  let text: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString("utf16le");
  } else if (
    buf.length >= 3 &&
    buf[0] === 0xef &&
    buf[1] === 0xbb &&
    buf[2] === 0xbf
  ) {
    text = buf.subarray(3).toString("utf8");
  } else {
    text = buf.toString("utf8");
  }
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq).trim().replace(/^export\s+/, "")] = line
      .slice(eq + 1)
      .trim();
  }
  return out;
}

const ENV_DEBUG = parseEnvFile(resolve(REPO_ROOT, ".env.debug"));

const FAIRBLOCK_API_URL =
  process.env.FAIRBLOCK_API_URL ?? "https://stabletrust-api.fairblock.network";
const TOKEN =
  process.env.STABLETRUST_ARC_USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000";

// USER_PK: prefer TEST_USER_PRIVATE_KEY, fall back to OPERATOR_PRIVATE_KEY in .env.debug.
const USER_PK =
  process.env.TEST_USER_PRIVATE_KEY && process.env.TEST_USER_PRIVATE_KEY.length > 0
    ? process.env.TEST_USER_PRIVATE_KEY
    : ENV_DEBUG.OPERATOR_PRIVATE_KEY;
if (!USER_PK || !USER_PK.startsWith("0x")) {
  console.error(
    "❌ Missing sender key. Set TEST_USER_PRIVATE_KEY in env, or OPERATOR_PRIVATE_KEY in .env.debug.",
  );
  process.exit(1);
}
const USER_ADDRESS = privateKeyToAccount(USER_PK as Hex).address;

// RECIPIENT priority:
//   1. TEST_RECIPIENT_ADDRESS env var
//   2. MAINTAINERS_PRIVATE_KEY's derived address (from .env.debug) —
//      empirically required because Fairblock's API rejects self-transfers
//      with HTTP 500 (verified 2026-05-19).
//   3. fall back to USER_ADDRESS (self-transfer) — the assertions below
//      detect this and adjust, but the API call will fail; kept only as
//      a no-config default so the script can still run for a smoke test.
const RECIPIENT =
  process.env.TEST_RECIPIENT_ADDRESS &&
  process.env.TEST_RECIPIENT_ADDRESS.length > 0
    ? process.env.TEST_RECIPIENT_ADDRESS
    : ENV_DEBUG.MAINTAINERS_PRIVATE_KEY &&
        ENV_DEBUG.MAINTAINERS_PRIVATE_KEY.startsWith("0x")
      ? privateKeyToAccount(ENV_DEBUG.MAINTAINERS_PRIVATE_KEY as Hex).address
      : USER_ADDRESS;

const IS_SELF_TRANSFER = RECIPIENT.toLowerCase() === USER_ADDRESS.toLowerCase();

const DEPOSIT_AMOUNT = "1000000"; // 1.0 USDC (6 decimals)
const TRANSFER_AMOUNT = "500000"; // 0.5 USDC
const WITHDRAW_AMOUNT = "500000"; // 0.5 USDC
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? "5042002");
const CONTRACT_ADDRESS =
  process.env.STABLETRUST_ARC_CONTRACT_ADDRESS &&
  process.env.STABLETRUST_ARC_CONTRACT_ADDRESS.length > 0
    ? process.env.STABLETRUST_ARC_CONTRACT_ADDRESS
    : undefined;
const CONTRACT_OVERRIDE: { contractAddress?: string } = CONTRACT_ADDRESS
  ? { contractAddress: CONTRACT_ADDRESS }
  : {};

function fail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

function fmtBalance(s: string): string {
  return (Number(BigInt(s)) / 1_000_000).toFixed(6);
}

async function main(): Promise<void> {
  console.log(`╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  Stoa × Fairblock StableTrust — integration test            ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);
  console.log(`Fairblock API: ${FAIRBLOCK_API_URL}`);
  console.log(`Token:         ${TOKEN}`);
  console.log(
    `Sender:        ${USER_ADDRESS.slice(0, 6)}…${USER_ADDRESS.slice(-4)}`,
  );
  console.log(
    `Recipient:     ${RECIPIENT}${IS_SELF_TRANSFER ? " (self-transfer mode)" : ""}`,
  );
  console.log(
    `Contract:      ${CONTRACT_ADDRESS ?? "(unset — using Fairblock's chainId registry default)"}\n`,
  );

  const client = new StableTrustClient({ baseUrl: FAIRBLOCK_API_URL });

  // ── Step 1: initial balance read ────────────────────────────────────────
  console.log(`[1/10] Reading initial shielded balance...`);
  const before = await client
    .getShieldedBalance({
      privateKey: USER_PK,
      tokenAddress: TOKEN,
      chainId: CHAIN_ID,
      ...CONTRACT_OVERRIDE,
    })
    .catch((e: Error) => fail(`getShieldedBalance failed: ${e.message}`));
  console.log(
    `       total=$${fmtBalance(before.balance.total)} ` +
      `available=$${fmtBalance(before.balance.available)} ` +
      `pending=$${fmtBalance(before.balance.pending)}\n`,
  );

  // ── Step 2: deposit to shield ───────────────────────────────────────────
  console.log(`[2/10] Depositing 1.0 USDC to shielded balance...`);
  const deposit = await client
    .depositToShield({
      privateKey: USER_PK,
      tokenAddress: TOKEN,
      amount: DEPOSIT_AMOUNT,
      chainId: CHAIN_ID,
      ...CONTRACT_OVERRIDE,
      waitForFinalization: true,
    })
    .catch((e: Error) => fail(`depositToShield failed: ${e.message}`));
  console.log(`       tx: ${deposit.tx}\n`);

  // ── Step 3: balance after deposit ───────────────────────────────────────
  console.log(`[3/10] Reading shielded balance after deposit...`);
  const afterDeposit = await client
    .getShieldedBalance({
      privateKey: USER_PK,
      tokenAddress: TOKEN,
      chainId: CHAIN_ID,
      ...CONTRACT_OVERRIDE,
    })
    .catch((e: Error) => fail(`getShieldedBalance (post-deposit) failed: ${e.message}`));
  console.log(
    `       total=$${fmtBalance(afterDeposit.balance.total)} ` +
      `available=$${fmtBalance(afterDeposit.balance.available)} ` +
      `pending=$${fmtBalance(afterDeposit.balance.pending)}`,
  );
  const delta = BigInt(afterDeposit.balance.total) - BigInt(before.balance.total);
  if (delta < BigInt(DEPOSIT_AMOUNT)) {
    fail(
      `Balance did not increase by ≥${DEPOSIT_AMOUNT} after deposit. delta=${delta.toString()}`,
    );
  }
  console.log(`       Δ +$${fmtBalance(delta.toString())} ✓\n`);

  // ── Step 4: confidential transfer ───────────────────────────────────────
  console.log(`[4/10] Confidentially transferring 0.5 USDC to ${RECIPIENT}...`);
  const transfer = await client
    .confidentialTransfer({
      privateKey: USER_PK,
      recipientAddress: RECIPIENT,
      tokenAddress: TOKEN,
      amount: TRANSFER_AMOUNT,
      chainId: CHAIN_ID,
      ...CONTRACT_OVERRIDE,
      useOffchainVerify: false,
      waitForFinalization: true,
    })
    .catch((e: Error) => fail(`confidentialTransfer failed: ${e.message}`));
  console.log(`       tx: ${transfer.tx}\n`);

  // ── Step 5: balance after transfer ──────────────────────────────────────
  console.log(`[5/10] Reading shielded balance after transfer...`);
  const afterTransfer = await client
    .getShieldedBalance({
      privateKey: USER_PK,
      tokenAddress: TOKEN,
      chainId: CHAIN_ID,
      ...CONTRACT_OVERRIDE,
    })
    .catch((e: Error) => fail(`getShieldedBalance (post-transfer) failed: ${e.message}`));
  console.log(
    `       total=$${fmtBalance(afterTransfer.balance.total)} ` +
      `available=$${fmtBalance(afterTransfer.balance.available)} ` +
      `pending=$${fmtBalance(afterTransfer.balance.pending)}`,
  );
  const transferDelta =
    BigInt(afterDeposit.balance.total) - BigInt(afterTransfer.balance.total);
  if (IS_SELF_TRANSFER) {
    // Self-transfer: outflow + inflow cancel, so the sender's net change
    // should be ~0. Allow $0.001 of dust drift.
    const drift = transferDelta < 0n ? -transferDelta : transferDelta;
    if (drift > 1000n) {
      fail(
        `Self-transfer expected ~0 balance change but observed ${transferDelta.toString()}`,
      );
    }
    console.log(
      `       Δ ${transferDelta >= 0n ? "-" : "+"}$${fmtBalance((transferDelta < 0n ? -transferDelta : transferDelta).toString())} (self-transfer, expected ~$0.000000) ✓\n`,
    );
  } else {
    if (transferDelta < BigInt(TRANSFER_AMOUNT)) {
      fail(
        `Balance did not decrease by ≥${TRANSFER_AMOUNT} after transfer. delta=${transferDelta.toString()}`,
      );
    }
    console.log(`       Δ -$${fmtBalance(transferDelta.toString())} ✓\n`);
  }

  // ── Step 6: withdraw to public ──────────────────────────────────────────
  console.log(`[6/10] Withdrawing 0.5 USDC back to public balance...`);
  const withdraw = await client
    .withdrawToPublic({
      privateKey: USER_PK,
      tokenAddress: TOKEN,
      amount: WITHDRAW_AMOUNT,
      chainId: CHAIN_ID,
      ...CONTRACT_OVERRIDE,
      useOffchainVerify: false,
      waitForFinalization: true,
    })
    .catch((e: Error) => fail(`withdrawToPublic failed: ${e.message}`));
  console.log(`       tx: ${withdraw.tx}\n`);

  // ── Step 7: balance after withdraw ──────────────────────────────────────
  console.log(`[7/10] Reading shielded balance after withdraw...`);
  const afterWithdraw = await client
    .getShieldedBalance({
      privateKey: USER_PK,
      tokenAddress: TOKEN,
      chainId: CHAIN_ID,
      ...CONTRACT_OVERRIDE,
    })
    .catch((e: Error) => fail(`getShieldedBalance (post-withdraw) failed: ${e.message}`));
  console.log(
    `       total=$${fmtBalance(afterWithdraw.balance.total)} ` +
      `available=$${fmtBalance(afterWithdraw.balance.available)} ` +
      `pending=$${fmtBalance(afterWithdraw.balance.pending)}`,
  );
  const withdrawDelta =
    BigInt(afterTransfer.balance.total) - BigInt(afterWithdraw.balance.total);
  if (withdrawDelta < BigInt(WITHDRAW_AMOUNT)) {
    fail(
      `Balance did not decrease by ≥${WITHDRAW_AMOUNT} after withdraw. delta=${withdrawDelta.toString()}`,
    );
  }
  console.log(`       Δ -$${fmtBalance(withdrawDelta.toString())} ✓\n`);

  // ── Step 8: balance must be finite + parseable ──────────────────────────
  console.log(`[8/10] Verifying final balance is well-formed...`);
  for (const field of ["total", "available", "pending"] as const) {
    const v = afterWithdraw.balance[field];
    try {
      BigInt(v);
    } catch {
      fail(`balance.${field} is not a valid base-unit integer: ${v}`);
    }
  }
  console.log(`       all fields parseable as BigInt ✓\n`);

  // ── Step 9: every receipt has a 0x-prefixed hash ────────────────────────
  console.log(`[9/10] Verifying all receipts have 0x-prefixed tx hashes...`);
  for (const [name, tx] of [
    ["deposit", deposit.tx],
    ["transfer", transfer.tx],
    ["withdraw", withdraw.tx],
  ] as const) {
    if (!/^0x[0-9a-fA-F]+$/.test(tx)) {
      fail(`${name} tx hash is malformed: ${tx}`);
    }
  }
  console.log(`       all 3 tx hashes well-formed ✓\n`);

  // ── Step 10: round-trip net cost is just the transfer amount ────────────
  console.log(`[10/10] Verifying round-trip accounting...`);
  const netChange =
    BigInt(afterWithdraw.balance.total) - BigInt(before.balance.total);
  // Cross-wallet: DEPOSIT - TRANSFER - WITHDRAW (sender loses TRANSFER).
  // Self-transfer: DEPOSIT - WITHDRAW (TRANSFER stays in the same wallet).
  const expectedNet = IS_SELF_TRANSFER
    ? BigInt(DEPOSIT_AMOUNT) - BigInt(WITHDRAW_AMOUNT)
    : BigInt(DEPOSIT_AMOUNT) - BigInt(TRANSFER_AMOUNT) - BigInt(WITHDRAW_AMOUNT);
  // Allow small dust differences from rounding inside the API.
  const tolerance = 1000n; // $0.001
  const drift = netChange - expectedNet;
  const absDrift = drift < 0n ? -drift : drift;
  if (absDrift > tolerance) {
    fail(
      `Net balance change ${fmtBalance(netChange.toString())} differs from expected ${fmtBalance(expectedNet.toString())} by more than $0.001`,
    );
  }
  console.log(
    `       expected Δ=$${fmtBalance(expectedNet.toString())} actual Δ=$${fmtBalance(netChange.toString())} ✓\n`,
  );

  console.log(`╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  ✅ All StableTrust operations succeeded on Arc Testnet     ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);
}

main().catch((e: Error) => {
  fail(`Unhandled error: ${e.message}\n${e.stack ?? ""}`);
});
