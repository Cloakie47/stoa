/**
 * One-shot sanity check: ask the deposit wallet directly whether our
 * ERC-7739-wrapped ClobAuth signature passes its isValidSignature() check.
 *
 *   - If we get 0x1626ba7e back, our wrap is correct and CLOB's rejection
 *     means CLOB does not call isValidSignature (no ERC-1271 support).
 *   - If we get 0xffffffff (or anything else), our wrap is wrong and
 *     CLOB's rejection is a wrap bug — fix the wrap before deciding.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const PUSD = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const DEPOSIT_WALLET = getAddress("0xF4be72ae8Dd864f6Cb0E48b15fA54E56f3D4E529");
const ZERO_BYTES32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const MSG_TO_SIGN = "This message attests that I control the given wallet";
const CLOB_AUTH_TYPE_STRING =
  "ClobAuth(address address,string timestamp,uint256 nonce,string message)";

// ── env ──
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
for (const line of readFileSync(resolve(repoRoot, ".env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && m[1] && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex;
  const account = privateKeyToAccount(pk);
  const eoa = account.address;
  const chainId = polygon.id;
  const ts = Math.floor(Date.now() / 1000);
  const nonce = 0;

  const innerContents = {
    address: DEPOSIT_WALLET,
    timestamp: ts.toString(),
    nonce: BigInt(nonce),
    message: MSG_TO_SIGN,
  };

  const transport = http(process.env.POLYGON_RPC);
  const publicClient = createPublicClient({ chain: polygon, transport });
  const walletClient = createWalletClient({ account, chain: polygon, transport });

  // MODE we try first: sign with APP's domain (mirrors the SDK pattern).
  // If this fails, MODE 2 below signs with WALLET's domain.
  const signMode = (process.argv[2] ?? "app") as "app" | "wallet";

  const signerDomain =
    signMode === "wallet"
      ? {
          name: "DepositWallet",
          version: "1",
          chainId,
          verifyingContract: DEPOSIT_WALLET,
        }
      : { name: "ClobAuthDomain", version: "1", chainId };

  console.log(`MODE: sign over ${signMode}'s domain — ${JSON.stringify(signerDomain)}`);

  const innerSig = (await walletClient.signTypedData({
    account,
    domain: signerDomain,
    types: {
      TypedDataSign: [
        { name: "contents", type: "ClobAuth" },
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
        { name: "salt", type: "bytes32" },
      ],
      ClobAuth: [
        { name: "address", type: "address" },
        { name: "timestamp", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "message", type: "string" },
      ],
    },
    primaryType: "TypedDataSign",
    message: {
      contents: innerContents,
      name: "DepositWallet",
      version: "1",
      chainId: BigInt(chainId),
      verifyingContract: DEPOSIT_WALLET,
      salt: ZERO_BYTES32,
    },
  })) as Hex;

  // 2. App domain separator.
  const appDomainSep = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [
        keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId)")),
        keccak256(toBytes("ClobAuthDomain")),
        keccak256(toBytes("1")),
        BigInt(chainId),
      ],
    ),
  );

  // 3. Contents hash.
  const contentsHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
      [
        keccak256(toBytes(CLOB_AUTH_TYPE_STRING)),
        DEPOSIT_WALLET,
        keccak256(toBytes(ts.toString())),
        BigInt(nonce),
        keccak256(toBytes(MSG_TO_SIGN)),
      ],
    ),
  );

  // 4. Assemble 7739 wrapped sig.
  const typeStringBytes = toBytes(CLOB_AUTH_TYPE_STRING);
  const typeLenHex = typeStringBytes.length.toString(16).padStart(4, "0");
  const wrappedSig = `0x${innerSig.slice(2)}${appDomainSep.slice(2)}${contentsHash.slice(2)}${toHex(typeStringBytes).slice(2)}${typeLenHex}` as Hex;

  // 5. The "hash" we'd pass to isValidSignature is the standard EIP-712 hash
  //    of the OUTER ClobAuth message (what CLOB computes when verifying L1).
  const outerHash = hashTypedData({
    domain: { name: "ClobAuthDomain", version: "1", chainId },
    types: {
      ClobAuth: [
        { name: "address", type: "address" },
        { name: "timestamp", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "message", type: "string" },
      ],
    },
    primaryType: "ClobAuth",
    message: innerContents,
  });

  console.log(`EOA:              ${eoa}`);
  console.log(`Deposit wallet:   ${DEPOSIT_WALLET}`);
  console.log(`appDomainSep:     ${appDomainSep}`);
  console.log(`contentsHash:     ${contentsHash}`);
  console.log(`outerHash:        ${outerHash}`);
  console.log(`innerSig:         ${innerSig.slice(0, 16)}…${innerSig.slice(-8)}`);
  console.log(`wrappedSig bytes: ${(wrappedSig.length - 2) / 2}`);

  // 6. Call isValidSignature on the deposit wallet.
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
      args: [outerHash, wrappedSig],
    });
    console.log(`\nisValidSignature → ${result}`);
    if (result === "0x1626ba7e") {
      console.log("✓ MAGIC VALUE — wrap is correct. CLOB rejection implies no ERC-1271 support server-side.");
    } else {
      console.log("✗ Not magic value — wrap is wrong somewhere. Iterate before declaring CLOB the blocker.");
    }
  } catch (e) {
    console.log(`\nisValidSignature THREW (i.e., reverted): ${(e as Error).message.slice(0, 400)}`);
    console.log("If revert is 'invalid signature' or similar, the wrap is wrong.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
