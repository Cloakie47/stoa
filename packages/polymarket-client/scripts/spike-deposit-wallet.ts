/**
 * Polymarket V2 deposit-wallet spike — operator-only, idempotent.
 *
 * Goal: end-to-end validate the V2 trading path using the deployer EOA as the
 * deposit-wallet owner. NO Circle involvement. If this works, the Polymarket
 * leg of Phase 5 is fully de-risked; the remaining unknown is Circle's
 * signTypedData adapter, which is a smaller, isolated surface.
 *
 * Flow (state-machine, idempotent — re-run safe):
 *   1. Submit WALLET-CREATE to the Polymarket V2 relayer for the deployer EOA
 *      (gasless; Polymarket pays). Save tx hash + deposit-wallet address.
 *   2. Print the deposit-wallet address and STOP if its pUSD balance is < $1.
 *      Operator manually transfers ~$3 pUSD from the deployer EOA to the
 *      deposit wallet, then re-runs.
 *   3. With funds in the deposit wallet:
 *      a. Resolve the Figure F.03 market via Gamma (same as the existing
 *         smoke test).
 *      b. Build a V2 BUY order at 5¢ below best YES bid, $1 notional, with
 *         signatureType=POLY_1271 and funder=depositWallet. SDK auto-wraps
 *         per ERC-7739.
 *      c. POST to CLOB → orderId.
 *      d. getOpenOrders to verify it's in the book.
 *      e. cancelOrder.
 *      f. Read final pUSD balance.
 *   4. Print a summary block: all addresses, tx hashes, orderId, final balance.
 *
 * Surfaces failures immediately — does NOT iterate on fallbacks.
 *
 * Run:
 *   tsx packages/polymarket-client/scripts/spike-deposit-wallet.ts
 *
 * Required env (in repo-root .env):
 *   DEPLOYER_PRIVATE_KEY  — owner of the new deposit wallet
 *   POLY_BUILDER_CODE     — builder attribution
 *   POLYGON_RPC           — optional; defaults to public node
 */

import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ClobClient, Chain } from "@polymarket/clob-client-v2";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  toBytes,
  toHex,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

import { StoaPolymarketClient, SignatureTypeV2 } from "../src/index.js";

// ── Constants ───────────────────────────────────────────────────────────────

const RELAYER_URL = "https://relayer-v2.polymarket.com";
const CLOB_HOST = "https://clob.polymarket.com";
const ZERO_BYTES32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const MSG_TO_SIGN = "This message attests that I control the given wallet";
const CLOB_AUTH_TYPE_STRING =
  "ClobAuth(address address,string timestamp,uint256 nonce,string message)";

const DEPOSIT_FACTORY: Address = getAddress(
  "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
);
const PUSD: Address = getAddress("0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb");
const FIGURE_F03_URL =
  "https://polymarket.com/event/of-packages-pushed-by-figures-f03-robots-by-may-21-10-pm-et";

const MIN_FUNDED_PUSD = 1_000_000n; // $1 in 6-decimal units
const ORDER_NOTIONAL_USD = 1; // $1 BUY order

// ── State file (idempotent re-runs) ─────────────────────────────────────────

const scriptDir = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(scriptDir, ".spike-state.json");

interface BuilderCreds {
  key: string;
  secret: string;
  passphrase: string;
}

interface SpikeState {
  ownerEOA: string;
  builderCreds?: BuilderCreds;
  depositWalletApiCreds?: BuilderCreds;
  depositWallet?: string;
  walletCreateTxHash?: string;
  walletCreateTransactionID?: string;
  orderId?: string;
  cancelTxHash?: string;
  lastRun?: string;
}

function loadState(): SpikeState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SpikeState;
  } catch (e) {
    console.warn(`[spike] State file ${STATE_FILE} unreadable: ${e}`);
    return null;
  }
}

