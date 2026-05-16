/**
 * Probe the deposit wallet contract for its actual EIP-712 domain.
 * Calls eip712Domain() (EIP-5267) to read the canonical name, version,
 * chainId, verifyingContract, salt that we should be wrapping over.
 */

import { createPublicClient, getAddress, http, type Hex } from "viem";
import { polygon } from "viem/chains";

const CANDIDATES = [
  getAddress("0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB"),
  getAddress("0xf4be72ae8dd864f6cb0e48b15fa54e56f3d4e529"),
];
const DEPOSIT_WALLET = CANDIDATES[0];

const eip5267Abi = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
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
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

async function probeOne(pc: ReturnType<typeof createPublicClient>, addr: `0x${string}`): Promise<void> {
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`Probing ${addr}`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  await probeImpl(pc, addr);
}

async function main() {
  const pc = createPublicClient({ chain: polygon, transport: http(process.env.POLYGON_RPC) });
  for (const a of CANDIDATES) await probeOne(pc, a);
}

async function probeImpl(pc: ReturnType<typeof createPublicClient>, DEPOSIT_WALLET: `0x${string}`): Promise<void> {

  try {
    const dom = await pc.readContract({
      address: DEPOSIT_WALLET,
      abi: eip5267Abi,
      functionName: "eip712Domain",
    });
    console.log(`\neip712Domain():`);
    console.log(`  fields:            ${dom[0]}`);
    console.log(`  name:              "${dom[1]}"`);
    console.log(`  version:           "${dom[2]}"`);
    console.log(`  chainId:           ${dom[3]}`);
    console.log(`  verifyingContract: ${dom[4]}`);
    console.log(`  salt:              ${dom[5]}`);
    console.log(`  extensions:        [${dom[6].join(", ")}]`);
  } catch (e) {
    console.log(`eip712Domain() failed: ${(e as Error).message.slice(0, 200)}`);
  }

  try {
    const own = await pc.readContract({
      address: DEPOSIT_WALLET,
      abi: eip5267Abi,
      functionName: "owner",
    });
    console.log(`\nowner: ${own}`);
  } catch (e) {
    console.log(`owner() failed: ${(e as Error).message.slice(0, 200)}`);
  }

  try {
    const sep = await pc.readContract({
      address: DEPOSIT_WALLET,
      abi: eip5267Abi,
      functionName: "DOMAIN_SEPARATOR",
    });
    console.log(`\nDOMAIN_SEPARATOR: ${sep}`);
  } catch (e) {
    console.log(`DOMAIN_SEPARATOR() failed: ${(e as Error).message.slice(0, 200)}`);
  }

  const probeAbi = [
    { type: "function", name: "signer",          stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { type: "function", name: "sessionSigner",   stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { type: "function", name: "authorizedSigner",stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { type: "function", name: "entryPoint",      stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { type: "function", name: "implementation",  stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { type: "function", name: "VERSION",         stateMutability: "view", inputs: [], outputs: [{ type: "string"  }] },
    { type: "function", name: "version",         stateMutability: "view", inputs: [], outputs: [{ type: "string"  }] },
    { type: "function", name: "name",            stateMutability: "view", inputs: [], outputs: [{ type: "string"  }] },
    { type: "function", name: "isValidSigner",   stateMutability: "view", inputs: [{ name: "s", type: "address" }], outputs: [{ type: "bool" }] },
    { type: "function", name: "isAuthorizedSigner", stateMutability: "view", inputs: [{ name: "s", type: "address" }], outputs: [{ type: "bool" }] },
  ] as const;

  console.log("\n── Probing common signer-storage getters ──");
  for (const fn of probeAbi) {
    const args = fn.inputs.length ? ["0x5342ac8383c39bf680a4035C02EcACdc8E412435" as Hex] : [];
    try {
      const r = await pc.readContract({
        address: DEPOSIT_WALLET,
        abi: probeAbi,
        functionName: fn.name,
        args: args as never,
      });
      console.log(`  ${fn.name.padEnd(22)} = ${r}`);
    } catch (e) {
      const msg = (e as Error).message;
      const short = msg.includes("reverted") ? "REVERT" : msg.slice(0, 80);
      console.log(`  ${fn.name.padEnd(22)} ${short}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
