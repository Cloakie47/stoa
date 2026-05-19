/**
 * One-time initializer for the 3 Stoa system wallets' confidential
 * accounts on Fairblock StableTrust.
 *
 * The first user-facing call against any address triggers Fairblock's
 * `ensureAccount` step (homomorphic-encryption keypair generation +
 * on-chain public-key registration, ~45s). A recipient address that
 * has never run ensureAccount cannot RECEIVE a confidential transfer
 * — so before any /analyze fee can be split confidentially across
 * operator/maintainers/Canteen, all 3 must be pre-initialized.
 *
 * Triggering ensureAccount via a $0.10 deposit (instead of a no-op
 * call) means the wallet ends up with $0.10 of shielded USDC, which
 * is the minimum useful "seeded" state.
 *
 * The script is IDEMPOTENT — it calls /balance first; if the account
 * is already registered (success response), it skips the deposit.
 *
 * Usage:
 *   cd apps/analyzer
 *   npx tsx scripts/init-system-wallets.ts            # live, after Fairblock deployment
 *   npx tsx scripts/init-system-wallets.ts --dry-run  # mocked HTTP for self-verify
 *
 * Pre-requisites (in .env.debug at repo root):
 *   OPERATOR_PRIVATE_KEY      — Stoa deployer key, also gas-payer + Settler operator
 *   MAINTAINERS_PRIVATE_KEY   — 20% fee recipient
 *   CANTEEN_PRIVATE_KEY       — 10% fee recipient
 *
 * Optional overrides:
 *   STABLETRUST_API_URL       — default https://stabletrust-api.fairblock.network
 *   STABLETRUST_ARC_USDC      — default 0x3600000000000000000000000000000000000000
 *   ARC_RPC_URL               — default https://rpc.testnet.arc.network (not used by
 *                                this script directly, but read for parity with the
 *                                rest of the debug-script env)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  StableTrustClient,
  StableTrustError,
} from "@stoa/stabletrust-client";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

const DEFAULT_API_URL = "https://stabletrust-api.fairblock.network";
const DEFAULT_USDC = "0x3600000000000000000000000000000000000000";
const ARC_CHAIN_ID = 5042002;
const INIT_AMOUNT_MICROS = "100000"; // $0.10 — triggers ensureAccount

interface WalletSpec {
  label: string;
  envKey: string;
}

const WALLETS: ReadonlyArray<WalletSpec> = [
  { label: "operator", envKey: "OPERATOR_PRIVATE_KEY" },
  { label: "maintainers", envKey: "MAINTAINERS_PRIVATE_KEY" },
  { label: "canteen", envKey: "CANTEEN_PRIVATE_KEY" },
];

/**
 * Parse a .env-style file. Handles UTF-16 LE BOM (PowerShell's default
 * encoding on Windows) and UTF-8 BOM transparently. Strips surrounding
 * quotes and `export ` prefixes. Skips comments and blank lines.
 */