function saveState(state: SpikeState): void {
  state.lastRun = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Env loading ─────────────────────────────────────────────────────────────

const repoRoot = resolve(scriptDir, "../../..");
loadDotenv(resolve(repoRoot, ".env"));

function loadDotenv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.warn(`[spike] No .env at ${path}; relying on shell env.`);
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (key && val && !process.env[key]) process.env[key] = val;
  }
}

// ── ABIs ────────────────────────────────────────────────────────────────────

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// ── Relayer auth (matches @polymarket/builder-signing-sdk) ──────────────────

/**
 * Build builder-auth headers per @polymarket/builder-signing-sdk.
 * HMAC-SHA256 over `${ts}${METHOD}${path}${body}` keyed by base64-decoded
 * secret. Output is URL-safe-base64 (replace + with -, / with _, keep =).
 */
function builderAuthHeaders(
  creds: BuilderCreds,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: string,
): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${ts}${method}${path}${body}`;
  const keyBytes = Buffer.from(creds.secret, "base64");
  const sig = createHmac("sha256", keyBytes)
    .update(payload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return {
    POLY_BUILDER_API_KEY: creds.key,
    POLY_BUILDER_PASSPHRASE: creds.passphrase,
    POLY_BUILDER_SIGNATURE: sig,
    POLY_BUILDER_TIMESTAMP: ts.toString(),
  };
}

// ── Relayer interactions ────────────────────────────────────────────────────

async function relayerPost(
  path: string,
  body: unknown,
  creds: BuilderCreds,
): Promise<unknown> {
  const url = `${RELAYER_URL}${path}`;
  const bodyStr = JSON.stringify(body);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...builderAuthHeaders(creds, "POST", path, bodyStr),
    },
    body: bodyStr,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(
      `Relayer POST ${path} → ${resp.status}: ${text.slice(0, 500)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

async function relayerGet(path: string, creds: BuilderCreds): Promise<unknown> {
  const url = `${RELAYER_URL}${path}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: builderAuthHeaders(creds, "GET", path, ""),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(
      `Relayer GET ${path} → ${resp.status}: ${text.slice(0, 500)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

interface RelayerTxResponse {
  transactionID?: string;
  state?: string;
  hash?: string;
  transactionHash?: string;
  [key: string]: unknown;
}

async function submitWalletCreate(
  owner: Address,
  creds: BuilderCreds,
): Promise<RelayerTxResponse> {
  console.log(`[relayer] POST /submit  type=WALLET-CREATE  from=${owner}  to=${DEPOSIT_FACTORY}`);
  const body = { type: "WALLET-CREATE", from: owner, to: DEPOSIT_FACTORY };
  const resp = (await relayerPost("/submit", body, creds)) as RelayerTxResponse;
  console.log(`[relayer] submit response: ${JSON.stringify(resp)}`);
  return resp;
}

async function getRelayerTransaction(
  id: string,
  creds: BuilderCreds,
): Promise<RelayerTxResponse> {
  try {
    return (await relayerGet(`/transaction?id=${id}`, creds)) as RelayerTxResponse;
  } catch {
    return (await relayerGet(
      `/transaction?transactionID=${id}`,
      creds,
    )) as RelayerTxResponse;
  }
}

async function pollRelayerUntilMined(
  id: string,
  creds: BuilderCreds,
  intervalMs = 2000,
  maxAttempts = 30,
): Promise<RelayerTxResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    const tx = await getRelayerTransaction(id, creds);
    console.log(
      `[relayer] poll ${i + 1}/${maxAttempts}: state=${tx.state} hash=${
        tx.transactionHash ?? tx.hash ?? "(none)"
      }`,
    );
    if (tx.state === "STATE_MINED" || tx.state === "STATE_CONFIRMED") return tx;
    if (tx.state === "STATE_FAILED" || tx.state === "STATE_INVALID") {
      throw new Error(
        `Relayer tx ended in ${tx.state}: ${JSON.stringify(tx).slice(0, 500)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Relayer tx ${id} not confirmed after ${maxAttempts} polls`);
}

// ── Builder API key — L1-authenticated, signed by deployer EOA ──────────────

async function getOrMintBuilderCreds(
  state: SpikeState,
  pk: Hex,
): Promise<BuilderCreds> {
  if (state.builderCreds) {
    console.log("[builder-creds] Reusing builder API key from state.");
    return state.builderCreds;
  }
  console.log("[builder-creds] Minting new builder API key...");
  const account = privateKeyToAccount(pk);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(process.env.POLYGON_RPC),
  });
  // Step 1: L1-auth client to derive standard CLOB API key (HMAC creds for L2).
  const clobL1 = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: Chain.POLYGON,
    signer: walletClient,
  });
  console.log("[builder-creds]   step 1/2: createOrDeriveApiKey (L1) ...");
  const clobCreds = await clobL1.createOrDeriveApiKey();
  // Step 2: rebuild ClobClient with L2 creds, then mint builder API key.
  const clobL2 = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: Chain.POLYGON,
    signer: walletClient,
    creds: clobCreds,
  });
  console.log("[builder-creds]   step 2/2: createBuilderApiKey (L2) ...");
  const creds = (await clobL2.createBuilderApiKey()) as BuilderCreds;
  if (!creds.key || !creds.secret || !creds.passphrase) {
    fail(
      `createBuilderApiKey returned malformed creds: ${JSON.stringify(creds)}`,
    );
  }
  console.log(`[builder-creds] minted key=${creds.key.slice(0, 8)}…`);
  state.builderCreds = creds;
  saveState(state);
  return creds;
}

