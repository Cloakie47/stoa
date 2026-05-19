/**
 * Throwaway: POST a /deposit via raw fetch and log the FULL JSON response
 * so we can fix StableTrustClient.depositToShield's hash extraction.
 *
 * Uses canteen's wallet because (a) canteen still needs to be initialized
 * for Phase 1, and (b) doing it via raw fetch sidesteps the client's
 * buggy receipt.hash assumption. The on-chain deposit will complete
 * regardless of the response shape; we just need to see the wire format.
 *
 * Delete after Phase 1 Step 2 completes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

function parseEnvFile(path: string): Record<string, string> {
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
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq).trim().replace(/^export\s+/, "")] = line
      .slice(eq + 1)
      .trim();
  }
  return out;
}

async function main(): Promise<void> {
  const env = parseEnvFile(resolve(REPO_ROOT, ".env.debug"));
  const pk = env.CANTEEN_PRIVATE_KEY as Hex;
  const addr = privateKeyToAccount(pk).address;
  console.log(`Probing canteen ${addr.slice(0, 6)}…${addr.slice(-4)}`);

  const body = {
    privateKey: pk,
    tokenAddress: "0x3600000000000000000000000000000000000000",
    amount: "100000",
    chainId: 5042002,
    waitForFinalization: true,
  };
  const start = Date.now();
  const resp = await fetch(
    "https://stabletrust-api.fairblock.network/deposit",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const elapsed = Date.now() - start;
  const text = await resp.text();
  console.log(`status: ${resp.status}`);
  console.log(`elapsed: ${elapsed}ms`);
  console.log(`body: ${text}`);

  // Mask the private key before saving evidence.
  const maskedBody = { ...body, privateKey: "0x[MASKED]" };
  const out = [
    `# Fairblock /deposit response shape probe`,
    `# Generated: ${new Date().toISOString()}`,
    ``,
    `Request:`,
    `  POST https://stabletrust-api.fairblock.network/deposit`,
    `  body: ${JSON.stringify(maskedBody)}`,
    ``,
    `Response:`,
    `  status: ${resp.status}`,
    `  elapsed_ms: ${elapsed}`,
    `  body:`,
    text
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
    ``,
  ].join("\n");
  const evidencePath = resolve(
    REPO_ROOT,
    "docs",
    "fairblock-deposit-shape.txt",
  );
  writeFileSync(evidencePath, out, { encoding: "utf8" });
  console.log(`\nSaved to ${evidencePath}`);
}

main().catch((e: Error) => {
  console.error(`Error: ${e.message}\n${e.stack ?? ""}`);
  process.exit(1);
});
