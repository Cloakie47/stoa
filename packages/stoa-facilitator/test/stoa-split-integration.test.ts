/**
 * End-to-end integration test for the stoa-split-evm scheme on Arc Testnet.
 *
 * This test spins up the Hono facilitator with our deployed StoaSettler,
 * signs an EIP-3009 `transferWithAuthorization` over Arc's native USDC
 * (via its ERC-20 interface at 0x3600...000), POSTs `/settle`, waits for the
 * on-chain tx, and asserts that:
 *   1. The Hono response reports `success: true`.
 *   2. The receipt contains a Splitter.Distributed event with the exact
 *      recipients we declared in paymentRequirements.extra.
 *
 * Requires DEPLOYER_PRIVATE_KEY (the funded Arc Testnet wallet used to deploy
 * Phase-1 contracts). Skips automatically when that env var is missing so CI
 * runs without a funded key still pass.
 *
 * Each run consumes ~0.5 USDC of testnet money for gas + the value transferred.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  decodeEventLog,
  http,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { x402Facilitator } from "../src/index.js";
import type { StoaSplitPayload, StoaSplitRequirements } from "../src/schemes/evm/stoa-split-types.js";

const repoEnv = (() => {
  try {
    const raw = readFileSync(resolve(__dirname, "../../../.env"), "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && m[2]) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {} as Record<string, string>;
  }
})();

const PRIVATE_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? repoEnv.DEPLOYER_PRIVATE_KEY) as
  | `0x${string}`
  | undefined;
const RPC_URL =
  process.env.ARC_TESTNET_RPC ?? repoEnv.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.network";
const SETTLER = (process.env.STOA_SETTLER_ADDRESS ??
  "0x05a98A1dCa17917B6e8B19306c1653fA9FC5d689") as `0x${string}`;
const SPLITTER = (process.env.SPLITTER_ADDRESS ??
  repoEnv.SPLITTER_ADDRESS ??
  "0x114942B5FeebFDf9F1FA2F161eA9C2A1754C407F") as `0x${string}`;
const USDC = (process.env.USDC_ADDRESS ??
  repoEnv.USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000") as `0x${string}`;
const NETWORK = `eip155:5042002` as const;

const ERC20_VIEW_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const SPLITTER_EVENT_ABI = [
  {
    type: "event",
    name: "Distributed",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "totalAmount", type: "uint256", indexed: false },
      { name: "recipients", type: "address[]", indexed: false },
      { name: "basisPoints", type: "uint256[]", indexed: false },
    ],
  },
] as const;

const skip = !PRIVATE_KEY;

describe.skipIf(skip)("stoa-split-evm integration (Arc Testnet)", () => {
  it(
    "POST /settle dispatches and triggers Splitter.Distributed",
    async () => {
      const account = privateKeyToAccount(PRIVATE_KEY!);
      const publicClient: PublicClient = createPublicClient({
        transport: http(RPC_URL),
      });

      // Read USDC's EIP-712 domain pieces from the contract so the signature
      // matches whatever Arc Testnet's specific USDC build uses.
      const [name, version] = await Promise.all([
        publicClient.readContract({ address: USDC, abi: ERC20_VIEW_ABI, functionName: "name" }) as Promise<string>,
        publicClient
          .readContract({ address: USDC, abi: ERC20_VIEW_ABI, functionName: "version" })
          .catch(() => "2") as Promise<string>,
      ]);
      const chainId = await publicClient.getChainId();

      // Balance sanity — skip if we can't afford even a tiny test transfer.
      const balance = (await publicClient.readContract({
        address: USDC,
        abi: ERC20_VIEW_ABI,
        functionName: "balanceOf",
        args: [account.address],
      })) as bigint;
      if (balance < 500_000n) {
        // Less than 0.5 USDC at 6 decimals — skip rather than fail.
        console.warn(
          `[stoa-split-integration] payer ${account.address} has balance ${balance} (<0.5 USDC). Skipping.`,
        );
        return;
      }

      const value = 100_000n; // 0.1 USDC (6 decimals)
      const nonceBytes = new Uint8Array(32);
      crypto.getRandomValues(nonceBytes);
      const nonce =
        ("0x" + Buffer.from(nonceBytes).toString("hex")) as Hex;

      const now = Math.floor(Date.now() / 1000);

      const signature = await account.signTypedData({
        domain: {
          name,
          version,
          chainId,
          verifyingContract: USDC,
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
          from: account.address,
          to: SETTLER,
          value,
          validAfter: 0n,
          validBefore: BigInt(now + 600),
          nonce,
        },
      });

      // Recipients — 60/20/15/5 Stoa-style split.
      const recipients: `0x${string}`[] = [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
        "0x4444444444444444444444444444444444444444",
      ];
      const bps = [6_000, 2_000, 1_500, 500];

      const payload: StoaSplitPayload = {
        authorization: {
          from: account.address,
          to: SETTLER,
          value: value.toString(),
          validAfter: "0",
          validBefore: String(now + 600),
          nonce,
        },
        signature,
      };

      const requirements: StoaSplitRequirements = {
        scheme: "stoa-split-evm",
        network: NETWORK,
        asset: USDC,
        payTo: SETTLER,
        maxAmountRequired: value.toString(),
        extra: {
          recipients,
          bps,
        },
      } as unknown as StoaSplitRequirements;

      // Spin up the facilitator Hono app.
      const facilitator = await x402Facilitator({
        stoaSplit: {
          privateKey: PRIVATE_KEY!,
          chains: {
            [NETWORK]: { rpcUrl: RPC_URL, settler: SETTLER, usdc: USDC },
          },
        },
      });
      const app = new Hono();
      app.route("/facilitator", facilitator);

      // Post to /settle.
      const res = await app.request("/facilitator/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentPayload: {
            x402Version: 2,
            accepted: requirements,
            payload,
          },
          paymentRequirements: requirements,
        }),
      });
      const body = (await res.json()) as {
        success: boolean;
        transaction: `0x${string}`;
        errorReason?: string;
      };
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(body.success, JSON.stringify(body)).toBe(true);
      expect(body.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);

      // Read the receipt and assert Splitter.Distributed fired with our recipients.
      const receipt = await publicClient.waitForTransactionReceipt({ hash: body.transaction });
      expect(receipt.status).toBe("success");

      const distributedLogs = receipt.logs.filter(
        (l) => l.address.toLowerCase() === SPLITTER.toLowerCase(),
      );
      expect(distributedLogs.length).toBeGreaterThan(0);

      const decoded = decodeEventLog({
        abi: SPLITTER_EVENT_ABI,
        ...distributedLogs[0],
      });
      expect(decoded.eventName).toBe("Distributed");
      const args = decoded.args as {
        recipients: readonly `0x${string}`[];
        basisPoints: readonly bigint[];
        totalAmount: bigint;
      };
      expect(args.recipients.map((a) => a.toLowerCase())).toEqual(
        recipients.map((a) => a.toLowerCase()),
      );
      expect(args.basisPoints.map((n) => Number(n))).toEqual(bps);
      expect(args.totalAmount).toBe(value);
    },
    90_000,
  );
});
