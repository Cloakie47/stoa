/**
 * Reference TypeScript client for the Stoa x402 facilitator API.
 *
 * What this does:
 *   1. POST /api/x402/analyze without a payment header — receives 402 with
 *      payment instructions.
 *   2. Sends a USDC transfer on Arc Testnet to the instructed recipient.
 *   3. Waits for confirmation, then re-POSTs with X-PAYMENT: <tx_hash>.
 *   4. Prints the verdict.
 *
 * Run:
 *   PRIVATE_KEY=0x... \
 *   MARKET_URL=https://polymarket.com/event/... \
 *   STOA_URL=https://stoa-production-9781.up.railway.app \
 *   tsx examples/x402-client.ts
 *
 * Requires:
 *   - 0.15+ USDC on Arc Testnet at the address that PRIVATE_KEY controls
 *   - viem 2.x  (already a dep of @stoa/analyzer)
 *
 * The example is intentionally single-file and ~120 lines so an AI agent
 * (or a human in a hurry) can copy + paste + run. It depends on nothing
 * beyond viem and Node 18+'s built-in fetch.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

interface ChallengeBody {
  recipient: Address;
  asset_address: Address;
  amount: string; // "0.15"
  chainId: number;
  freshness_window_seconds: number;
  instructions: string;
}

interface SuccessBody {
  verdict: "BUY_YES" | "BUY_NO" | "PASS";
  confidence: number;
  edge: number;
  marketQuestion: string;
  thesis: string;
  ipfs_trace: string | null;
  arc_settlement_tx: Hex;
}

const USDC_ABI = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
]);

// ── Custom Arc Testnet chain object (viem doesn't ship a definition) ────
const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  network: "arc-testnet",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
    public: { http: ["https://rpc.testnet.arc.network"] },
  },
} as const;

async function main() {
  const privateKey = process.env.PRIVATE_KEY as Hex | undefined;
  const marketUrl = process.env.MARKET_URL;
  const stoaUrl = process.env.STOA_URL ?? "https://stoa-production-9781.up.railway.app";
  if (!privateKey || !marketUrl) {
    console.error("Set PRIVATE_KEY and MARKET_URL env vars.");
    process.exit(1);
  }

  // ── 1. Ask for analysis without paying — get the 402 challenge ────────
  console.log("[1/4] Asking Stoa for the payment challenge…");
  const challengeRes = await fetch(`${stoaUrl}/api/x402/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketUrl }),
  });
  if (challengeRes.status !== 402) {
    throw new Error(`Expected HTTP 402; got ${challengeRes.status}: ${await challengeRes.text()}`);
  }
  const challenge = (await challengeRes.json()) as ChallengeBody;
  console.log(
    `  → pay ${challenge.amount} USDC to ${challenge.recipient} on chain ${challenge.chainId}`,
  );

  // ── 2. Send the USDC transfer on Arc ──────────────────────────────────
  console.log("[2/4] Sending USDC transfer…");
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
  const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http() });
  const txHash = await walletClient.writeContract({
    address: challenge.asset_address,
    abi: USDC_ABI,
    functionName: "transfer",
    args: [challenge.recipient, parseUnits(challenge.amount, 6)],
  });
  console.log(`  → tx ${txHash}`);

  console.log("[3/4] Waiting for confirmation…");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`On-chain transfer reverted: ${txHash}`);
  }

  // ── 4. Retry the request with the payment header ──────────────────────
  console.log("[4/4] Retrying with X-PAYMENT…");
  const analysisRes = await fetch(`${stoaUrl}/api/x402/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT": txHash,
    },
    body: JSON.stringify({ marketUrl }),
  });
  if (analysisRes.status !== 200) {
    const errBody = await analysisRes.text();
    throw new Error(`Stoa returned ${analysisRes.status}: ${errBody}`);
  }
  const result = (await analysisRes.json()) as SuccessBody;

  console.log("\n──── ANALYSIS ────────────────────────────────────────");
  console.log(`Market:     ${result.marketQuestion}`);
  console.log(`Verdict:    ${result.verdict}`);
  console.log(`Confidence: ${(result.confidence * 100).toFixed(1)}%`);
  console.log(`Edge:       ${(result.edge * 100).toFixed(2)}¢`);
  console.log(`Thesis:     ${result.thesis}`);
  console.log(
    `IPFS trace: ${result.ipfs_trace ? `https://gateway.pinata.cloud/ipfs/${result.ipfs_trace}` : "(unavailable)"}`,
  );
  console.log(`Tx:         https://testnet.arcscan.app/tx/${result.arc_settlement_tx}`);
}

main().catch((e) => {
  console.error(`[x402-client] failed: ${(e as Error).message}`);
  process.exit(1);
});
