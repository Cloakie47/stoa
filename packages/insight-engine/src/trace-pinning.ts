/**
 * Trace pinning — three steps:
 *
 *   1. Canonicalize the FullTrace JSON (sorted keys, blanked-out hash/cid/tx
 *      fields so the hash is over content alone) and keccak256 it.
 *   2. Upload the JSON to IPFS via Pinata (preferred — just needs a JWT) OR
 *      Storacha/web3.storage (needs KEY + PROOF). Gracefully skips if neither
 *      is configured.
 *   3. Call TracePin.pinTrace(traceHash, ipfsCid) on Arc Testnet via viem.
 *
 * The on-chain hash is the load-bearing artifact for an audit trail — even
 * if the IPFS upload fails, the hash on Arc proves the trace existed at this
 * block. The IPFS CID lets verifiers retrieve the full JSON.
 *
 * Env vars consumed:
 *   - DEPLOYER_PRIVATE_KEY (required) — the operator wallet that signs TracePin tx
 *   - ARC_TESTNET_RPC (required)
 *   - TRACEPIN_ADDRESS (required)
 *   - PINATA_JWT (optional, preferred for IPFS)
 *   - STORACHA_KEY + STORACHA_PROOF (optional, fallback for IPFS)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type Hex,
  type WalletClient,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { FullTrace } from "./types.js";

const TRACEPIN_ABI = [
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
  {
    type: "event",
    name: "TracePinned",
    inputs: [
      { name: "pinner", type: "address", indexed: true },
      { name: "traceHash", type: "bytes32", indexed: true },
      { name: "uri", type: "string", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
] as const;

/**
 * Stable, deterministic JSON serialization. Sorts object keys recursively
 * so the hash is invariant to property ordering. Removes the fields that
 * are themselves filled in BY pinning (hash/cid/tx) so the hash is over
 * pre-pinning content.
 */
export function canonicalizeTraceForHashing(trace: FullTrace): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { trace_hash, ipfs_cid, pinned_tx, ...rest } = trace;
  return stableStringify(rest);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function hashTrace(trace: FullTrace): Hex {
  return keccak256(toBytes(canonicalizeTraceForHashing(trace)));
}

/**
 * Upload the trace JSON to IPFS. Returns the CID, or null if no IPFS
 * backend is configured (the orchestrator will note this in the FullTrace).
 */
export async function uploadToIpfs(trace: FullTrace): Promise<string | null> {
  const json = stableStringify(trace);

  if (process.env.PINATA_JWT) {
    return uploadToPinata(json, trace);
  }
  if (process.env.STORACHA_KEY && process.env.STORACHA_PROOF) {
    return uploadToStoracha(json);
  }
  return null;
}

async function uploadToPinata(json: string, trace: FullTrace): Promise<string> {
  const jwt = process.env.PINATA_JWT!;
  // Pinata's pinJSONToIPFS — sends JSON body, returns CID.
  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      pinataMetadata: {
        name: `stoa-insight-trace-${trace.market_url
          .replace(/[^a-zA-Z0-9]/g, "_")
          .slice(0, 80)}-${Date.now()}`,
        keyvalues: {
          schema: trace.schema_version,
          market_url: trace.market_url,
          final_signal: trace.final_signal,
        },
      },
      pinataContent: JSON.parse(json),
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Pinata pinJSONToIPFS returned ${res.status}: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { IpfsHash: string };
  return body.IpfsHash;
}

/**
 * Storacha (web3.storage) upload path. Requires the heavy CLI setup
 * (storacha CLI → space → delegation → KEY + PROOF env vars). Loads
 * @storacha/client dynamically so the dep isn't required when Pinata is used.
 *
 * If you hit "Cannot find module '@storacha/client'", install it:
 *   pnpm add @storacha/client
 */
