/**
 * Stoa-routed payment flow: user signs EIP-3009 `transferWithAuthorization`
 * over USDC on Arc Testnet, operator submits `StoaSettler.settle(...)` with
 * the auth + 70/20/10 split + optional trace pin. One on-chain tx, atomic.
 *
 * Key insight: the user pays NO gas. Only the operator wallet needs Arc
 * Testnet USDC to cover gas (Arc uses USDC as native gas; ~$0.001 per tx).
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseSignature,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { arcTestnet, arcRpc } from "./chains.js";
import type { BotCoreConfig } from "./config.js";

const stoaSettlerAbi = [
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "auth",
        type: "tuple",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
      { name: "recipients", type: "address[]" },
      { name: "bps", type: "uint16[]" },
      { name: "traceHash", type: "bytes32" },
      { name: "ipfsCid", type: "string" },
    ],
    outputs: [],
  },
] as const;

const usdcMetaAbi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

export function publicArc(cfg: BotCoreConfig): PublicClient {
  return createPublicClient({ chain: arcTestnet, transport: http(arcRpc(cfg)) });
}

export function operatorWallet(cfg: BotCoreConfig): WalletClient {
  const account = privateKeyToAccount(cfg.OPERATOR_PRIVATE_KEY as Hex);
  return createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcRpc(cfg)),
  });
}

interface UsdcDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

/**
 * Query the USDC contract for its EIP-712 domain. Arc Testnet's USDC at
 * 0x36...0000 returns name="USDC" version="2" — different from the mainnet
 * "USD Coin" name; we read name()/version() directly to avoid silently
 * producing an invalid signature.
 */
export async function fetchUsdcDomain(
  client: PublicClient,
  usdc: Address,
  chainId: number,
): Promise<UsdcDomain> {
  const [name, version] = await Promise.all([
    client.readContract({
      address: usdc,
      abi: usdcMetaAbi,
      functionName: "name",
    }),
    client.readContract({
      address: usdc,
      abi: usdcMetaAbi,
      functionName: "version",
    }),
  ]);
  return { name, version, chainId, verifyingContract: usdc };
}

export interface Eip3009Auth {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  v: number;
  r: Hex;
  s: Hex;
}

export async function buildSignedAuth(args: {
  userPrivateKey: Hex;
  from: Address;
  to: Address;
  value: bigint;
  usdc: Address;
  domain: UsdcDomain;
}): Promise<Eip3009Auth> {
  const account = privateKeyToAccount(args.userPrivateKey);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = 0n;
  const validBefore = now + 3600n;
  const nonce = `0x${[...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as Hex;

  const signature = await account.signTypedData({
    domain: {
      name: args.domain.name,
      version: args.domain.version,
      chainId: args.domain.chainId,
      verifyingContract: args.usdc,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: args.from,
      to: args.to,
      value: args.value,
      validAfter,
      validBefore,
      nonce,
    },
  });

  const sig = parseSignature(signature);
  const v = sig.v !== undefined ? Number(sig.v) : 27 + Number(sig.yParity);

  return {
    from: args.from,
    to: args.to,
    value: args.value,
    validAfter,
    validBefore,
    nonce,
    v,
    r: sig.r,
    s: sig.s,
  };
}

export interface SplitConfig {
  recipients: [Address, Address, Address];
  bps: [number, number, number];
}

export function splitConfigFromCfg(cfg: BotCoreConfig): SplitConfig {
  return {
    recipients: [
      cfg.STOA_RECIPIENT_OPERATOR as Address,
      cfg.STOA_RECIPIENT_MAINTAINERS as Address,
      cfg.STOA_RECIPIENT_CANTEEN as Address,
    ],
    bps: [7000, 2000, 1000],
  };
}

export interface SettleResult {
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

export async function submitSettle(args: {
  cfg: BotCoreConfig;
  auth: Eip3009Auth;
  split: SplitConfig;
  traceHash: Hex;
  ipfsCid: string;
}): Promise<SettleResult> {
  const { cfg, auth, split, traceHash, ipfsCid } = args;
  const op = operatorWallet(cfg);
  const pc = publicArc(cfg);

  if (!op.account) throw new Error("operator wallet has no account");

  const data = encodeFunctionData({
    abi: stoaSettlerAbi,
    functionName: "settle",
    args: [
      {
        from: auth.from,
        to: auth.to,
        value: auth.value,
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
        v: auth.v,
        r: auth.r,
        s: auth.s,
      },
      split.recipients,
      split.bps,
      traceHash,
      ipfsCid,
    ],
  });

  const txHash = await op.sendTransaction({
    account: op.account,
    chain: arcTestnet,
    to: cfg.STOA_SETTLER as Address,
    data,
    value: 0n,
  });
  const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`StoaSettler.settle reverted: tx ${txHash}`);
  }
  return {
    txHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
  };
}

/**
 * End-to-end "user pays X USDC for command Y":
 *   1. Fetch USDC domain
 *   2. User signs EIP-3009 auth
 *   3. Operator submits settle() with 70/20/10 split + optional trace pin
 *
 * Returns the Arc tx hash. Throws on any step's failure.
 */
export async function payStoaFee(args: {
  cfg: BotCoreConfig;
  userPrivateKey: Hex;
  userAddress: Address;
  amountUsdcMicros: bigint;
  traceHash?: Hex;
  ipfsCid?: string;
}): Promise<Hex> {
  const { cfg, userPrivateKey, userAddress, amountUsdcMicros } = args;
  const traceHash = (args.traceHash ?? (("0x" + "00".repeat(32)) as Hex)) as Hex;
  const ipfsCid = args.ipfsCid ?? "";

  const pc = publicArc(cfg);
  const domain = await fetchUsdcDomain(
    pc,
    cfg.ARC_USDC as Address,
    Number(cfg.ARC_CHAIN_ID),
  );

  const auth = await buildSignedAuth({
    userPrivateKey,
    from: userAddress,
    to: cfg.STOA_SETTLER as Address,
    value: amountUsdcMicros,
    usdc: cfg.ARC_USDC as Address,
    domain,
  });

  const split = splitConfigFromCfg(cfg);
  const result = await submitSettle({ cfg, auth, split, traceHash, ipfsCid });
  return result.txHash;
}