// ── Deposit-wallet address extraction ───────────────────────────────────────

/**
 * Find the deposit wallet from a WALLET-CREATE receipt. The new wallet PROXY
 * emits an `OwnershipTransferred(0x0, owner)` event during construction —
 * `log.address` of that log is the deposit wallet address. The factory's
 * own event's `data` field contains a different address (a shared
 * implementation/registry — verified empirically: probing both candidates
 * shows the wallet whose `owner()` returns our EOA is the OwnershipTransferred
 * emitter, not the factory-event-data address).
 */
async function extractDepositWalletFromReceipt(
  publicClient: ReturnType<typeof createPublicClient>,
  txHash: Hex,
  ownerEOA: Address,
): Promise<Address> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  console.log(`[onchain] Receipt has ${receipt.logs.length} log(s)`);
  for (const log of receipt.logs) {
    console.log(
      `[onchain]   log from ${log.address} topics[0]=${log.topics[0] ?? "(none)"}`,
    );
  }

  // OwnershipTransferred(address indexed previousOwner, address indexed newOwner)
  const OWN_TRANSFERRED_SIG =
    "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0";
  const ownerPaddedLower = `0x000000000000000000000000${ownerEOA.slice(2).toLowerCase()}`;

  const candidate = receipt.logs.find(
    (l) =>
      l.topics[0] === OWN_TRANSFERRED_SIG &&
      l.topics[2]?.toLowerCase() === ownerPaddedLower,
  );
  if (!candidate) {
    throw new Error(
      `No OwnershipTransferred(0x0, ${ownerEOA}) log found in receipt — cannot identify deposit wallet. Logs: ${JSON.stringify(receipt.logs, null, 2)}`,
    );
  }
  return getAddress(candidate.address);
}

// ── DepositWallet-bound CLOB API key (Path B-1) ─────────────────────────────

interface ApiKeyCreds {
  key: string;
  secret: string;
  passphrase: string;
}

