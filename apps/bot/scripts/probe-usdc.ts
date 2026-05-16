/**
 * Probe Arc Testnet USDC for its actual EIP-712 domain + capabilities.
 */
import { createPublicClient, http } from "viem";

const ARC_USDC = "0x3600000000000000000000000000000000000000";
const ARC_RPC = "https://rpc.testnet.arc.network";

const probeAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "eip712Domain", stateMutability: "view", inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

async function main(): Promise<void> {
  const pc = createPublicClient({ transport: http(ARC_RPC) });
  for (const fn of probeAbi) {
    try {
      const r = await pc.readContract({
        address: ARC_USDC as `0x${string}`,
        abi: probeAbi,
        functionName: fn.name,
      });
      console.log(`${fn.name.padEnd(18)} = ${JSON.stringify(r, null, 2).slice(0, 300)}`);
    } catch (e) {
      console.log(`${fn.name.padEnd(18)} REVERT ${(e as Error).message.slice(0, 100)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
