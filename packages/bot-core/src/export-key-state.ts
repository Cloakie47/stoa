/**
 * In-memory pending /export_key confirmations.
 *
 * Why a Map and not D1: the confirmation window is 60 seconds, which is
 * well within a single warm Cloudflare Workers isolate's lifetime. If the
 * isolate dies between the two messages, the user simply has to /export_key
 * again — no harm, no security regression.
 *
 * Pure functions over a caller-supplied store + clock so this module is
 * deterministically testable. The handler in apps/bot wires this up to a
 * module-level Map and `Date.now`.
 */

export interface PendingExportStore {
  /** Map of telegramUserId → expiresAtMs (unix milliseconds). */
  pending: Map<number, number>;
}

export interface ExportKeyClock {
  now(): number;
}

export const realClock: ExportKeyClock = { now: () => Date.now() };

/** Default TTL: 60 seconds, per V1.0 spec. */
export const EXPORT_CONFIRM_TTL_MS = 60_000;

export function makePendingExportStore(): PendingExportStore {
  return { pending: new Map() };
}

/** Record that the user has invoked /export_key. Caller's TTL is added to
 *  clock.now() to compute expiresAt. Overwrites any prior pending entry
 *  for the same user (rerunning /export_key resets the window). */
export function openPendingExport(
  store: PendingExportStore,
  telegramUserId: number,
  ttlMs: number = EXPORT_CONFIRM_TTL_MS,
  clock: ExportKeyClock = realClock,
): void {
  store.pending.set(telegramUserId, clock.now() + ttlMs);
}

export type ConsumeResult =
  | { kind: "ok" }
  | { kind: "expired" }
  | { kind: "none" };

/** Attempt to consume a pending confirmation. Removes the entry on every
 *  non-`none` return so the confirmation cannot be reused. */
export function consumePendingExport(
  store: PendingExportStore,
  telegramUserId: number,
  clock: ExportKeyClock = realClock,
): ConsumeResult {
  const expiresAt = store.pending.get(telegramUserId);
  if (expiresAt === undefined) return { kind: "none" };
  store.pending.delete(telegramUserId);
  if (clock.now() >= expiresAt) return { kind: "expired" };
  return { kind: "ok" };
}

/** Cancel a pending confirmation. Returns true iff there was one to cancel.
 *  Safe to call repeatedly. */
export function cancelPendingExport(
  store: PendingExportStore,
  telegramUserId: number,
): boolean {
  return store.pending.delete(telegramUserId);
}

export function hasPendingExport(
  store: PendingExportStore,
  telegramUserId: number,
  clock: ExportKeyClock = realClock,
): boolean {
  const expiresAt = store.pending.get(telegramUserId);
  if (expiresAt === undefined) return false;
  if (clock.now() >= expiresAt) {
    store.pending.delete(telegramUserId);
    return false;
  }
  return true;
}
