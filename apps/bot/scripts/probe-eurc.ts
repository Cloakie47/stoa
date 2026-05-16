/**
 * Probe Arc Testnet EURC for multi-currency settlement support.
 *
 * Background: the Arc Prediction Markets Blueprint (arc.io blog, 2026-05-08)
 * highlights multi-currency settlement (USDC/EURC) as a first-class capability.
 * Stoa's Splitter is token-agnostic (takes `token` as a parameter); our
 * deployed StoaSettler is USDC-only (binds the token at construction). This
 * probe verifies that the Splitter path works with EURC end-to-end.
 *
 * What it does:
 *   1. Reads EURC metadata at the canonical Arc Testnet address.
 *   2. Probes EIP-3009/EIP-712 readiness (DOMAIN_SEPARATOR, eip712Domain).
 *   3. Reads deployer's EURC balance.
 *   4. If balance ≥ 0.30 EURC, calls Splitter.distribute(EURC, [op,op,op], [7000,2000,1000], 100000)
 *      → atomic 70/20/10 split of $0.10 EURC routing back to the deployer.
 *   5. If balance < 0.30 EURC, reports clearly so operator can hit the Circle faucet.
 *
 * Usage:
 *   tsx apps/bot/scripts/probe-eurc.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── Constants ────────────────────────────────────────────────────────────────

const ARC_EURC: Address = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const ARC_RPC = "https://rpc.testnet.arc.network";
const STOA_SPLITTER: Address = "0x114942B5FeebFDf9F1FA2F161eA9C2A1754C407F";
const ARC_CHAIN_ID = 5042002;

// $0.10 in 6-dec EURC base units; round-trips 70/20/10 to deployer
const PROBE_AMOUNT = 100_000n;

// ── .env loader (matches simulate.ts) ────────────────────────────────────────

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
loadDotenv(resolve(repoRoot, ".env"));

function loadDotenv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.warn(`[probe-eurc] No .env at ${path}; relying on shell env.`);
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && m[2] && !process.env[m[1]]) {
      process.env[m[1]] = m[2];
    }
  }
}

// ── ABIs ─────────────────────────────────────────────────────────────────────

const eurcMetaAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const splitterAbi = [
  {
    type: "function",
    name: "distribute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "recipients", type: "address[]" },
      { name: "basisPoints", type: "uint256[]" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// ── Probe ────────────────────────────────────────────────────────────────────

function fmtEurc(micros: bigint): string {
  return (Number(micros) / 1_000_000).toFixed(4);
}

async function main(): Promise<void> {
  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  if (!pk) {
    console.error("[probe-eurc] FATAL: DEPLOYER_PRIVATE_KEY missing in .env");
    process.exit(1);
  }
  const account = privateKeyToAccount(pk);

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║      EURC probe — Arc Testnet multi-currency verification    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`EURC contract:   ${ARC_EURC}`);
  console.log(`Splitter:        ${STOA_SPLITTER}`);
  console.log(`Caller (deployer): ${account.address}`);
  console.log(`Arc RPC:         ${ARC_RPC}\n`);

  const pc = createPublicClient({ transport: http(ARC_RPC) });

  // ── 1. Metadata probe ──────────────────────────────────────────────────────
  console.log("── EURC metadata ─────────────────────────────────────────────");
  const fields: Array<keyof typeof eurcMetaAbi[number]["name"] | string> = [
    "name", "symbol", "version", "decimals", "DOMAIN_SEPARATOR",
  ];
  let supportsEip712 = false;
  for (const fn of fields) {
    try {
      const r = await pc.readContract({
        address: ARC_EURC,
        abi: eurcMetaAbi,
        functionName: fn as "name",
      });
      console.log(`  ${String(fn).padEnd(18)} = ${JSON.stringify(r).slice(0, 80)}`);
      if (fn === "DOMAIN_SEPARATOR" && typeof r === "string" && r.length === 66) {
        supportsEip712 = true;
      }
    } catch (e) {
      console.log(`  ${String(fn).padEnd(18)} REVERT (${(e as Error).message.slice(0, 60)}…)`);
    }
  }

  // ── 2. Balance ─────────────────────────────────────────────────────────────
  console.log("\n── Deployer EURC balance ─────────────────────────────────────");
  let bal: bigint;
  try {
    bal = await pc.readContract({
      address: ARC_EURC,
      abi: eurcMetaAbi,
      functionName: "balanceOf",
      args: [account.address],
    });
    console.log(`  Balance: ${fmtEurc(bal)} EURC (${bal.toString()} base units)`);
  } catch (e) {
    console.error(`  ❌ balanceOf reverted: ${(e as Error).message.slice(0, 200)}`);
    console.log("\n  EURC contract is unreachable from this RPC. Cannot proceed.");
    return;
  }

  // ── 3. Decide split test ───────────────────────────────────────────────────
  console.log("\n── Splitter.distribute test ──────────────────────────────────");
  if (bal < PROBE_AMOUNT) {
    console.log(`  ⚠  Need ≥ ${fmtEurc(PROBE_AMOUNT)} EURC to run a round-trip split.`);
    console.log("  ⚠  Deployer has none. Action: visit https://faucet.circle.com,");
    console.log("     select Arc Testnet + EURC, send to:");
    console.log(`     ${account.address}`);
    console.log("\n  Outcome:");
    console.log("    • EURC is deployed on Arc Testnet at the canonical address ✓");
    console.log(`    • EIP-712 / EIP-3009 readiness: ${supportsEip712 ? "yes (DOMAIN_SEPARATOR present)" : "could not verify"}`);
    console.log("    • Splitter is token-agnostic (verified by Splitter.sol source) ✓");
    console.log("    • End-to-end on-chain settle: UNVERIFIED (no testnet EURC at probe time)");
    return;
  }

  // ── 3a. Approve Splitter ──────────────────────────────────────────────────
  const wallet = createWalletClient({
    account,
    chain: {
      id: ARC_CHAIN_ID,
      name: "Arc Testnet",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
      rpcUrls: { default: { http: [ARC_RPC] } },
    },
    transport: http(ARC_RPC),
  });

  const existingAllowance = await pc.readContract({
    address: ARC_EURC,
    abi: eurcMetaAbi,
    functionName: "allowance",
    args: [account.address, STOA_SPLITTER],
  });

  if (existingAllowance < PROBE_AMOUNT) {
    console.log(`  Approving Splitter for ${fmtEurc(PROBE_AMOUNT)} EURC…`);
    const approveData = encodeFunctionData({
      abi: eurcMetaAbi,
      functionName: "approve",
      args: [STOA_SPLITTER, PROBE_AMOUNT],
    });
    const approveTx = await wallet.sendTransaction({
      account,
      to: ARC_EURC,
      data: approveData,
      value: 0n,
    });
    const approveReceipt = await pc.waitForTransactionReceipt({ hash: approveTx });
    console.log(`  ✓ Approve tx: ${approveTx} (block ${approveReceipt.blockNumber})`);
  } else {
    console.log(`  Allowance already ≥ ${fmtEurc(PROBE_AMOUNT)} — skipping approve`);
  }

  // ── 3b. Call Splitter.distribute(EURC, [op,op,op], [7000,2000,1000], 100000) ─
  const recipients: [Address, Address, Address] = [
    account.address, account.address, account.address,
  ];
  const bps: [bigint, bigint, bigint] = [7000n, 2000n, 1000n];

  console.log(`  Calling Splitter.distribute(EURC, [deployer×3], [70/20/10], ${fmtEurc(PROBE_AMOUNT)})…`);
  const distributeData = encodeFunctionData({
    abi: splitterAbi,
    functionName: "distribute",
    args: [ARC_EURC, recipients, bps, PROBE_AMOUNT],
  });

  const distributeTx = await wallet.sendTransaction({
    account,
    to: STOA_SPLITTER,
    data: distributeData,
    value: 0n,
  });
  const receipt = await pc.waitForTransactionReceipt({ hash: distributeTx });
  if (receipt.status !== "success") {
    console.log(`  ❌ Distribute reverted: ${distributeTx}`);
    return;
  }
  console.log(`  ✓ Distribute tx: ${distributeTx}`);
  console.log(`    block=${receipt.blockNumber} logs=${receipt.logs.length}`);
  console.log(`    https://testnet.arcscan.app/tx/${distributeTx}`);

  // ── 4. Final balance check (should be unchanged: round-tripped to self) ────
  const balN = await pc.readContract({
    address: ARC_EURC,
    abi: eurcMetaAbi,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`\n  Deployer EURC: ${fmtEurc(bal)} → ${fmtEurc(balN)}`);
  console.log(`  Net delta: ${fmtEurc(bal - balN)} EURC (should be 0 — all three recipients = deployer)`);

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║         EURC MULTI-CURRENCY SPLIT — VERIFIED                ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("Splitter.distribute() works with EURC end-to-end on Arc Testnet.");
  console.log("For an EURC-denominated /analyze or /confirm fee path, deploy a");
  console.log("second StoaSettler instance with EURC in the constructor (the");
  console.log("existing StoaSettler binds USDC immutably at deployment).\n");
}

main().catch((e) => {
  console.error("\n[probe-eurc] Unhandled error:");
  console.error(e);
  process.exit(1);
});
