/**
 * One-shot Path 1 diagnostic: POST a single deposit to the Fairblock
 * StableTrust HTTP API with chainId: 5042002 in the body and capture
 * the full response verbatim.
 *
 * Outcomes:
 *   - If the API accepts the chainId param AND has StableTrust deployed
 *     on Stoa's Arc Testnet (5042002), the deposit succeeds — the
 *     integration is unblocked.
 *   - If the API ignores the chainId param, the response will repeat
 *     the "intrinsic transaction cost insufficient funds" error with
 *     an RLP starting 0x02f8d183014a34... (chain 84532 = Base Sepolia).
 *   - If the API recognizes the param but Fairblock has not deployed
 *     on chain 5042002, expect a "chain not supported" error.
 *
 * The response body is saved verbatim to
 * docs/fairblock-arc-test-response.txt for the GitHub issue draft.
 *
 * Usage:
 *   cd apps/analyzer && npx tsx scripts/debug-stabletrust-arc.ts
 *
 * Pre-requisites:
 *   .env.debug at the repo root with:
 *     OPERATOR_PRIVATE_KEY=0x...      (operator wallet, ≥$0.30 USDC on Arc 5042002)
 *     ARC_RPC_URL=...                 (optional — not used by H1 itself)
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

const FAIRBLOCK_API_URL =
  process.env.FAIRBLOCK_API_URL ?? "https://stabletrust-api.fairblock.network";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const STOA_ARC_CHAIN_ID = 5042002;
const TEST_AMOUNT_BASE_UNITS = "200000"; // $0.20 USDC

interface EnvFile {
  [key: string]: string;
}

/**
 * Parse a .env-style file. Handles UTF-16 LE BOM (PowerShell default on
 * Windows) and UTF-8 BOM transparently. Strips surrounding quotes from
 * values. Ignores blank lines and `#` comments.
 */
