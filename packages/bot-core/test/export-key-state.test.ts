/**
 * Unit tests for the in-memory /export_key pending-confirmation store.
 *
 * The store is a pure function over a caller-supplied Map and clock, so
 * everything is deterministically testable without touching grammY, D1,
 * or the Web Crypto API.
 *
 * NOT covered in this file (left for V1.0 manual / V1.1 integration):
 *   - Group-chat refusal (lives in apps/bot/src/commands/export_key.ts;
 *     trivially verifiable by reading the `chatType !== "private"` branch).
 *   - Audit-log insertion (depends on D1 binding; verified manually via
 *     `wrangler dev` + SELECT * FROM audit_log).
 *   - Migration 0004 idempotency (guaranteed by `IF NOT EXISTS` clauses
 *     on both the table and the index — same pattern as 0001_init.sql).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  cancelPendingExport,
  consumePendingExport,
  EXPORT_CONFIRM_TTL_MS,
  hasPendingExport,
  makePendingExportStore,
  openPendingExport,
  type ExportKeyClock,
  type PendingExportStore,
} from "../src/export-key-state.js";

class FakeClock implements ExportKeyClock {
  constructor(public t: number = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

const USER_A = 1111;
const USER_B = 2222;

describe("openPendingExport / consumePendingExport", () => {
  let store: PendingExportStore;
  let clock: FakeClock;
  beforeEach(() => {
    store = makePendingExportStore();
    clock = new FakeClock(1_000_000);
  });

  it("consumes a fresh confirmation as 'ok'", () => {
    openPendingExport(store, USER_A, EXPORT_CONFIRM_TTL_MS, clock);
    expect(consumePendingExport(store, USER_A, clock)).toEqual({ kind: "ok" });
  });

  it("returns 'expired' when the 60s window has elapsed", () => {
    openPendingExport(store, USER_A, EXPORT_CONFIRM_TTL_MS, clock);
    clock.advance(EXPORT_CONFIRM_TTL_MS);
    expect(consumePendingExport(store, USER_A, clock)).toEqual({
      kind: "expired",
    });
  });

  it("returns 'expired' even with a 1ms overshoot", () => {
    openPendingExport(store, USER_A, EXPORT_CONFIRM_TTL_MS, clock);
    clock.advance(EXPORT_CONFIRM_TTL_MS + 1);
    expect(consumePendingExport(store, USER_A, clock)).toEqual({
      kind: "expired",
    });
  });

  it("returns 'ok' just before the deadline (TTL - 1ms)", () => {
    openPendingExport(store, USER_A, EXPORT_CONFIRM_TTL_MS, clock);
    clock.advance(EXPORT_CONFIRM_TTL_MS - 1);
    expect(consumePendingExport(store, USER_A, clock)).toEqual({ kind: "ok" });
  });

  it("returns 'none' when nothing was opened", () => {
    expect(consumePendingExport(store, USER_A, clock)).toEqual({ kind: "none" });
  });

  it("cannot consume the same pending entry twice", () => {
    openPendingExport(store, USER_A, EXPORT_CONFIRM_TTL_MS, clock);
    expect(consumePendingExport(store, USER_A, clock)).toEqual({ kind: "ok" });
    expect(consumePendingExport(store, USER_A, clock)).toEqual({ kind: "none" });
  });

  it("isolates state between users", () => {
    openPendingExport(store, USER_A, EXPORT_CONFIRM_TTL_MS, clock);
    expect(consumePendingExport(store, USER_B, clock)).toEqual({ kind: "none" });
    expect(consumePendingExport(store, USER_A, clock)).toEqual({ kind: "ok" });
  });

  it("re-opening replaces the old expiresAt, extending the window", () => {
    openPendingExport(store, USER_A, EXPORT_CONFIRM_TTL_MS, clock);
    clock.advance(EXPORT_CONFIRM_TTL_MS - 1); // 59.999s in
    openPendingExport(store, USER_A, EXPORT_CONFIRM_TTL_MS, clock); // resets clock
    clock.advance(EXPORT_CONFIRM_TTL_MS - 1); // 59.999s past the re-open
    expect(consumePendingExport(store, USER_A, clock)).toEqual({ kind: "ok" });
  });
});

describe("cancelPendingExport — 'wrong second message' invalidation", () => {
  let store: PendingExportStore;
  let clock: FakeClock;
  beforeEach(() => {
    store = makePendingExportStore();
    clock = new FakeClock(1_000_000);
  });

  it("cancels an open pending so a subsequent consume returns 'none'", () => {
    openPendingExport(store, USER_A, EXPORT_CONFIRM_TTL_MS, clock);
    expect(cancelPendingExport(store, USER_A)).toBe(true);
    expect(consumePendingExport(store, USER_A, clock)).toEqual({ kind: "none" });
  });

  it("returns false when there is nothing to cancel", () => {
    expect(cancelPendingExport(store, USER_A)).toBe(false);
  });

  it("is safe to call repeatedly", () => {
    openPendingExport(store, USER_A, EXPORT_CONFIRM_TTL_MS, clock);
    expect(cancelPendingExport(store, USER_A)).toBe(true);
    expect(cancelPendingExport(store, USER_A)).toBe(false);
    expect(cancelPendingExport(store, USER_A)).toBe(false);
  });

  it("does not affect other users' pending state", () => {
    openPendingExport(store, USER_A, EXPORT_CONFIRM_TTL_MS, clock);
    openPendingExport(store, USER_B, EXPORT_CONFIRM_TTL_MS, clock);
    cancelPendingExport(store, USER_A);
    expect(consumePendingExport(store, USER_B, clock)).toEqual({ kind: "ok" });
  });
});

describe("hasPendingExport", () => {
  let store: PendingExportStore;
  let clock: FakeClock;
  beforeEach(() => {
    store = makePendingExportStore();
    clock = new FakeClock(1_000_000);
  });

  it("returns true for an open non-expired entry", () => {
    openPendingExport(store, USER_A, EXPORT_CONFIRM_TTL_MS, clock);
    expect(hasPendingExport(store, USER_A, clock)).toBe(true);
  });

  it("returns false (and garbage-collects) for an expired entry", () => {
    openPendingExport(store, USER_A, EXPORT_CONFIRM_TTL_MS, clock);
    clock.advance(EXPORT_CONFIRM_TTL_MS);
    expect(hasPendingExport(store, USER_A, clock)).toBe(false);
    // GC side-effect: a subsequent consume sees 'none', not 'expired'.
    expect(consumePendingExport(store, USER_A, clock)).toEqual({ kind: "none" });
  });

  it("returns false for an unknown user", () => {
    expect(hasPendingExport(store, USER_A, clock)).toBe(false);
  });
});