function parseEnvFile(path: string): Record<string, string> {
  const buf = readFileSync(path);
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
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function maskAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function maskTxHash(h: string): string {
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

function fmtUsdc(microsStr: string): string {
  return (Number(BigInt(microsStr)) / 1_000_000).toFixed(6);
}

function fmtElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

interface ClientLike {
  getShieldedBalance(args: {
    privateKey: string;
    tokenAddress: string;
    chainId: number;
  }): Promise<{
    balance: { total: string; available: string; pending: string };
  }>;
  depositToShield(args: {
    privateKey: string;
    tokenAddress: string;
    amount: string;
    chainId: number;
    waitForFinalization?: boolean;
  }): Promise<{ receipt: { hash: string } }>;
}

/**
 * Dry-run mock that exercises both code paths without network. The
 * first wallet's /balance succeeds (simulating "already initialized");
 * the second and third throw 404 on /balance, then succeed on /deposit
 * and on the post-deposit /balance re-verification. This proves the
 * skip-path AND the init-path branching logic is wired correctly.
 */
function makeDryRunClient(): ClientLike {
  let calls = 0;
  return {
    async getShieldedBalance(_args) {
      calls++;
      // Calls in dry-run sequence:
      //   1. operator   /balance pre-check     → SUCCESS (already initialized, skip)
      //   2. maintainers /balance pre-check    → THROW 404
      //   3. maintainers /balance post-deposit → SUCCESS
      //   4. canteen     /balance pre-check    → THROW 404
      //   5. canteen     /balance post-deposit → SUCCESS
      if (calls === 1) {
        return {
          balance: { total: "500000", available: "500000", pending: "0" },
        };
      }
      if (calls === 2 || calls === 4) {
        throw new StableTrustError(
          "[dry-run] account not registered",
          404,
        );
      }
      return {
        balance: {
          total: INIT_AMOUNT_MICROS,
          available: INIT_AMOUNT_MICROS,
          pending: "0",
        },
      };
    },
    async depositToShield(_args) {
      // Simulate ~500ms "finalization" so the dry-run shows real elapsed time.
      await new Promise((r) => setTimeout(r, 500));
      return {
        receipt: {
          hash:
            "0x" +
            Array.from({ length: 32 })
              .map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, "0"))
              .join(""),
        },
      };
    },
  };
}

interface InitOutcome {
  alreadyInitialized: boolean;
  balanceMicros: string;
  depositTx: string | null;
}