async function uploadToStoracha(json: string): Promise<string> {
  // Dynamic import — the package isn't a declared dep; we only require it
  // at runtime when this code path is actually taken.
  type StorachaClientModule = {
    create(opts: {
      principal: unknown;
      store: unknown;
    }): Promise<{
      addSpace: (proof: unknown) => Promise<{ did: () => string }>;
      setCurrentSpace: (did: string) => Promise<void>;
      uploadFile: (file: File) => Promise<{ toString: () => string }>;
    }>;
  };
  type StorachaSignerModule = { parse(s: string): unknown };
  type StorachaProofModule = { parse(s: string): Promise<unknown> };
  type StorachaStoreModule = { StoreMemory: new () => unknown };

  const [Client, Signer, Proof, Store] = (await Promise.all([
    import("@storacha/client" as string).catch(() => {
      throw new Error(
        "@storacha/client is not installed. Run `pnpm add @storacha/client` in packages/insight-engine, or use PINATA_JWT instead.",
      );
    }),
    import("@storacha/client/principal/ed25519" as string),
    import("@storacha/client/proof" as string),
    import("@storacha/client/stores/memory" as string),
  ])) as unknown as [
    StorachaClientModule,
    StorachaSignerModule,
    StorachaProofModule,
    StorachaStoreModule,
  ];

  const principal = Signer.parse(process.env.STORACHA_KEY!);
  const store = new Store.StoreMemory();
  const client = await Client.create({ principal, store });
  const proof = await Proof.parse(process.env.STORACHA_PROOF!);
  const space = await client.addSpace(proof);
  await client.setCurrentSpace(space.did());
  const file = new File([json], "stoa-insight-trace.json", {
    type: "application/json",
  });
  const cid = await client.uploadFile(file);
  return cid.toString();
}

export interface PinTraceParams {
  trace: FullTrace;
  /** Override the default RPC. */
  rpcUrl?: string;
  /** Override the contract address. */
  tracePinAddress?: `0x${string}`;
  /** Override the signer private key. */
  privateKey?: `0x${string}`;
}

export interface PinTraceResult {
  trace_hash: Hex;
  ipfs_cid: string | null;
  tx_hash: Hex;
  block_number: bigint;
}

/**
 * Full pin pipeline: hash → upload to IPFS → call TracePin.pinTrace.
 *
 * Returns the on-chain tx hash + IPFS CID (or null if no IPFS backend).
 * The caller is expected to write these fields back into the FullTrace.
 */
export async function pinTraceOnChain(
  params: PinTraceParams,
): Promise<PinTraceResult> {
  const rpcUrl = params.rpcUrl ?? process.env.ARC_TESTNET_RPC;
  const address =
    params.tracePinAddress ?? (process.env.TRACEPIN_ADDRESS as `0x${string}`);
  const pk = params.privateKey ?? (process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`);

  if (!rpcUrl) {
    throw new Error("ARC_TESTNET_RPC not set; cannot pin trace on-chain.");
  }
  if (!address) {
    throw new Error("TRACEPIN_ADDRESS not set; cannot pin trace on-chain.");
  }
  if (!pk) {
    throw new Error(
      "DEPLOYER_PRIVATE_KEY not set; cannot pin trace on-chain.",
    );
  }

  // 1. Hash (over content; IPFS-CID slot blanked out)
  const traceHash = hashTrace(params.trace);

  // 2. Upload to IPFS (may be null)
  let ipfsCid: string | null = null;
  try {
    ipfsCid = await uploadToIpfs(params.trace);
  } catch (e) {
    // Don't let an IPFS hiccup block the on-chain pin — log it as part of
    // the trace's audit story and continue with cid = "".
    // Caller can still find the JSON in their local logs.
    console.warn(
      `[trace-pinning] IPFS upload failed; continuing with empty CID. Error: ${(e as Error).message}`,
    );
  }

  // 3. On-chain pinTrace
  const account = privateKeyToAccount(pk);
  const transport = http(rpcUrl);
  const publicClient: PublicClient = createPublicClient({ transport });
  const walletClient: WalletClient = createWalletClient({
    account,
    transport,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txHash = (await (walletClient as any).writeContract({
    address,
    abi: TRACEPIN_ABI,
    functionName: "pinTrace",
    args: [traceHash, ipfsCid ?? ""],
  })) as Hex;

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`TracePin.pinTrace tx reverted: ${txHash}`);
  }

  return {
    trace_hash: traceHash,
    ipfs_cid: ipfsCid,
    tx_hash: txHash,
    block_number: receipt.blockNumber,
  };
}
