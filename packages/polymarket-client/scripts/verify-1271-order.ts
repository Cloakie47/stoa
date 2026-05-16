/**
 * Take an SDK-prepared ORDER signature (sigType=POLY_1271, ERC-7739 wrapped)
 * and call deposit wallet's isValidSignature on it. This proves whether
 * the SDK's wrap pattern is even on-chain-valid, or whether the wallet
 * has a different envelope format.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  getAddress,
  hashTypedData,
  http,
  type Hex,
} from "viem";
import { polygon } from "viem/chains";

import { StoaPolymarketClient, SignatureTypeV2 } from "../src/index.js";

const DEPOSIT_WALLET = getAddress("0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB");
const FIGURE_F03_URL =
  "https://polymarket.com/event/of-packages-pushed-by-figures-f03-robots-by-may-21-10-pm-et";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
for (const line of readFileSync(resolve(repoRoot, ".env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && m[1] && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex;
  const builderCode = process.env.POLY_BUILDER_CODE;

  const client = new StoaPolymarketClient({
    privateKey: pk,
    builderCode,
    polygonRpcUrl: process.env.POLYGON_RPC,
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: DEPOSIT_WALLET,
  });

  console.log(`Signer: ${client.signerAddress}`);
  console.log(`Funder: ${client.funderAddress}`);

  const market = await client.getMarket(FIGURE_F03_URL);
  console.log(`Market: ${market.question}  tick=${market.tickSize} negRisk=${market.negRisk}`);

  const bestBid = market.yesOrderbook.bestBid!;
  const tickFloat = Number.parseFloat(market.tickSize);
  const tickDecimals = market.tickSize.indexOf(".") === -1 ? 0 : market.tickSize.length - market.tickSize.indexOf(".") - 1;
  const limitPrice = Math.max(tickFloat, Math.floor((bestBid - 0.05) / tickFloat) * tickFloat);
  const roundedPrice = Number(limitPrice.toFixed(tickDecimals));
  const size = Number((1 / roundedPrice).toFixed(2));

  const prepared = await client.prepareOrder({
    tokenId: market.tokenIds.yes!,
    side: "BUY",
    price: roundedPrice,
    size,
    tickSize: market.tickSize,
    negRisk: market.negRisk,
  });

  // Compute the order's standard EIP-712 hash (CTF Exchange V2 domain).
  // Mirrors what the exchange contract computes when validating maker.
  const verifyingContract = market.negRisk
    ? "0xe2222d279d744050d28e00520010520000310F59"  // negRisk
    : "0xE111180000d2663C0091e4f400237545B87B996B"; // standard

  const orderHash = hashTypedData({
    domain: {
      name: "Polymarket CTF Exchange",
      version: "2",
      chainId: polygon.id,
      verifyingContract: verifyingContract as Hex,
    },
    types: {
      Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "side", type: "uint8" },
        { name: "signatureType", type: "uint8" },
        { name: "timestamp", type: "uint256" },
        { name: "metadata", type: "bytes32" },
        { name: "builder", type: "bytes32" },
      ],
    },
    primaryType: "Order",
    message: {
      salt: BigInt(prepared.signedOrder.salt as string),
      maker: prepared.signedOrder.maker as Hex,
      signer: prepared.signedOrder.signer as Hex,
      tokenId: BigInt(prepared.signedOrder.tokenId as string),
      makerAmount: BigInt(prepared.signedOrder.makerAmount as string),
      takerAmount: BigInt(prepared.signedOrder.takerAmount as string),
      side: Number(prepared.typedData.message.side),
      signatureType: Number(prepared.signedOrder.signatureType),
      timestamp: BigInt(prepared.signedOrder.timestamp as string),
      metadata: (prepared.signedOrder.metadata ?? "0x" + "0".repeat(64)) as Hex,
      builder: (prepared.signedOrder.builder ?? "0x" + "0".repeat(64)) as Hex,
    },
  });

  console.log(`orderHash:   ${orderHash}`);
  console.log(`signature:   ${(prepared.signedOrder.signature as string).slice(0, 20)}…${(prepared.signedOrder.signature as string).slice(-10)}`);
  console.log(`sig bytes:   ${((prepared.signedOrder.signature as string).length - 2) / 2}`);

  const publicClient = createPublicClient({ chain: polygon, transport: http(process.env.POLYGON_RPC) });
  const erc1271Abi = [
    {
      type: "function",
      name: "isValidSignature",
      stateMutability: "view",
      inputs: [
        { name: "hash", type: "bytes32" },
        { name: "signature", type: "bytes" },
      ],
      outputs: [{ type: "bytes4" }],
    },
  ] as const;

  try {
    const result = await publicClient.readContract({
      address: DEPOSIT_WALLET,
      abi: erc1271Abi,
      functionName: "isValidSignature",
      args: [orderHash, prepared.signedOrder.signature as Hex],
    });
    console.log(`\nisValidSignature(orderHash, sdkOrderSig) → ${result}`);
    if (result === "0x1626ba7e") {
      console.log("✓ SDK's order wrap is on-chain-valid. CLOB rejection was about API key binding only.");
      console.log("→ For B-1 to work for L1 auth, we need the same wrap convention. Look for hash math diff.");
    } else {
      console.log("✗ SDK's wrap doesn't pass on-chain either. Polymarket wallet uses non-standard envelope.");
    }
  } catch (e) {
    console.log(`\nisValidSignature reverted: ${(e as Error).message.slice(0, 500)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