/**
 * Mint a CLOB API key bound to a smart-contract deposit wallet.
 *
 * The SDK's createApiKey always sets POLY_ADDRESS = signer's EOA, which gives
 * us an EOA-bound key. For POLY_1271 trading we need POLY_ADDRESS = depositWallet
 * so CLOB's "order.signer == api_key_address" check passes.
 *
 * Recipe (mirrors @polymarket/clob-client-v2's order-side ERC-7739 wrap):
 *   1. Construct ClobAuth EIP-712 inner message with address = depositWallet.
 *   2. Wrap in TypedDataSign envelope (verifyingContract = depositWallet,
 *      domain.name = "DepositWallet", domain.version = "1").
 *   3. Sign with EOA; result is the 65-byte inner ECDSA sig.
 *   4. Compute appDomainSeparator (Polymarket "ClobAuthDomain" v1, no
 *      verifyingContract field).
 *   5. Compute contentsHash of the inner ClobAuth struct.
 *   6. Assemble 7739 wrapped signature:
 *        innerSig | appDomainSep | contentsHash | typeString | uint16(len)
 *   7. POST /auth/api-key with POLY_ADDRESS = depositWallet, POLY_SIGNATURE
 *      = wrapped sig. CLOB calls IERC1271(depositWallet).isValidSignature →
 *      deposit-wallet contract unwraps the 7739 envelope and verifies the
 *      inner ECDSA sig against its owner (= EOA). If we did everything right,
 *      it returns 0x1626ba7e and CLOB mints a depositWallet-bound key.
 */
async function createDepositWalletApiKey(
  walletClient: WalletClient,
  eoa: Address,
  depositWallet: Address,
  chainId: number,
): Promise<ApiKeyCreds> {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = 0;

  const innerContents = {
    address: depositWallet,
    timestamp: ts.toString(),
    nonce: BigInt(nonce),
    message: MSG_TO_SIGN,
  };

  // Sign the TypedDataSign envelope (mirrors ExchangeOrderBuilderV2 pattern).
  const innerSig = (await walletClient.signTypedData({
    account: walletClient.account ?? eoa,
    domain: {
      name: "ClobAuthDomain",
      version: "1",
      chainId,
    },
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
      verifyingContract: depositWallet,
      salt: ZERO_BYTES32,
    },
  })) as Hex;

  // appDomainSeparator: EIP712Domain for ClobAuth (no verifyingContract field).
  const appDomainTypehash = keccak256(
    toBytes("EIP712Domain(string name,string version,uint256 chainId)"),
  );
  const appDomainSep = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
      ],
      [
        appDomainTypehash,
        keccak256(toBytes("ClobAuthDomain")),
        keccak256(toBytes("1")),
        BigInt(chainId),
      ],
    ),
  );

  // contentsHash: hash of the ClobAuth struct.
  const clobAuthTypehash = keccak256(toBytes(CLOB_AUTH_TYPE_STRING));
  const contentsHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        clobAuthTypehash,
        depositWallet,
        keccak256(toBytes(ts.toString())),
        BigInt(nonce),
        keccak256(toBytes(MSG_TO_SIGN)),
      ],
    ),
  );

  // Assemble ERC-7739 wrapped signature.
  const typeStringBytes = toBytes(CLOB_AUTH_TYPE_STRING);
  const typeLenHex = typeStringBytes.length.toString(16).padStart(4, "0");
  const wrappedSig = `0x${innerSig.slice(2)}${appDomainSep.slice(2)}${contentsHash.slice(2)}${toHex(typeStringBytes).slice(2)}${typeLenHex}` as Hex;

  console.log(`[clob-auth] EOA inner sig: ${innerSig.slice(0, 14)}…${innerSig.slice(-6)} (${innerSig.length - 2} hex chars)`);
  console.log(`[clob-auth] appDomainSep:  ${appDomainSep}`);
  console.log(`[clob-auth] contentsHash:  ${contentsHash}`);
  console.log(`[clob-auth] type string:   "${CLOB_AUTH_TYPE_STRING}" (${typeStringBytes.length} bytes)`);
  console.log(`[clob-auth] wrapped sig:   ${wrappedSig.length - 2} hex chars (${(wrappedSig.length - 2) / 2} bytes)`);

  // Try the SDK's exact behavior: POST /auth/api-key, then if not OK, GET /auth/derive-api-key.
  // Both with POLY_ADDRESS = depositWallet (lowercased — defensive).
  const polyAddrLower = depositWallet.toLowerCase();
  const headers: Record<string, string> = {
    POLY_ADDRESS: polyAddrLower,
    POLY_SIGNATURE: wrappedSig,
    POLY_TIMESTAMP: ts.toString(),
    POLY_NONCE: nonce.toString(),
  };
  console.log(`[clob-auth] POST /auth/api-key  POLY_ADDRESS=${polyAddrLower}`);
  let resp = await fetch(`${CLOB_HOST}/auth/api-key`, {
    method: "POST",
    headers,
  });
  let text = await resp.text();
  console.log(`[clob-auth]   ${resp.status}: ${text.slice(0, 400)}`);
  if (!resp.ok) {
    console.log(`[clob-auth] POST failed; trying GET /auth/derive-api-key (existing-key fallback)...`);
    resp = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
      method: "GET",
      headers,
    });
    text = await resp.text();
    console.log(`[clob-auth]   ${resp.status}: ${text.slice(0, 400)}`);
  }
  if (!resp.ok) {
    throw new Error(
      `CLOB API-key endpoints rejected ERC-1271 attestation: last status ${resp.status}: ${text.slice(0, 800)}`,
    );
  }
  const body = JSON.parse(text) as {
    apiKey?: string;
    secret?: string;
    passphrase?: string;
  };
  if (!body.apiKey || !body.secret || !body.passphrase) {
    throw new Error(`CLOB returned malformed creds: ${text.slice(0, 400)}`);
  }
  return { key: body.apiKey, secret: body.secret, passphrase: body.passphrase };
}

