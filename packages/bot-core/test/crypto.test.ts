/**
 * Round-trip + tamper-detection tests for the AES-256-GCM private-key
 * encryption layer used by /start (encrypt-on-create) and /export_key
 * (decrypt-on-recovery).
 */
import { describe, expect, it } from "vitest";

import { decryptPrivateKey, encryptPrivateKey } from "../src/crypto.js";

// 32-byte master key (64 hex chars). Test-only value.
const MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// Sample 32-byte private key (viem-style 0x-prefixed).
const SAMPLE_PK =
  "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

describe("encryptPrivateKey + decryptPrivateKey", () => {
  it("encrypts then decrypts to the original key", async () => {
    const ct = await encryptPrivateKey(SAMPLE_PK, MASTER_KEY);
    const pt = await decryptPrivateKey(ct, MASTER_KEY);
    expect(pt).toBe(SAMPLE_PK);
  });

  it("produces a different ciphertext each time (fresh IV)", async () => {
    const a = await encryptPrivateKey(SAMPLE_PK, MASTER_KEY);
    const b = await encryptPrivateKey(SAMPLE_PK, MASTER_KEY);
    expect(a).not.toBe(b);
  });

  it("decryption with the wrong master key throws", async () => {
    const ct = await encryptPrivateKey(SAMPLE_PK, MASTER_KEY);
    const wrong =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    await expect(decryptPrivateKey(ct, wrong)).rejects.toThrow();
  });

  it("rejects a malformed (too-short) ciphertext", async () => {
    await expect(decryptPrivateKey("AAAA", MASTER_KEY)).rejects.toThrow();
  });

  it("returns a 0x-prefixed 66-char hex string (64 hex + 0x)", async () => {
    const ct = await encryptPrivateKey(SAMPLE_PK, MASTER_KEY);
    const pt = await decryptPrivateKey(ct, MASTER_KEY);
    expect(pt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(pt.length).toBe(66);
  });
});
