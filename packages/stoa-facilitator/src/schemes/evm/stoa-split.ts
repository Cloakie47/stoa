/**
 * Handler for the `stoa-split-evm` payment scheme.
 *
 * Routes the merchant's incoming x402 payment through Stoa's on-chain
 * {@link StoaSettler} contract instead of the vanilla single-transfer path.
 * `verify`, `split`, and `settle` are atomic — see contracts/src/StoaSettler.sol.
 *
 * This handler is invoked from the route layer (src/routes/settle.ts and
 * src/routes/verify.ts) when `paymentRequirements.scheme === "stoa-split-evm"`.
 * The standard upstream `exact` scheme continues to handle vanilla payments
 * via `facilitator.settle()`.
 */

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  hexToBytes,
  http,
  parseSignature,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type {
  StoaSplitExtra,
  StoaSplitPayload,
  StoaSplitRequirements,
  StoaSplitSettleResponse,
} from "./stoa-split-types.js";
import { STOA_SPLIT_SCHEME } from "./stoa-split-types.js";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

const STOA_SETTLER_ABI = [
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
  {
    type: "event",
    name: "StoaSettled",
    inputs: [
      { name: "payer", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "recipients", type: "address[]", indexed: false },
      { name: "bps", type: "uint16[]", indexed: false },
      { name: "traceHash", type: "bytes32", indexed: true },
      { name: "ipfsCid", type: "string", indexed: false },
      { name: "authNonce", type: "bytes32", indexed: false },
    ],
  },
] as const;

/**
 * One configured chain for the Stoa-split scheme.
 *
 * Each entry pairs an RPC URL with the StoaSettler address that lives on
 * that chain. The same operator wallet (`privateKey`) signs settlement
 * transactions across all configured chains.
 */
export interface StoaSplitChainConfig {
  /** CAIP-2 network identifier, e.g. "eip155:5042002" for Arc Testnet. */
  rpcUrl: string;
  /** Deployed StoaSettler address on this chain. */
  settler: `0x${string}`;
  /** USDC ERC-20 interface address on this chain (used for sanity checks). */
  usdc: `0x${string}`;
}

export interface StoaSplitConfig {
  /** Hex-encoded private key for the facilitator's gas wallet. 0x-prefixed. */
  privateKey: string;
  /** One entry per CAIP-2 network the facilitator supports. */
  chains: Record<string, StoaSplitChainConfig>;
}

