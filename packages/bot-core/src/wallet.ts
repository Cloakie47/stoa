/**
 * Wallet management for bot users. One viem EOA per Telegram user,
 * encrypted at rest in the host database (D1 in the Worker, proxied over
 * HTTP from the analyzer), decrypted on demand to sign EIP-3009 auths or
 * to issue real USDC transfers on Base.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { base, baseRpc, arcTestnet, arcRpc } from "./chains.js";
import type { BotCoreConfig } from "./config.js";
import { decryptPrivateKey, encryptPrivateKey } from "./crypto.js";
import type { DbClient } from "./db-client.js";

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export interface UserWallet {
  address: Address;
  privateKey: Hex; // decrypted on demand; never persist outside DB
}

/**
 * Get or create a viem EOA for a Telegram user. Returns the user's wallet
 * with the decrypted private key ready to sign.
 *
 * Generation runs once per user. Subsequent calls decrypt from DB.
 */
export async function getOrCreateUserWallet(
  db: DbClient,
  cfg: BotCoreConfig,
  telegramUserId: number,
): Promise<UserWallet> {
  const existing = await db.getWallet(telegramUserId);
  if (existing) {
    const pk = await decryptPrivateKey(
      existing.pk_ciphertext_b64,
      cfg.WALLET_ENCRYPTION_KEY,
    );
    return { address: existing.address as Address, privateKey: pk };
  }
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const ciphertext = await encryptPrivateKey(pk, cfg.WALLET_ENCRYPTION_KEY);
  await db.insertWallet(telegramUserId, account.address, ciphertext);
  return { address: account.address, privateKey: pk };
}

/**
 * Variant that does NOT create on miss — returns null. Use this when the
 * caller wants to detect "user hasn't /started yet" rather than auto-provision.
 */
export async function loadUserWallet(
  db: DbClient,
  cfg: BotCoreConfig,
  telegramUserId: number,
): Promise<UserWallet | null> {
  const existing = await db.getWallet(telegramUserId);
  if (!existing) return null;
  const pk = await decryptPrivateKey(
    existing.pk_ciphertext_b64,
    cfg.WALLET_ENCRYPTION_KEY,
  );
  return { address: existing.address as Address, privateKey: pk };
}

export async function readUsdcBalanceBase(
  cfg: BotCoreConfig,
  address: Address,
): Promise<bigint> {
  const pc = createPublicClient({ chain: base, transport: http(baseRpc(cfg)) });
  return (await pc.readContract({
    address: cfg.BASE_USDC as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
}

export async function readUsdcBalanceArc(
  cfg: BotCoreConfig,
  address: Address,
): Promise<bigint> {
  const pc = createPublicClient({
    chain: arcTestnet,
    transport: http(arcRpc(cfg)),
  });
  return (await pc.readContract({
    address: cfg.ARC_USDC as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
}

/**
 * Transfer USDC from the user's bot-managed Base wallet to `to`. The user's
 * wallet pays gas (Base mainnet — ETH gas; documented as a v0 limitation).
 */
export async function withdrawUsdcOnBase(args: {
  cfg: BotCoreConfig;
  userPrivateKey: Hex;
  to: Address;
  amountMicros: bigint;
}): Promise<Hex> {
  const { cfg, userPrivateKey, to, amountMicros } = args;
  const account = privateKeyToAccount(userPrivateKey);
  const wallet = createWalletClient({
    account,
    chain: base,
    transport: http(baseRpc(cfg)),
  });
  const pc = createPublicClient({ chain: base, transport: http(baseRpc(cfg)) });
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amountMicros],
  });
  const txHash = await wallet.sendTransaction({
    account,
    chain: base,
    to: cfg.BASE_USDC as Address,
    data,
    value: 0n,
  });
  const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`USDC transfer reverted on Base: tx ${txHash}`);
  }
  return txHash;
}
