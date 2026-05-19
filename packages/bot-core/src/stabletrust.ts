/**
 * Bot-core helpers for the Fairblock StableTrust confidential-payment flow.
 *
 * The Worker (apps/bot) calls these via /shield, /unshield, /shielded-balance;
 * the analyzer (apps/analyzer) calls them inside chargeAnalyzeFee /
 * chargeConfirmFee in pipelines.ts. Everything is feature-flagged behind
 * cfg.STOA_USE_STABLETRUST so a deployment with the flag off literally
 * never instantiates the client.
 *
 * ── Architectural note: SHIELDED-MODE DECOUPLING ────────────────────────
 *
 * The whole point of confidential payments is that the on-chain payment
 * tx must NOT be attributable to a specific analysis. So in shielded mode
 * we DO NOT bundle the TracePin event with the user's payment.
 *
 * Instead the operator's wallet emits TracePin.pinTrace(...) as a SEPARATE
 * Arc tx. That tx is signed by the operator key, not the user — there's
 * no observable link between the encrypted user→operator transfer and
 * the trace pin.
 *
 * The 70/20/10 atomic split is skipped entirely in V1 shielded mode:
 * the operator's StableTrust account accumulates the fees and the split
 * is performed manually post-flow when funds accumulate. This is a V1
 * trade-off; V2 will batch the split via a separate operator tx (e.g.
 * nightly aggregate or every N analyses).
 */
import {
  StableTrustClient,
  type BalanceResponse,
  type TxReceipt,
} from "@stoa/stabletrust-client";
import {
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { arcTestnet, arcRpc } from "./chains.js";
import type { BotCoreConfig } from "./config.js";
import { publicArc } from "./stoa.js";

const tracePinAbi = [
  {
    type: "function",
    name: "pinTrace",
    stateMutability: "nonpayable",
    inputs: [
      { name: "traceHash", type: "bytes32" },
      { name: "uri", type: "string" },
    ],
    outputs: [],
  },
] as const;

// Cached client keyed by base URL — a single isolate / process reuses the
// same instance and thus the same circuit-breaker state across requests.
let cachedClient: { url: string; client: StableTrustClient } | null = null;

export function getStableTrustClient(cfg: BotCoreConfig): StableTrustClient {
  const url = cfg.FAIRBLOCK_API_URL;
  if (cachedClient && cachedClient.url === url) return cachedClient.client;
  cachedClient = { url, client: new StableTrustClient({ baseUrl: url }) };
  return cachedClient.client;
}

/**
 * Address of the operator's confidential-receipt account. Returns the
 * STOA_OPERATOR_STABLETRUST_PRIVATE_KEY-derived address when that secret
 * is set, otherwise falls back to OPERATOR_PRIVATE_KEY (V1 default —
 * same key receives both public and shielded fees).
 */
export function operatorShieldedRecipient(cfg: BotCoreConfig): Address {
  const key = (cfg.STOA_OPERATOR_STABLETRUST_PRIVATE_KEY ||
    cfg.OPERATOR_PRIVATE_KEY) as Hex;
  return privateKeyToAccount(key).address;
}

/**
 * Operator-signed TracePin emission. In shielded mode this is the only
 * on-chain artifact linking the analysis to Arc; the user's confidential
 * transfer to the operator is independently observable but NOT
 * attributable to this trace (different signer, different tx, can sit
 * in a different block, can be interleaved with unrelated activity).
 *
 * The operator pays ~$0.001 of gas. Returns the Arc tx hash. Throws
 * if the tx reverts.
 */
export async function pinTraceFromOperator(args: {
  cfg: BotCoreConfig;
  traceHash: Hex;
  ipfsCid: string;
}): Promise<Hex> {
  const { cfg, traceHash, ipfsCid } = args;
  const pc = publicArc(cfg);
  const account = privateKeyToAccount(cfg.OPERATOR_PRIVATE_KEY as Hex);
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcRpc(cfg)),
  });
  const data = encodeFunctionData({
    abi: tracePinAbi,
    functionName: "pinTrace",
    args: [traceHash, ipfsCid],
  });
  const txHash = await wallet.sendTransaction({
    account,
    chain: arcTestnet,
    to: cfg.STOA_TRACEPIN as Address,
    data,
    value: 0n,
  });
  const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`TracePin.pinTrace reverted: tx ${txHash}`);
  }
  return txHash;
}

/** Numeric chain ID for StableTrust calls — pulled from BotCoreConfig
 *  so the same wrapper works regardless of whether the operator runs
 *  Stoa on Arc Testnet (5042002) or any future supported chain. */
function chainIdOf(cfg: BotCoreConfig): number {
  return Number(cfg.ARC_CHAIN_ID);
}

/** Public → shielded balance (user-side /shield command). */
export async function shieldDeposit(args: {
  cfg: BotCoreConfig;
  userPrivateKey: Hex;
  amountMicros: bigint;
}): Promise<TxReceipt> {
  const client = getStableTrustClient(args.cfg);
  return client.depositToShield({
    privateKey: args.userPrivateKey,
    tokenAddress: args.cfg.STABLETRUST_ARC_USDC_ADDRESS,
    amount: args.amountMicros.toString(),
    chainId: chainIdOf(args.cfg),
    waitForFinalization: true,
  });
}

/** Read the caller's shielded balance (no on-chain side effects). */
export async function shieldedBalanceOf(args: {
  cfg: BotCoreConfig;
  userPrivateKey: Hex;
}): Promise<BalanceResponse> {
  const client = getStableTrustClient(args.cfg);
  return client.getShieldedBalance({
    privateKey: args.userPrivateKey,
    tokenAddress: args.cfg.STABLETRUST_ARC_USDC_ADDRESS,
    chainId: chainIdOf(args.cfg),
  });
}

/** Shielded → public withdraw (user-side /unshield command). */
export async function shieldWithdraw(args: {
  cfg: BotCoreConfig;
  userPrivateKey: Hex;
  amountMicros: bigint;
}): Promise<TxReceipt> {
  const client = getStableTrustClient(args.cfg);
  return client.withdrawToPublic({
    privateKey: args.userPrivateKey,
    tokenAddress: args.cfg.STABLETRUST_ARC_USDC_ADDRESS,
    amount: args.amountMicros.toString(),
    chainId: chainIdOf(args.cfg),
    waitForFinalization: true,
  });
}

/** User → operator confidential transfer for /analyze + /confirm fees. */
export async function confidentialFeeTransfer(args: {
  cfg: BotCoreConfig;
  userPrivateKey: Hex;
  amountMicros: bigint;
}): Promise<TxReceipt> {
  const client = getStableTrustClient(args.cfg);
  return client.confidentialTransfer({
    privateKey: args.userPrivateKey,
    recipientAddress: operatorShieldedRecipient(args.cfg),
    tokenAddress: args.cfg.STABLETRUST_ARC_USDC_ADDRESS,
    amount: args.amountMicros.toString(),
    chainId: chainIdOf(args.cfg),
    useOffchainVerify: false,
    waitForFinalization: true,
  });
}