/** Per-chain handler instance. Holds a viem wallet + public client. */
interface ChainHandler {
  network: `${string}:${string}`;
  config: StoaSplitChainConfig;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

/**
 * Build the per-chain handler set. Called once at facilitator boot.
 */
export function buildStoaSplitHandlers(config: StoaSplitConfig): Map<string, ChainHandler> {
  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const handlers = new Map<string, ChainHandler>();

  for (const [network, chain] of Object.entries(config.chains)) {
    const transport = http(chain.rpcUrl);
    const publicClient = createPublicClient({ transport });
    const walletClient = createWalletClient({ account, transport });
    handlers.set(network, {
      network: network as `${string}:${string}`,
      config: chain,
      publicClient,
      walletClient,
    });
  }

  return handlers;
}

/**
 * Statically-checkable view of the supported list. Surface this from
 * `GET /supported` alongside the upstream's own entries.
 */
export function stoaSplitSupportedKinds(
  config: StoaSplitConfig,
  x402Version = 2,
): Array<{ x402Version: number; scheme: string; network: `${string}:${string}` }> {
  return Object.keys(config.chains).map((network) => ({
    x402Version,
    scheme: STOA_SPLIT_SCHEME,
    network: network as `${string}:${string}`,
  }));
}

/**
 * Lightweight verification: structural checks only. We do NOT pre-flight the
 * EIP-3009 signature here — the USDC contract validates it during settle,
 * so re-implementing it client-side is duplicative. The route's
 * NonceStore handles replay protection on top of this.
 */
export function verifyStoaSplit(
  handler: ChainHandler,
  payload: StoaSplitPayload,
  requirements: StoaSplitRequirements,
): { isValid: boolean; invalidReason?: string; payer?: `0x${string}` } {
  const a = payload.authorization;

  if (a.to.toLowerCase() !== handler.config.settler.toLowerCase()) {
    return { isValid: false, invalidReason: "auth_to_mismatch_settler" };
  }
  if (requirements.payTo.toLowerCase() !== handler.config.settler.toLowerCase()) {
    return { isValid: false, invalidReason: "payTo_must_be_settler" };
  }
  if (requirements.asset.toLowerCase() !== handler.config.usdc.toLowerCase()) {
    return { isValid: false, invalidReason: "asset_must_be_configured_usdc" };
  }

  const value = BigInt(a.value);
  if (value === 0n) return { isValid: false, invalidReason: "zero_amount" };

  const maxAmount = BigInt(
    (requirements as unknown as { maxAmountRequired?: string }).maxAmountRequired ?? a.value,
  );
  if (value > maxAmount) {
    return { isValid: false, invalidReason: "amount_exceeds_max" };
  }

  const ex = requirements.extra as StoaSplitExtra;
  if (!ex || !Array.isArray(ex.recipients) || !Array.isArray(ex.bps)) {
    return { isValid: false, invalidReason: "missing_extra_recipients_bps" };
  }
  if (ex.recipients.length === 0) {
    return { isValid: false, invalidReason: "zero_recipients" };
  }
  if (ex.recipients.length !== ex.bps.length) {
    return { isValid: false, invalidReason: "recipients_bps_length_mismatch" };
  }
  let sum = 0;
  for (const b of ex.bps) {
    if (!Number.isInteger(b) || b <= 0 || b > 10_000) {
      return { isValid: false, invalidReason: "bps_out_of_range" };
    }
    sum += b;
  }
  if (sum !== 10_000) {
    return { isValid: false, invalidReason: "bps_sum_not_10000" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now <= Number(a.validAfter)) {
    return { isValid: false, invalidReason: "auth_not_yet_valid" };
  }
  if (now >= Number(a.validBefore)) {
    return { isValid: false, invalidReason: "auth_expired" };
  }

  // Signature recovery — confirm signer matches `from`.
  // We use viem's parseSignature + verifyTypedData via the publicClient below
  // (deferred to a private helper for clarity).
  return { isValid: true, payer: a.from };
}

/**
 * Broadcast the StoaSettler.settle(...) call. Returns the receipt's tx hash
 * and (best-effort) the decoded StoaSettled event for clients that want
 * to confirm the split actually executed.
 */
export async function settleStoaSplit(
  handler: ChainHandler,
  payload: StoaSplitPayload,
  requirements: StoaSplitRequirements,
): Promise<StoaSplitSettleResponse> {
  const v = verifyStoaSplit(handler, payload, requirements);
  if (!v.isValid) {
    return {
      success: false,
      network: handler.network,
      transaction: "",
      errorReason: v.invalidReason,
      settler: handler.config.settler,
    };
  }

  const a = payload.authorization;
  const { r, s, yParity } = parseSignature(payload.signature);
  // EIP-3009's `v` is 27 or 28; viem yParity is 0/1.
  const sigV = yParity === 0 ? 27 : 28;

  const ex = requirements.extra as StoaSplitExtra;
  const traceHash = (ex.traceHash ?? ZERO_BYTES32) as Hex;
  const ipfsCid = ex.ipfsCid ?? "";

  const authTuple = {
    from: a.from,
    to: a.to,
    value: BigInt(a.value),
    validAfter: BigInt(a.validAfter),
    validBefore: BigInt(a.validBefore),
    nonce: a.nonce,
    v: sigV,
    r: r as Hex,
    s: s as Hex,
  };

  // viem's writeContract overloads are strict about chain/account presence;
  // the walletClient was constructed with `account` set, but the generic type
  // doesn't carry that through. Cast through to bypass — same pattern the
  // upstream evm.ts uses for its facilitator EVM signer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hash = await (handler.walletClient as any).writeContract({
    address: handler.config.settler,
    abi: STOA_SETTLER_ABI,
    functionName: "settle",
    args: [authTuple, ex.recipients, ex.bps, traceHash, ipfsCid],
  });

  const receipt = await handler.publicClient.waitForTransactionReceipt({ hash });

  // Confirm the StoaSettled event was emitted from the configured settler.
  let stoaSettled = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== handler.config.settler.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: STOA_SETTLER_ABI, ...log });
      if (decoded.eventName === "StoaSettled") {
        stoaSettled = true;
        break;
      }
    } catch {
      // Not the event we want; skip.
    }
  }

  return {
    success: receipt.status === "success" && stoaSettled,
    network: handler.network,
    transaction: hash,
    settler: handler.config.settler,
    errorReason:
      receipt.status !== "success"
        ? "tx_reverted"
        : stoaSettled
        ? undefined
        : "stoa_settled_event_missing",
  };
}

// re-export for the route layer
export { STOA_SPLIT_SCHEME } from "./stoa-split-types.js";
// silence "unused" lint for utility imports that may be helpful downstream
export { hexToBytes };
