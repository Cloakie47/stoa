/**
 * Throwaway diagnostic: read the maintainers wallet's shielded balance
 * to determine whether the previous /deposit-that-looked-failed actually
 * landed on-chain (despite a response shape that broke hash extraction).
 *
 * Delete after Step 2 completes.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { StableTrustClient } from "@stoa/stabletrust-client";
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
  const client = new StableTrustClient({
    baseUrl: "https://stabletrust-api.fairblock.network",
  });

  for (const [label, key] of [
    ["operator", "OPERATOR_PRIVATE_KEY"],
    ["maintainers", "MAINTAINERS_PRIVATE_KEY"],
    ["canteen", "CANTEEN_PRIVATE_KEY"],
  ] as const) {
    const pk = env[key] as Hex;
    const addr = privateKeyToAccount(pk).address;
    const masked = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    const bal = await client.getShieldedBalance({
      privateKey: pk,
      tokenAddress: "0x3600000000000000000000000000000000000000",
      chainId: 5042002,
    });
    console.log(`${label}\t${masked}\t${JSON.stringify(bal.balance)}`);
  }
}

main().catch((e: Error) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
