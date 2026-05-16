/**
 * HMAC-SHA256 sign/verify — Node version. Mirrors apps/bot/src/hmac.ts; both
 * use the Web Crypto API (available in Node 20+ as `globalThis.crypto`).
 *
 * Wire format:
 *   X-Stoa-Timestamp: unix-seconds at sign time
 *   X-Stoa-Signature: hex(HMAC-SHA256(secret, `${timestamp}.${body}`))
 */
import type { webcrypto } from "node:crypto";

type CryptoKey = webcrypto.CryptoKey;

const REPLAY_WINDOW_SECONDS = 300;

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    "raw",
    enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function bytesToHex(b: Uint8Array): string {
  let h = "";
  for (let i = 0; i < b.length; i++) h += b[i]!.toString(16).padStart(2, "0");
  return h;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex string must be even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface SignedHeaders {
  "X-Stoa-Timestamp": string;
  "X-Stoa-Signature": string;
}

export async function signRequest(
  body: string,
  secret: string,
): Promise<SignedHeaders> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const key = await importHmacKey(secret);
  const payload = new TextEncoder().encode(`${ts}.${body}`);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      payload.buffer.slice(
        payload.byteOffset,
        payload.byteOffset + payload.byteLength,
      ) as ArrayBuffer,
    ),
  );
  return {
    "X-Stoa-Timestamp": ts,
    "X-Stoa-Signature": bytesToHex(sig),
  };
}

export async function verifyRequest(args: {
  body: string;
  timestamp: string | null;
  signature: string | null;
  secret: string;
}): Promise<void> {
  const { body, timestamp, signature, secret } = args;
  if (!timestamp || !signature) {
    throw new Error("missing HMAC headers");
  }
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) throw new Error("invalid timestamp header");
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) {
    throw new Error(`timestamp outside replay window (${now - ts}s)`);
  }
  const key = await importHmacKey(secret);
  const payload = new TextEncoder().encode(`${timestamp}.${body}`);
  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(signature);
  } catch {
    throw new Error("signature header is not hex");
  }
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes.buffer.slice(
      sigBytes.byteOffset,
      sigBytes.byteOffset + sigBytes.byteLength,
    ) as ArrayBuffer,
    payload.buffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.byteLength,
    ) as ArrayBuffer,
  );
  if (!ok) throw new Error("HMAC signature mismatch");
}
