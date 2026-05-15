/**
 * One-time pUSD setup for the deployer wallet on Polygon mainnet.
 *
 * Polymarket V2 trades against pUSD, a 1:1-backed ERC-20 wrapper of USDC.e.
 * Native USDC is NOT accepted. The full path from USDC.e → tradeable is:
 *
 *   1. usdce.approve(Onramp, MaxUint256)               ← allow Onramp to pull USDC.e
 *   2. Onramp.wrap(USDC.e, deployer, balance)          ← USDC.e → pUSD, minted to deployer
 *   3. pUSD.approve(standardExchangeV2, MaxUint256)    ← let standard exchange spend pUSD on fills
 *   4. pUSD.approve(negRiskExchangeV2, MaxUint256)     ← same, for NegRisk markets
 *
 * Each tx is idempotent — re-running checks current allowance/balance and
 * skips any step that's already done. Total cost: ~$0.004 in POL on Polygon.
 *
 * Run:
 *   pnpm --filter @stoa/polymarket-client setup:pusd
 *
 * Required env (in repo-root .env):
 *   DEPLOYER_PRIVATE_KEY   — 0x-prefixed hex private key
 *   POLYGON_RPC            — optional; defaults to viem's public polygon transport
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  http,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

// ── Polygon mainnet addresses (verified on-chain 2026-05-15) ────────────────

const USDCE: Address = "0x2791Bca1f2de4661ED88A30C99a7a9449Aa84174";
const PUSD: Address = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const ONRAMP: Address = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
const EXCHANGE_V2: Address = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE_V2: Address = "0xe2222d279d744050d28e00520010520000310F59";

// ── ABIs ────────────────────────────────────────────────────────────────────

const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const onrampAbi = [
  {
    type: "function",
    name: "wrap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_asset", type: "address" },
      { name: "_to", type: "address" },
      { name: "_amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// ── Boot: load .env from repo root ──────────────────────────────────────────

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");
loadDotenv(resolve(repoRoot, ".env"));

function loadDotenv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.warn(`[setup-pusd] No .env at ${path}; relying on shell env.`);
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (key && val && !process.env[key]) {
      process.env[key] = val;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmt6(amount: bigint): string {
  // 6-decimal token (USDC.e / pUSD) → human string
  const whole = amount / 1_000_000n;
  const frac = amount % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

function shortMax(x: bigint): string {
  return x === maxUint256 ? "MaxUint256" : x.toString();
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  if (!pk) {
    console.error("[setup-pusd] FATAL: DEPLOYER_PRIVATE_KEY missing from .env");
    process.exit(1);
  }
  const account = privateKeyToAccount(pk);
  const rpc = process.env.POLYGON_RPC;
  const transport = http(rpc);

  const publicClient = createPublicClient({ chain: polygon, transport });
  const walletClient = createWalletClient({ account, chain: polygon, transport });

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║       Stoa × Polymarket pUSD setup — Polygon mainnet         ║");
  console.log("║       (real transactions, real gas — but tiny: ~$0.004)      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`Deployer:       ${account.address}`);
  console.log(`RPC:            ${rpc ?? "viem default public polygon transport"}`);
  console.log(`USDC.e:         ${USDCE}`);
  console.log(`pUSD:           ${PUSD}`);
  console.log(`Onramp:         ${ONRAMP}`);
  console.log(`Std exchange:   ${EXCHANGE_V2}`);
  console.log(`NegRisk exch:   ${NEG_RISK_EXCHANGE_V2}\n`);

  // ── Pre-state ─────────────────────────────────────────────────────────────
  const [
    polBalance,
    usdceBalance,
    pusdBalance,
    usdceAllowanceOnramp,
    pusdAllowanceStd,
    pusdAllowanceNegRisk,
  ] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: USDCE, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: PUSD, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: USDCE, abi: erc20Abi, functionName: "allowance", args: [account.address, ONRAMP] }),
    publicClient.readContract({ address: PUSD, abi: erc20Abi, functionName: "allowance", args: [account.address, EXCHANGE_V2] }),
    publicClient.readContract({ address: PUSD, abi: erc20Abi, functionName: "allowance", args: [account.address, NEG_RISK_EXCHANGE_V2] }),
  ]);

  console.log("── Pre-state ─────────────────────────────────────────────────");
  console.log(`POL balance:                ${(Number(polBalance) / 1e18).toFixed(4)} POL`);
  console.log(`USDC.e balance:             ${fmt6(usdceBalance)} USDC.e`);
  console.log(`pUSD balance:               ${fmt6(pusdBalance)} pUSD`);
  console.log(`USDC.e → Onramp allowance:  ${shortMax(usdceAllowanceOnramp)}`);
  console.log(`pUSD → std exch allowance:  ${shortMax(pusdAllowanceStd)}`);
  console.log(`pUSD → negRisk allowance:   ${shortMax(pusdAllowanceNegRisk)}\n`);

  const txHashes: Record<string, Hex> = {};

  // Threshold above which we consider an allowance "already sufficient"
  // (any partial allowance < this triggers a fresh MaxUint256 set).
  const SUFFICIENT = maxUint256 / 2n;

  // ── Step 1: USDC.e.approve(Onramp, MaxUint256) ────────────────────────────
  if (usdceAllowanceOnramp < SUFFICIENT && usdceBalance > 0n) {
    console.log("[step 1/4] Approving USDC.e for Onramp...");
    const hash = await walletClient.writeContract({
      address: USDCE,
      abi: erc20Abi,
      functionName: "approve",
      args: [ONRAMP, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    txHashes.approve_usdce_onramp = hash;
    console.log(`           ✓ tx ${hash}\n`);
  } else {
    console.log(`[step 1/4] Skipped — USDC.e → Onramp allowance already sufficient.\n`);
  }

  // ── Step 2: Onramp.wrap(USDC.e, deployer, full balance) ───────────────────
  // Re-read balance in case step 1 changed nothing but we want current state.
  const usdceToWrap = await publicClient.readContract({
    address: USDCE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (usdceToWrap > 0n) {
    console.log(`[step 2/4] Wrapping ${fmt6(usdceToWrap)} USDC.e → pUSD via Onramp...`);
    const hash = await walletClient.writeContract({
      address: ONRAMP,
      abi: onrampAbi,
      functionName: "wrap",
      args: [USDCE, account.address, usdceToWrap],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    txHashes.wrap_usdce_to_pusd = hash;
    console.log(`           ✓ tx ${hash}\n`);
  } else {
    console.log(`[step 2/4] Skipped — no USDC.e to wrap.\n`);
  }

  // ── Step 3: pUSD.approve(standardExchangeV2, MaxUint256) ──────────────────
  if (pusdAllowanceStd < SUFFICIENT) {
    console.log("[step 3/4] Approving pUSD for standard CTF Exchange V2...");
    const hash = await walletClient.writeContract({
      address: PUSD,
      abi: erc20Abi,
      functionName: "approve",
      args: [EXCHANGE_V2, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    txHashes.approve_pusd_std = hash;
    console.log(`           ✓ tx ${hash}\n`);
  } else {
    console.log(`[step 3/4] Skipped — pUSD → std exch allowance already sufficient.\n`);
  }

  // ── Step 4: pUSD.approve(negRiskExchangeV2, MaxUint256) ───────────────────
  if (pusdAllowanceNegRisk < SUFFICIENT) {
    console.log("[step 4/4] Approving pUSD for NegRisk CTF Exchange V2...");
    const hash = await walletClient.writeContract({
      address: PUSD,
      abi: erc20Abi,
      functionName: "approve",
      args: [NEG_RISK_EXCHANGE_V2, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    txHashes.approve_pusd_negrisk = hash;
    console.log(`           ✓ tx ${hash}\n`);
  } else {
    console.log(`[step 4/4] Skipped — pUSD → negRisk allowance already sufficient.\n`);
  }

  // ── Post-state ────────────────────────────────────────────────────────────
  const [
    polAfter,
    usdceAfter,
    pusdAfter,
    usdceAllowAfter,
    pusdAllowStdAfter,
    pusdAllowNegRiskAfter,
  ] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: USDCE, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: PUSD, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: USDCE, abi: erc20Abi, functionName: "allowance", args: [account.address, ONRAMP] }),
    publicClient.readContract({ address: PUSD, abi: erc20Abi, functionName: "allowance", args: [account.address, EXCHANGE_V2] }),
    publicClient.readContract({ address: PUSD, abi: erc20Abi, functionName: "allowance", args: [account.address, NEG_RISK_EXCHANGE_V2] }),
  ]);

  console.log("── Post-state ────────────────────────────────────────────────");
  console.log(`POL balance:                ${(Number(polAfter) / 1e18).toFixed(4)} POL  (Δ ${(Number(polAfter - polBalance) / 1e18).toFixed(6)})`);
  console.log(`USDC.e balance:             ${fmt6(usdceAfter)} USDC.e`);
  console.log(`pUSD balance:               ${fmt6(pusdAfter)} pUSD`);
  console.log(`USDC.e → Onramp allowance:  ${shortMax(usdceAllowAfter)}`);
  console.log(`pUSD → std exch allowance:  ${shortMax(pusdAllowStdAfter)}`);
  console.log(`pUSD → negRisk allowance:   ${shortMax(pusdAllowNegRiskAfter)}\n`);

  console.log("── Transaction hashes ────────────────────────────────────────");
  if (Object.keys(txHashes).length === 0) {
    console.log("  (none — all steps were already in target state)");
  } else {
    for (const [k, v] of Object.entries(txHashes)) {
      console.log(`  ${k.padEnd(24)} ${v}`);
      console.log(`  ${"".padEnd(24)} https://polygonscan.com/tx/${v}`);
    }
  }
  console.log("\n[setup-pusd] Done. Deployer is now ready to submit orders against V2.\n");
}

main().catch((err) => {
  console.error("\n[setup-pusd] Unhandled error:", err);
  process.exit(1);
});