async function initializeOne(args: {
  client: ClientLike;
  label: string;
  privateKey: Hex;
  tokenAddress: string;
  chainId: number;
}): Promise<InitOutcome> {
  const { client, label, privateKey, tokenAddress, chainId } = args;
  const address = privateKeyToAccount(privateKey).address;
  const masked = maskAddress(address);

  console.log(`[init-system-wallets] Initializing ${label} ${masked}`);

  // /balance pre-check — non-error = account already registered.
  try {
    const bal = await client.getShieldedBalance({
      privateKey,
      tokenAddress,
      chainId,
    });
    console.log(
      `[init-system-wallets]   /balance check → already initialized, total=$${fmtUsdc(bal.balance.total)}`,
    );
    console.log(`[init-system-wallets] ✅ ${label} initialized (skipped)\n`);
    return {
      alreadyInitialized: true,
      balanceMicros: bal.balance.total,
      depositTx: null,
    };
  } catch (e) {
    if (e instanceof StableTrustError) {
      console.log(
        `[init-system-wallets]   /balance check → account does not exist (status ${e.status ?? "n/a"})`,
      );
    } else {
      // Non-StableTrust errors (network, TypeError, etc) — bubble up so
      // the outer loop halts the script. We never want to silently
      // "init" past an unexpected failure mode.
      throw e;
    }
  }

  // /deposit $0.10 — triggers ensureAccount on Fairblock's side.
  console.log(
    `[init-system-wallets]   /deposit $${(Number(INIT_AMOUNT_MICROS) / 1e6).toFixed(2)} → submitting (waitForFinalization=true, ~45s)`,
  );
  const depositStart = Date.now();
  const deposit = await client.depositToShield({
    privateKey,
    tokenAddress,
    amount: INIT_AMOUNT_MICROS,
    chainId,
    waitForFinalization: true,
  });
  const depositElapsed = Date.now() - depositStart;
  console.log(
    `[init-system-wallets]   /deposit tx ${maskTxHash(deposit.receipt.hash)} finalized in ${fmtElapsed(depositElapsed)}`,
  );

  // Post-deposit /balance verification — confirms ensureAccount succeeded
  // AND the deposit actually reached the shielded balance.
  const bal = await client.getShieldedBalance({
    privateKey,
    tokenAddress,
    chainId,
  });
  console.log(
    `[init-system-wallets]   /balance check → ${bal.balance.total} micros ($${fmtUsdc(bal.balance.total)})`,
  );
  console.log(`[init-system-wallets] ✅ ${label} initialized\n`);
  return {
    alreadyInitialized: false,
    balanceMicros: bal.balance.total,
    depositTx: deposit.receipt.hash,
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  console.log(`╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  Stoa × Fairblock StableTrust — system wallet initializer   ║`);
  console.log(
    `║  MODE: ${dryRun ? "--dry-run (mocked HTTP, no network)              " : "live (real Fairblock + Arc Testnet)              "} ║`,
  );
  console.log(`╚════════════════════════════════════════════════════════════╝\n`);

  // Load .env.debug
  const envPath = resolve(REPO_ROOT, ".env.debug");
  let env: Record<string, string> = {};
  try {
    env = parseEnvFile(envPath);
  } catch (e) {
    if (!dryRun) {
      console.error(
        `❌ Could not read ${envPath}: ${(e as Error).message}\n` +
          `   Create the file at the repo root with the required keys (see script header).`,
      );
      process.exit(1);
    }
    console.log(
      `[init-system-wallets] (dry-run) ${envPath} not readable, using fake keys for branching test.\n`,
    );
  }

  // Validate required keys (don't echo values).
  const missing: string[] = [];
  for (const w of WALLETS) {
    const v = env[w.envKey];
    if (!v || !v.startsWith("0x") || v.length < 10) missing.push(w.envKey);
  }
  if (missing.length > 0) {
    if (dryRun) {
      console.log(
        `[init-system-wallets] (dry-run) Missing keys ${missing.join(", ")} — substituting deterministic fake keys to exercise both branches.\n`,
      );
      const fakeKeys: Record<string, string> = {
        OPERATOR_PRIVATE_KEY: "0x" + "11".repeat(32),
        MAINTAINERS_PRIVATE_KEY: "0x" + "22".repeat(32),
        CANTEEN_PRIVATE_KEY: "0x" + "33".repeat(32),
      };
      for (const k of missing) {
        if (fakeKeys[k]) env[k] = fakeKeys[k];
      }
    } else {
      console.error(
        `❌ Missing or malformed env vars in ${envPath}: ${missing.join(", ")}\n` +
          `   Each must be a 0x-prefixed Arc Testnet private key.`,
      );
      process.exit(1);
    }
  }

  const apiUrl = env.STABLETRUST_API_URL || DEFAULT_API_URL;
  const tokenAddress = env.STABLETRUST_ARC_USDC || DEFAULT_USDC;

  console.log(`Fairblock API:    ${apiUrl}`);
  console.log(`Token:            ${tokenAddress}`);
  console.log(`Chain ID:         ${ARC_CHAIN_ID}`);
  console.log(`Wallets to init:  ${WALLETS.map((w) => w.label).join(", ")}\n`);

  const client: ClientLike = dryRun
    ? makeDryRunClient()
    : new StableTrustClient({ baseUrl: apiUrl });

  const startMs = Date.now();
  for (const wallet of WALLETS) {
    const pk = env[wallet.envKey] as Hex;
    try {
      await initializeOne({
        client,
        label: wallet.label,
        privateKey: pk,
        tokenAddress,
        chainId: ARC_CHAIN_ID,
      });
    } catch (e) {
      const msg = (e as Error).message;
      console.error(
        `[init-system-wallets] ❌ Failed to initialize ${wallet.label}: ${msg}`,
      );
      console.error(
        `[init-system-wallets]    Halting — does NOT continue to next wallet on failure.`,
      );
      process.exit(1);
    }
  }
  const elapsedMs = Date.now() - startMs;

  console.log(
    `[init-system-wallets] All ${WALLETS.length} wallets initialized. Total time: ${fmtElapsed(elapsedMs)}.`,
  );
  console.log(`[init-system-wallets] Safe to flip STOA_USE_STABLETRUST=true.`);
}

main().catch((e: Error) => {
  console.error(`Unhandled error: ${e.message}\n${e.stack ?? ""}`);
  process.exit(1);
});
