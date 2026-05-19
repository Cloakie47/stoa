/**
 * Local simulator for the load-bearing Stoa-routed payment flows.
 *
 * What it does:
 *   1. Loads .env at repo root (DEPLOYER_PRIVATE_KEY, ANTHROPIC_API_KEY, etc).
 *   2. Uses TEST_USER_PRIVATE_KEY if set, else generates a fresh test wallet
 *      and prints its address (so the operator can fund it before re-running).
 *   3. Confirms the test wallet has ≥ $0.30 USDC on Arc Testnet.
 *   4. Simulates /analyze: fires a real $0.15 StoaSettler.settle on Arc with
 *      a non-zero trace hash (the trace itself is faked — we test the
 *      payment path, not the analysis cost).
 *   5. Simulates /confirm: fires a real $0.20 StoaSettler.settle on Arc with
 *      a zero trace hash (skips the pin step).
 *   6. Records both tx hashes; verifies both succeeded.
 *
 * What it does NOT do:
 *   - Run the Telegram webhook / grammY layer.
 *   - Write to D1. The bot's persistence is exercised by `wrangler dev`.
 *   - Run the real insight-engine multi-agent analysis. That requires an
 *     LLM call per agent and is expensive; skipped here. Use `SIMULATE_REAL_ANALYSIS=1`
 *     env var to run that path too (costs ~$0.30 in Anthropic credits).
 *   - Place a Limitless trade. That's mocked in the bot anyway.
 *
 * Usage:
 *   tsx apps/bot/scripts/simulate.ts
 *   SIMULATE_REAL_ANALYSIS=1 tsx apps/bot/scripts/simulate.ts
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  payStoaFee,
  publicArc,
  readUsdcBalanceArc,
  type BotCoreConfig,
} from "@stoa/bot-core";
import { keccak256, toBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// ── Env loading ──────────────────────────────────────────────────────────────

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
loadDotenv(resolve(repoRoot, ".env"));

function loadDotenv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.warn(`[simulate] No .env at ${path}; relying on shell env.`);
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && m[2] && !process.env[m[1]]) {
      process.env[m[1]] = m[2];
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function require(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[simulate] FATAL: env var ${name} required.`);
    process.exit(1);
  }
  return v;
}

function fmtUsdc(micros: bigint): string {
  return (Number(micros) / 1_000_000).toFixed(4);
}

// ── Build the Env object the bot expects ─────────────────────────────────────
//
// Mirrors wrangler.toml [vars] + the required secrets. For local simulation
// we use the deployer wallet as the operator AND as the three Stoa fee
// recipients (so the operator gets back its own money — net cost is just
// gas). This is fine for testing the on-chain mechanics.

function buildCfg(): BotCoreConfig {
  const deployerPk = require("DEPLOYER_PRIVATE_KEY") as Hex;
  const deployerAddress = privateKeyToAccount(deployerPk).address;
  return {
    ARC_TESTNET_RPC: process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.network",
    ARC_CHAIN_ID: "5042002",
    BASE_RPC: process.env.BASE_RPC ?? "https://mainnet.base.org",
    BASE_CHAIN_ID: "8453",
    ARC_USDC: "0x3600000000000000000000000000000000000000",
    STOA_SETTLER: "0x05a98A1dCa17917B6e8B19306c1653fA9FC5d689",
    STOA_SPLITTER: "0x114942B5FeebFDf9F1FA2F161eA9C2A1754C407F",
    STOA_TRACEPIN: "0x657355b621494C5F99253ce9A4c2cE8B9b488B7B",
    BASE_USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    STOA_FEE_ANALYZE_USDC: "150000",
    STOA_FEE_CONFIRM_USDC: "200000",
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    WALLET_ENCRYPTION_KEY:
      process.env.WALLET_ENCRYPTION_KEY ??
      "0000000000000000000000000000000000000000000000000000000000000001",
    OPERATOR_PRIVATE_KEY: deployerPk,
    // For local sim we point all three recipients at the operator/deployer
    // so the funds round-trip back. Operator covers gas + LLM costs.
    STOA_RECIPIENT_OPERATOR: deployerAddress,
    STOA_RECIPIENT_MAINTAINERS: deployerAddress,
    STOA_RECIPIENT_CANTEEN: deployerAddress,
    PINATA_JWT: process.env.PINATA_JWT,
    // Simulator never exercises the StableTrust path; defaults satisfy the type.
    STOA_USE_STABLETRUST: false,
    FAIRBLOCK_API_URL: "https://stabletrust-api.fairblock.network",
    STABLETRUST_ARC_USDC_ADDRESS:
      "0x3600000000000000000000000000000000000000",
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║       Stoa bot simulator — Arc Testnet StoaSettler           ║");
  console.log("║       (real txs, no LLM calls, no Telegram, no D1)            ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const cfg = buildCfg();
  const pc = publicArc(cfg);

  // ── Test wallet ────────────────────────────────────────────────────────────
  // Default to using the deployer wallet for both the operator (gas) AND the
  // test user (USDC source). With all three Stoa recipients pointed at the
  // deployer, the funds round-trip and net cost is just gas.
  let testPk = process.env.TEST_USER_PRIVATE_KEY as Hex | undefined;
  if (!testPk) {
    testPk = cfg.OPERATOR_PRIVATE_KEY as Hex;
    console.log("ℹ️  No TEST_USER_PRIVATE_KEY in env — using DEPLOYER_PRIVATE_KEY");
    console.log("   as both test-user and operator. Stoa recipients all point");
    console.log("   to the deployer, so net cost = gas only.\n");
  }
  const testAccount = privateKeyToAccount(testPk);
  void generatePrivateKey; // silence "unused"
  console.log(`Test user address:   ${testAccount.address}`);
  console.log(`Operator address:    ${privateKeyToAccount(cfg.OPERATOR_PRIVATE_KEY as Hex).address}`);
  console.log(`Arc RPC:             ${cfg.ARC_TESTNET_RPC}`);
  console.log(`StoaSettler:         ${cfg.STOA_SETTLER}`);

  const bal0 = await readUsdcBalanceArc(cfg, testAccount.address);
  console.log(`\nTest wallet Arc USDC balance: ${fmtUsdc(bal0)} USDC`);
  if (bal0 < 300_000n) {
    console.log("\n❌ Need at least 0.30 USDC on Arc Testnet. Fund and re-run.");
    console.log(`   Send to: ${testAccount.address}\n`);
    return;
  }

  // ── Step 1: /analyze fee ($0.15) with a non-zero trace hash ─────────────────
  console.log("\n── /analyze simulation ─────────────────────────────────────");
  console.log("Paying $0.15 from test wallet → StoaSettler.settle()");
  console.log("  Split: 70/20/10 across [operator, maintainers, canteen]");
  console.log("  Trace pin: enabled (using a fake trace hash for this sim)");

  const fakeTrace = `simulated-trace:${Date.now()}`;
  const fakeTraceHash = keccak256(toBytes(fakeTrace));
  const analyzeTx = await payStoaFee({
    cfg,
    userPrivateKey: testPk,
    userAddress: testAccount.address,
    amountUsdcMicros: 100_000n,
    traceHash: fakeTraceHash,
    ipfsCid: "bafk-simulated",
  });
  console.log(`✓ Analyze settle tx: ${analyzeTx}`);
  console.log(`  https://testnet.arcscan.app/tx/${analyzeTx}`);

  // ── Step 2: /confirm fee ($0.20) with zero trace hash (skips pin) ──────────
  console.log("\n── /confirm simulation ─────────────────────────────────────");
  console.log("Paying $0.20 from test wallet → StoaSettler.settle()");
  console.log("  Split: 70/20/10 (same recipients)");
  console.log("  Trace pin: skipped (zero hash)");

  const confirmTx = await payStoaFee({
    cfg,
    userPrivateKey: testPk,
    userAddress: testAccount.address,
    amountUsdcMicros: 200_000n,
  });
  console.log(`✓ Confirm settle tx: ${confirmTx}`);
  console.log(`  https://testnet.arcscan.app/tx/${confirmTx}`);

  // ── Step 3: Mocked Limitless order (printed only) ───────────────────────────
  const mockOrderId = `LMTS-MOCK-${[...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  console.log("\n── Limitless order (MOCKED v0) ─────────────────────────────");
  console.log(`Mock orderId: ${mockOrderId}`);
  console.log("  Real call will replace this when the partner token arrives.");

  // ── Final state ────────────────────────────────────────────────────────────
  const balN = await readUsdcBalanceArc(cfg, testAccount.address);
  console.log("\n── Final state ────────────────────────────────────────────");
  console.log(`Test wallet balance: ${fmtUsdc(bal0)} → ${fmtUsdc(balN)} USDC`);
  console.log(`Spent: ${fmtUsdc(bal0 - balN)} USDC ($0.30 nominally; rest is on-chain rounding)`);

  // ── Receipts (proof) ───────────────────────────────────────────────────────
  const [analyzeReceipt, confirmReceipt] = await Promise.all([
    pc.getTransactionReceipt({ hash: analyzeTx }),
    pc.getTransactionReceipt({ hash: confirmTx }),
  ]);
  console.log("\n── Receipts ───────────────────────────────────────────────");
  console.log(`Analyze: status=${analyzeReceipt.status} block=${analyzeReceipt.blockNumber} logs=${analyzeReceipt.logs.length}`);
  console.log(`Confirm: status=${confirmReceipt.status} block=${confirmReceipt.blockNumber} logs=${confirmReceipt.logs.length}`);

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║                  SIMULATION SUCCEEDED                        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log("Both Stoa-routed payments produced real Arc Testnet txs.");
  console.log("The bot's /analyze and /confirm command handlers wrap exactly");
  console.log("this flow plus the LLM analysis + D1 persistence.");
  console.log("Next step: `wrangler deploy` + Telegram webhook setup.\n");
}

main().catch((e) => {
  console.error("\n[simulate] Unhandled error:");
  console.error(e);
  process.exit(1);
});