// ── Raw CLOB L2 requests with custom POLY_ADDRESS ───────────────────────────

/**
 * Build CLOB L2 HMAC headers (per @polymarket/clob-client-v2's hmac signing)
 * but with POLY_ADDRESS pinned to depositWallet (SDK clobbers it back to EOA).
 *
 * Per src/signing/hmac.ts: HMAC-SHA256 over `ts|method|path|body`, key = base64-decoded
 * secret, output = base64-url-safe (replace + with -, / with _, KEEP = padding).
 */
function clobL2Headers(
  creds: ApiKeyCreds,
  polyAddress: Address,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: string,
): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${ts}${method}${path}${body}`;
  const keyBytes = Buffer.from(creds.secret, "base64");
  const sig = createHmac("sha256", keyBytes)
    .update(payload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return {
    POLY_ADDRESS: polyAddress,
    POLY_SIGNATURE: sig,
    POLY_TIMESTAMP: ts.toString(),
    POLY_API_KEY: creds.key,
    POLY_PASSPHRASE: creds.passphrase,
  };
}

async function clobPostOrder(
  signedOrder: Record<string, unknown>,
  creds: ApiKeyCreds,
  depositWallet: Address,
  orderType = "GTC",
): Promise<{ orderID?: string; success?: boolean; errorMsg?: string; [k: string]: unknown }> {
  const path = "/order";
  const payload = {
    order: {
      salt: parseInt(String(signedOrder.salt), 10),
      maker: signedOrder.maker,
      signer: signedOrder.signer,
      taker: signedOrder.taker,
      tokenId: signedOrder.tokenId,
      makerAmount: signedOrder.makerAmount,
      takerAmount: signedOrder.takerAmount,
      side: signedOrder.side,
      signatureType: signedOrder.signatureType,
      timestamp: signedOrder.timestamp,
      expiration: signedOrder.expiration,
      metadata: signedOrder.metadata,
      builder: signedOrder.builder,
      signature: signedOrder.signature,
    },
    owner: creds.key,
    orderType,
    postOnly: false,
    deferExec: false,
  };
  const body = JSON.stringify(payload);
  const resp = await fetch(`${CLOB_HOST}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...clobL2Headers(creds, depositWallet, "POST", path, body),
    },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`CLOB ${path} ${resp.status}: ${text.slice(0, 800)}`);
  }
  return JSON.parse(text);
}

