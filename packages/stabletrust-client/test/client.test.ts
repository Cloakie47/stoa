/**
 * Unit tests for the StableTrust HTTP client + circuit breaker.
 * No network — all tests use an injected fetchImpl mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  StableTrustClient,
  StableTrustError,
  CircuitOpenError,
  _resetStableTrustCircuit,
  _stableTrustCircuitSnapshot,
} from "../src/index.js";

const FAKE_USDC = "0x3600000000000000000000000000000000000000";
const FAKE_PK = "0x" + "ab".repeat(32);
const FAKE_CHAIN_ID = 5042002;
const FAKE_CONTRACT = "0xC011AB1eC0bbA11C0bbA11C0bbA11C0bbA11C0bb";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("StableTrustClient URL construction", () => {
  beforeEach(() => _resetStableTrustCircuit());

  it("strips trailing slashes from baseUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, message: "Deposit successful", tx: "0xdeadbeef" }),
    );
    const c = new StableTrustClient({
      baseUrl: "https://example.com////",
      fetchImpl,
    });
    await c.depositToShield({
      privateKey: FAKE_PK,
      tokenAddress: FAKE_USDC,
      amount: "1000000",
      chainId: FAKE_CHAIN_ID,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://example.com/deposit");
  });

  it("returns the {success, message, tx} envelope verbatim", async () => {
    const wire = {
      success: true,
      message: "Deposit successful",
      tx: "0x9174e8553283821d9501bdc8a5a65fecd7e93b7f7057c280bee6bee20b46499f",
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, wire));
    const c = new StableTrustClient({ baseUrl: "https://x.test", fetchImpl });
    const r = await c.depositToShield({
      privateKey: FAKE_PK,
      tokenAddress: FAKE_USDC,
      amount: "100000",
      chainId: FAKE_CHAIN_ID,
    });
    expect(r).toEqual(wire);
    expect(r.tx).toBe(wire.tx);
  });

  it("sends correct POST body with finalization default true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, tx: "0x1" }),
    );
    const c = new StableTrustClient({ baseUrl: "https://x.test", fetchImpl });
    await c.confidentialTransfer({
      privateKey: FAKE_PK,
      recipientAddress: "0xabc",
      tokenAddress: FAKE_USDC,
      amount: "150000",
      chainId: FAKE_CHAIN_ID,
    });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      privateKey: FAKE_PK,
      recipientAddress: "0xabc",
      tokenAddress: FAKE_USDC,
      amount: "150000",
      chainId: FAKE_CHAIN_ID,
      useOffchainVerify: false,
      waitForFinalization: true,
    });
  });

  it("includes contractAddress in body when provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, tx: "0x2" }),
    );
    const c = new StableTrustClient({ baseUrl: "https://x.test", fetchImpl });
    await c.depositToShield({
      privateKey: FAKE_PK,
      tokenAddress: FAKE_USDC,
      amount: "100000",
      chainId: FAKE_CHAIN_ID,
      contractAddress: FAKE_CONTRACT,
    });
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      privateKey: FAKE_PK,
      tokenAddress: FAKE_USDC,
      amount: "100000",
      chainId: FAKE_CHAIN_ID,
      contractAddress: FAKE_CONTRACT,
      waitForFinalization: true,
    });
  });

  it("threads contractAddress through every endpoint when provided", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      jsonResponse(200, {
        success: true,
        tx: "0x3",
        balance: { total: "0", available: "0", pending: "0" },
      }),
    );
    const c = new StableTrustClient({ baseUrl: "https://x.test", fetchImpl });

    await c.getShieldedBalance({
      privateKey: FAKE_PK,
      tokenAddress: FAKE_USDC,
      chainId: FAKE_CHAIN_ID,
      contractAddress: FAKE_CONTRACT,
    });
    await c.confidentialTransfer({
      privateKey: FAKE_PK,
      recipientAddress: "0xabc",
      tokenAddress: FAKE_USDC,
      amount: "150000",
      chainId: FAKE_CHAIN_ID,
      contractAddress: FAKE_CONTRACT,
    });
    await c.withdrawToPublic({
      privateKey: FAKE_PK,
      tokenAddress: FAKE_USDC,
      amount: "150000",
      chainId: FAKE_CHAIN_ID,
      contractAddress: FAKE_CONTRACT,
    });

    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.contractAddress).toBe(FAKE_CONTRACT);
    }
  });

  it("omits contractAddress from body when absent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, tx: "0x4" }),
    );
    const c = new StableTrustClient({ baseUrl: "https://x.test", fetchImpl });
    await c.depositToShield({
      privateKey: FAKE_PK,
      tokenAddress: FAKE_USDC,
      amount: "100000",
      chainId: FAKE_CHAIN_ID,
    });
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect("contractAddress" in body).toBe(false);
  });

  it("omits contractAddress when empty string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, tx: "0x5" }),
    );
    const c = new StableTrustClient({ baseUrl: "https://x.test", fetchImpl });
    await c.confidentialTransfer({
      privateKey: FAKE_PK,
      recipientAddress: "0xabc",
      tokenAddress: FAKE_USDC,
      amount: "150000",
      chainId: FAKE_CHAIN_ID,
      contractAddress: "",
    });
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect("contractAddress" in body).toBe(false);
  });

  it("respects endpoints override", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { balance: { total: "0", available: "0", pending: "0" } }),
    );
    const c = new StableTrustClient({
      baseUrl: "https://x.test",
      fetchImpl,
      endpoints: { getShieldedBalance: "/v2/balance" },
    });
    await c.getShieldedBalance({
      privateKey: FAKE_PK,
      tokenAddress: FAKE_USDC,
      chainId: FAKE_CHAIN_ID,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://x.test/v2/balance");
  });
});

describe("StableTrustClient error handling", () => {
  beforeEach(() => _resetStableTrustCircuit());

  it("throws StableTrustError with API message on non-2xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { message: "invalid amount" }));
    const c = new StableTrustClient({ baseUrl: "https://x.test", fetchImpl });
    await expect(
      c.depositToShield({
        privateKey: FAKE_PK,
        tokenAddress: FAKE_USDC,
        amount: "0",
        chainId: FAKE_CHAIN_ID,
      }),
    ).rejects.toMatchObject({
      name: "StableTrustError",
      status: 400,
      message: expect.stringContaining("invalid amount"),
    });
  });

  it("falls back to HTTP status when body has no message", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 502 }));
    const c = new StableTrustClient({ baseUrl: "https://x.test", fetchImpl });
    await expect(
      c.getShieldedBalance({
        privateKey: FAKE_PK,
        tokenAddress: FAKE_USDC,
        chainId: FAKE_CHAIN_ID,
      }),
    ).rejects.toMatchObject({
      name: "StableTrustError",
      status: 502,
      message: expect.stringContaining("HTTP 502"),
    });
  });

  it("returns parsed JSON body on 2xx", async () => {
    const balance = {
      balance: { total: "5000000", available: "4500000", pending: "500000" },
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, balance));
    const c = new StableTrustClient({ baseUrl: "https://x.test", fetchImpl });
    const res = await c.getShieldedBalance({
      privateKey: FAKE_PK,
      tokenAddress: FAKE_USDC,
      chainId: FAKE_CHAIN_ID,
    });
    expect(res).toEqual(balance);
  });
});

describe("circuit breaker", () => {
  beforeEach(() => _resetStableTrustCircuit());

  it("trips after 3 consecutive failures within the window", async () => {
    // mockImplementation returns a fresh Response each call — Response bodies
    // are single-read, so a shared instance would throw "Body is unusable"
    // on the second await resp.text().
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => jsonResponse(500, { message: "down" }));
    const c = new StableTrustClient({ baseUrl: "https://x.test", fetchImpl });
    const call = () =>
      c.getShieldedBalance({
        privateKey: FAKE_PK,
        tokenAddress: FAKE_USDC,
        chainId: FAKE_CHAIN_ID,
      });

    await expect(call()).rejects.toBeInstanceOf(StableTrustError);
    await expect(call()).rejects.toBeInstanceOf(StableTrustError);
    await expect(call()).rejects.toBeInstanceOf(StableTrustError);
    expect(_stableTrustCircuitSnapshot().open).toBe(true);

    // Fourth call must fail-fast with CircuitOpenError, NOT invoke fetch.
    await expect(call()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does NOT count CircuitOpenError toward the failure threshold", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => jsonResponse(500, { message: "down" }));
    const c = new StableTrustClient({ baseUrl: "https://x.test", fetchImpl });
    const call = () =>
      c.getShieldedBalance({
        privateKey: FAKE_PK,
        tokenAddress: FAKE_USDC,
        chainId: FAKE_CHAIN_ID,
      });

    await expect(call()).rejects.toBeInstanceOf(StableTrustError);
    await expect(call()).rejects.toBeInstanceOf(StableTrustError);
    await expect(call()).rejects.toBeInstanceOf(StableTrustError);
    // Now open. Subsequent CircuitOpenErrors must not increment the counter.
    const before = _stableTrustCircuitSnapshot().failureCount;
    await expect(call()).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(call()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(_stableTrustCircuitSnapshot().failureCount).toBe(before);
  });

  it("clears state on success after partial failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { message: "down" }))
      .mockResolvedValueOnce(jsonResponse(500, { message: "down" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          balance: { total: "0", available: "0", pending: "0" },
        }),
      );
    const c = new StableTrustClient({ baseUrl: "https://x.test", fetchImpl });
    const call = () =>
      c.getShieldedBalance({
        privateKey: FAKE_PK,
        tokenAddress: FAKE_USDC,
        chainId: FAKE_CHAIN_ID,
      });

    await expect(call()).rejects.toBeInstanceOf(StableTrustError);
    await expect(call()).rejects.toBeInstanceOf(StableTrustError);
    await call();
    expect(_stableTrustCircuitSnapshot()).toEqual({
      failureCount: 0,
      open: false,
    });
  });
});
