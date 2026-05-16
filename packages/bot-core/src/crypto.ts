/**
 * AES-256-GCM encryption for per-user private keys, using the Web Crypto API
 * (available natively in Cloudflare Workers and Node 20+).
 *
 * Master key: 32 bytes (64 hex chars), stored as the `WALLET_ENCRYPTION_KEY`
 * config field — Wrangler secret in the Worker, Railway env var in the
 * analyzer.
 *
 * Storage format (base64-encoded):
 *   [12 bytes IV][N bytes ciphertext][16 bytes auth tag]
 *
 * The auth tag is appended by the Web Crypto API automatically (GCM mode),
 * so callers concat the IV in front and base64 the whole thing.
 */

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("hex string must have even length");
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]!);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function importMasterKey(hex32: string): Promise<CryptoKey> {
  const raw = hexToBytes(hex32);
  if (raw.length !== 32) {
    throw new Error(
      `WALLET_ENCRYPTION_KEY must be 32 bytes (64 hex chars), got ${raw.length}`,
    );
  }
  return crypto.subtle.importKey(
    "raw",
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptPrivateKey(
  privateKeyHex: string,
  masterKeyHex: string,
): Promise<string> {
  const key = await importMasterKey(masterKeyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = hexToBytes(privateKeyHex);
  const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
  const ptBuf = plaintext.buffer.slice(
    plaintext.byteOffset,
    plaintext.byteOffset + plaintext.byteLength,
  ) as ArrayBuffer;
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivBuf }, key, ptBuf),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return bytesToBase64(out);
}

export async function decryptPrivateKey(
  ciphertextB64: string,
  masterKeyHex: string,
): Promise<`0x${string}`> {
  const key = await importMasterKey(masterKeyHex);
  const raw = base64ToBytes(ciphertextB64);
  if (raw.length < 12 + 16) {
    throw new Error("ciphertext too short — expected iv (12) + tag (16) + body");
  }
  const iv = raw.slice(0, 12);
  const body = raw.slice(12);
  const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
  const bodyBuf = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBuf }, key, bodyBuf),
  );
  if (plaintext.length !== 32) {
    throw new Error(`decrypted PK length ${plaintext.length} ≠ 32`);
  }
  let hex = "0x";
  for (let i = 0; i < plaintext.length; i++) {
    hex += plaintext[i]!.toString(16).padStart(2, "0");
  }
  return hex as `0x${string}`;
}