function parseEnvFile(path: string): EnvFile {
  const buf = readFileSync(path);
  let text: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString("utf16le");
  } else if (
    buf.length >= 3 &&
    buf[0] === 0xef &&
    buf[1] === 0xbb &&
    buf[2] === 0xbf
  ) {
    text = buf.subarray(3).toString("utf8");
  } else {
    text = buf.toString("utf8");
  }
  const out: EnvFile = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key.startsWith("export ")) {
      out[key.slice(7).trim()] = val;
    } else {
      out[key] = val;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const envPath = resolve(REPO_ROOT, ".env.debug");
  const env = parseEnvFile(envPath);
  // Prefer OPERATOR_PRIVATE_KEY (Phase 1 var name) with a fallback to
  // OPERATOR_PK_FOR_DEBUG (Phase 0 var name) for backward compat with the
  // morning's evidence run.
  const pk = env.OPERATOR_PRIVATE_KEY || env.OPERATOR_PK_FOR_DEBUG;
  if (!pk || !pk.startsWith("0x")) {
    console.error(
      `❌ Missing OPERATOR_PRIVATE_KEY in .env.debug. Found keys: [${Object.keys(env).join(", ")}]`,
    );
    process.exit(1);
  }
  const operatorAddress = privateKeyToAccount(pk as Hex).address;

  console.log(`╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  Fairblock StableTrust — Path 1 diagnostic                  ║`);
  console.log(`║  H1: chainId: 5042002 in HTTP body                          ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);
  console.log(`Operator address: ${operatorAddress}`);
  console.log(`Fairblock API:    ${FAIRBLOCK_API_URL}`);
  console.log(`Endpoint:         POST /deposit`);
  console.log(`Token:            ${ARC_USDC} (Stoa's Arc Testnet USDC)`);
  console.log(`Amount:           ${TEST_AMOUNT_BASE_UNITS} ($0.20)`);
  console.log(`chainId:          ${STOA_ARC_CHAIN_ID} (Stoa's Arc Testnet)`);
  console.log("");

  const body = {
    privateKey: pk,
    tokenAddress: ARC_USDC,
    amount: TEST_AMOUNT_BASE_UNITS,
    waitForFinalization: true,
    chainId: STOA_ARC_CHAIN_ID,
  };
  const requestBodyForLog = { ...body, privateKey: "0x[MASKED]" };
  console.log(`Request body (privateKey masked):`);
  console.log(JSON.stringify(requestBodyForLog, null, 2));
  console.log("");

  const startMs = Date.now();
  let status: number | "no-response" = "no-response";
  let responseText = "";
  const responseHeaders: Record<string, string> = {};
  let errorMessage: string | null = null;

  try {
    const url = `${FAIRBLOCK_API_URL}/deposit`;
    console.log(`POSTing to ${url}...`);
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    status = resp.status;
    resp.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });
    responseText = await resp.text();
  } catch (e) {
    errorMessage = (e as Error).message;
  }
  const elapsedMs = Date.now() - startMs;

  console.log("");
  console.log(`────────────────────────────────────────────────────────────`);
  console.log(`RESPONSE (after ${elapsedMs}ms)`);
  console.log(`────────────────────────────────────────────────────────────`);
  console.log(`status:  ${status}`);
  console.log(`headers:`);
  for (const [k, v] of Object.entries(responseHeaders)) {
    console.log(`  ${k}: ${v}`);
  }
  if (errorMessage) {
    console.log(`network error: ${errorMessage}`);
  } else {
    console.log(`body:`);
    console.log(responseText);
  }

  // ── Decode the RLP target chain (if present) ─────────────────────────────
  // The Base Sepolia error embeds the failed transaction RLP as
  // "transaction=\"0x02f8d183014a34...\"". Extract the chain ID hex from
  // bytes 5-7 of the RLP (after EIP-1559 prefix + outer list length).
  const rlpMatch = /transaction=\\?"0x02[a-fA-F0-9]+/.exec(responseText);
  let observedChain: { hex: string; decimal: number } | null = null;
  if (rlpMatch) {
    const rlpHex = rlpMatch[0].replace(/^transaction=\\?"/, "");
    // EIP-1559: 0x02 (type) + outer list (f8 LL) + chainId (83 BB BB BB or 82 BB BB)
    // The byte right after f8XX is the chainId length prefix; safe parse:
    const afterPrefix = rlpHex.slice(6); // skip "0x02f8XX"
    const lenByte = parseInt(afterPrefix.slice(0, 2), 16); // 0x80 + n
    const n = lenByte - 0x80;
    if (n >= 1 && n <= 8) {
      const chainHex = afterPrefix.slice(2, 2 + n * 2);
      const chainDecimal = parseInt(chainHex, 16);
      observedChain = { hex: `0x${chainHex}`, decimal: chainDecimal };
    }
  }
  if (observedChain) {
    console.log("");
    console.log(
      `[diagnostic] API attempted tx on chain ${observedChain.hex} = ${observedChain.decimal}` +
        (observedChain.decimal === STOA_ARC_CHAIN_ID
          ? ` (Stoa's Arc Testnet — chainId param WAS respected)`
          : observedChain.decimal === 84532
            ? ` (Base Sepolia — chainId param was IGNORED)`
            : ` (unexpected chain)`),
    );
  }

  // ── Save evidence for the GitHub issue ──────────────────────────────────
  const evidenceDir = resolve(REPO_ROOT, "docs");
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = resolve(evidenceDir, "fairblock-arc-test-response.txt");
  const evidence = [
    `# Fairblock StableTrust API — Path 1 diagnostic response`,
    `# Generated: ${new Date().toISOString()}`,
    ``,
    `Request:`,
    `  POST ${FAIRBLOCK_API_URL}/deposit`,
    `  Content-Type: application/json`,
    `  body: ${JSON.stringify(requestBodyForLog)}`,
    ``,
    `Response:`,
    `  status: ${status}`,
    `  elapsed_ms: ${elapsedMs}`,
    `  headers: ${JSON.stringify(responseHeaders, null, 2)}`,
    `  body:`,
    responseText
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
    ``,
    errorMessage ? `Network error: ${errorMessage}` : "",
    observedChain
      ? `Observed target chain: ${observedChain.hex} = ${observedChain.decimal}`
      : "",
    ``,
  ].join("\n");
  writeFileSync(evidencePath, evidence, { encoding: "utf8" });
  console.log("");
  console.log(`Evidence saved to: ${evidencePath}`);
}

main().catch((e: Error) => {
  console.error(`Unhandled: ${e.message}\n${e.stack ?? ""}`);
  process.exit(1);
});