async function clobGetOpenOrders(
  creds: ApiKeyCreds,
  depositWallet: Address,
  market?: string,
): Promise<unknown[]> {
  const path = market ? `/data/orders?market=${market}` : "/data/orders";
  const resp = await fetch(`${CLOB_HOST}${path}`, {
    method: "GET",
    headers: clobL2Headers(creds, depositWallet, "GET", path, ""),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`CLOB ${path} ${resp.status}: ${text.slice(0, 800)}`);
  }
  return JSON.parse(text);
}

async function clobCancelOrder(
  orderId: string,
  creds: ApiKeyCreds,
  depositWallet: Address,
): Promise<unknown> {
  const path = "/order";
  const body = JSON.stringify({ orderID: orderId });
  const resp = await fetch(`${CLOB_HOST}${path}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      ...clobL2Headers(creds, depositWallet, "DELETE", path, body),
    },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`CLOB DELETE ${path} ${resp.status}: ${text.slice(0, 800)}`);
  }
  return JSON.parse(text);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmt6(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = amount % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

function fail(msg: string): never {
  console.error(`[spike] FATAL: ${msg}`);
  process.exit(1);
}

function decimalsFromTick(tick: string): number {
  const idx = tick.indexOf(".");
  return idx === -1 ? 0 : tick.length - idx - 1;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  if (!pk) fail("DEPLOYER_PRIVATE_KEY missing from .env");
  const builderCode = process.env.POLY_BUILDER_CODE;
  if (!builderCode) {
    console.warn(
      "[spike] POLY_BUILDER_CODE missing — order will have empty builder field. Continuing.",
    );
  }

  const account = privateKeyToAccount(pk);
  const ownerEOA = account.address;
  const transport = http(process.env.POLYGON_RPC);
  const publicClient = createPublicClient({ chain: polygon, transport });

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Stoa × Polymarket V2 deposit-wallet spike (Path B)          ║");
  console.log("║  Owner: deployer EOA. No Circle in this spike.                ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`\nOwner EOA:        ${ownerEOA}`);
  console.log(`Polygon RPC:      ${process.env.POLYGON_RPC ?? "(viem default)"}`);
  console.log(`State file:       ${STATE_FILE}\n`);

  let state = loadState() ?? { ownerEOA };
  if (state.ownerEOA !== ownerEOA) {
    fail(
      `State file owner ${state.ownerEOA} ≠ env owner ${ownerEOA}. Delete ${STATE_FILE} to reset.`,
    );
  }

  // ── Phase 1: deploy deposit wallet ────────────────────────────────────────

  // Builder API key needed for all relayer ops (Phase 1).
  const builderCreds = await getOrMintBuilderCreds(state, pk);

  if (!state.depositWallet) {
    console.log("\n── Phase 1: deploying deposit wallet via relayer WALLET-CREATE ──\n");

    let txHash = state.walletCreateTxHash as Hex | undefined;
    if (!txHash) {
      const submitResp = await submitWalletCreate(ownerEOA, builderCreds);
      const txId = submitResp.transactionID;
      if (!txId) {
        fail(
          `Relayer /submit returned no transactionID. Response: ${JSON.stringify(submitResp)}`,
        );
      }
      state.walletCreateTransactionID = txId;
      txHash = (submitResp.transactionHash ?? submitResp.hash) as Hex | undefined;
      if (!txHash) {
        fail(
          `Relayer /submit returned no transactionHash. Response: ${JSON.stringify(submitResp)}`,
        );
      }
      state.walletCreateTxHash = txHash;
      saveState(state);
    } else {
      console.log(`[relayer] Reusing cached tx hash from state: ${txHash}`);
    }

    console.log(
      `[onchain] Waiting for Polygon receipt: https://polygonscan.com/tx/${txHash}`,
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 120_000,
    });
    console.log(
      `[onchain] receipt status=${receipt.status} block=${receipt.blockNumber} logs=${receipt.logs.length}`,
    );
    if (receipt.status !== "success") {
      fail(`WALLET-CREATE tx reverted on Polygon: ${txHash}`);
    }

    const depositAddr = await extractDepositWalletFromReceipt(publicClient, txHash, ownerEOA);
    state.depositWallet = depositAddr;
    saveState(state);

    console.log(`\n[onchain] Deposit wallet: ${depositAddr}`);
    console.log(`[onchain] Polygonscan: https://polygonscan.com/address/${depositAddr}\n`);
  } else {
    console.log(
      `── Phase 1 already complete: deposit wallet at ${state.depositWallet} ──\n`,
    );
  }

  const depositWallet = getAddress(state.depositWallet!);

  // ── Phase 2: check funding ────────────────────────────────────────────────

  const balance = (await publicClient.readContract({
    address: PUSD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [depositWallet],
  })) as bigint;

  console.log(`Deposit wallet pUSD balance: ${fmt6(balance)} pUSD\n`);

  let postFundingBalance = balance;
  if (balance < MIN_FUNDED_PUSD) {
    console.log("[funding] Deposit wallet underfunded — auto-funding from deployer EOA.");
    const eoaBal = (await publicClient.readContract({
      address: PUSD,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [ownerEOA],
    })) as bigint;
    console.log(`[funding]   deployer pUSD balance: ${fmt6(eoaBal)} pUSD`);
    const want = 3_000_000n; // $3
    const amount = eoaBal >= want ? want : eoaBal;
    if (amount < MIN_FUNDED_PUSD) {
      fail(
        `Deployer EOA has only ${fmt6(eoaBal)} pUSD — need ≥ ${fmt6(MIN_FUNDED_PUSD)} pUSD. Run setup-pusd or top up.`,
      );
    }
    const walletClient = createWalletClient({ account, chain: polygon, transport });
    const transferAbi = [
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
    const txHash = await walletClient.writeContract({
      address: PUSD,
      abi: transferAbi,
      functionName: "transfer",
      args: [depositWallet, amount],
    });
    console.log(`[funding]   transfer tx: ${txHash}`);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    postFundingBalance = (await publicClient.readContract({
      address: PUSD,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [depositWallet],
    })) as bigint;
    console.log(`[funding]   new deposit balance: ${fmt6(postFundingBalance)} pUSD\n`);
  }

  console.log("── Phase 2a: mint a depositWallet-bound CLOB API key (Path B-1) ──\n");

  let depCreds = state.depositWalletApiCreds;
  if (!depCreds) {
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport,
    });
    depCreds = await createDepositWalletApiKey(
      walletClient,
      ownerEOA,
      depositWallet,
      polygon.id,
    );
    state.depositWalletApiCreds = depCreds;
    saveState(state);
    console.log(`[clob-auth] depositWallet-bound API key minted: key=${depCreds.key.slice(0, 8)}…\n`);
  } else {
    console.log(`[clob-auth] Reusing cached depositWallet-bound API key: key=${depCreds.key.slice(0, 8)}…\n`);
  }

  console.log("── Phase 2b: build + submit order via raw fetch ──────────────────\n");

  const client = new StoaPolymarketClient({
    privateKey: pk,
    builderCode,
    polygonRpcUrl: process.env.POLYGON_RPC,
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: depositWallet,
  });

  console.log(`Signer (EOA):     ${client.signerAddress}`);
  console.log(`Funder (deposit): ${client.funderAddress}`);
  console.log(`Signature type:   POLY_1271 (3) — ERC-7739 wrapped\n`);

  console.log(`Resolving market: ${FIGURE_F03_URL}`);
  const market = await client.getMarket(FIGURE_F03_URL);

  console.log(`\nMarket:           ${market.question}`);
  console.log(`conditionId:      ${market.conditionId}`);
  console.log(`YES token id:     ${market.tokenIds.yes}`);
  console.log(`tickSize:         ${market.tickSize}    negRisk: ${market.negRisk}`);
  console.log(
    `YES orderbook:    best_bid=${market.yesOrderbook.bestBid}  best_ask=${market.yesOrderbook.bestAsk}\n`,
  );

  const bestBid = market.yesOrderbook.bestBid;
  if (bestBid === undefined) {
    fail("YES orderbook has no bids — can't price an order 5¢ below.");
  }
  const tickFloat = Number.parseFloat(market.tickSize);
  const tickDecimals = decimalsFromTick(market.tickSize);
  const limitPrice = Math.max(
    tickFloat,
    Math.floor((bestBid - 0.05) / tickFloat) * tickFloat,
  );
  const roundedPrice = Number(limitPrice.toFixed(tickDecimals));
  const size = Number((ORDER_NOTIONAL_USD / roundedPrice).toFixed(2));

  console.log(`Order: BUY ${size} shares @ $${roundedPrice}  (≈$${ORDER_NOTIONAL_USD} notional)\n`);

  console.log("Building + signing order (POLY_1271, SDK auto-wraps ERC-7739)...");
  const prepared = await client.prepareOrder({
    tokenId: market.tokenIds.yes!,
    side: "BUY",
    price: roundedPrice,
    size,
    tickSize: market.tickSize,
    negRisk: market.negRisk,
  });
  console.log(`  signature length (hex chars after 0x): ${prepared.summary.full_signature.length - 2}`);
  console.log(`  (317-byte ERC-7739 wrap → 634 hex chars expected)`);
  console.log(`  maker:  ${prepared.signedOrder.maker}`);
  console.log(`  signer: ${prepared.signedOrder.signer}`);
  console.log(`  sigType: ${prepared.summary.signature_type}`);

  console.log("\nSubmitting to CLOB via raw fetch (POLY_ADDRESS = depositWallet)...");
  const postResp = await clobPostOrder(
    prepared.signedOrder as unknown as Record<string, unknown>,
    depCreds,
    depositWallet,
    "GTC",
  );
  console.log(`[clob] raw response: ${JSON.stringify(postResp)}`);
  const orderId = postResp.orderID;
  if (!orderId) {
    fail(`postOrder returned no orderID: ${JSON.stringify(postResp)}`);
  }
  state.orderId = orderId;
  saveState(state);
  console.log(`[clob] orderId: ${orderId}`);

  console.log("\nVerifying via getOpenOrders (raw fetch)...");
  const openOrders = await clobGetOpenOrders(
    depCreds,
    depositWallet,
    market.conditionId,
  );
  console.log(`[clob] ${openOrders.length} open order(s) for this market:`);
  for (const o of openOrders) console.log(JSON.stringify(o, null, 2));

  console.log("\nCancelling order (raw fetch)...");
  const cancelResp = await clobCancelOrder(orderId, depCreds, depositWallet);
  console.log(`[clob] cancel response: ${JSON.stringify(cancelResp)}`);

  console.log("\nFinal pUSD balance:");
  const finalBalance = (await publicClient.readContract({
    address: PUSD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [depositWallet],
  })) as bigint;
  console.log(`  ${fmt6(finalBalance)} pUSD  (Δ ${fmt6(finalBalance - balance)})`);

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║                    SPIKE SUCCEEDED                           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`Owner EOA:        ${ownerEOA}`);
  console.log(`Deposit wallet:   ${depositWallet}`);
  console.log(`  https://polygonscan.com/address/${depositWallet}`);
  console.log(`WALLET-CREATE tx: ${state.walletCreateTxHash ?? "(reused from state)"}`);
  console.log(`Order id:         ${orderId}`);
  console.log(`Final balance:    ${fmt6(finalBalance)} pUSD`);
  console.log(
    `\nNext: greenlight Phase 5 bot scaffolding (or run Path A with Circle).\n`,
  );
}

main().catch((err) => {
  console.error("\n[spike] Unhandled error:");
  console.error(err);
  process.exit(1);
});
