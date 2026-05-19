/**
 * In-memory circuit breaker for StableTrust API calls.
 *
 * Counts consecutive failures within a rolling 60s window. When the count
 * reaches FAILURE_THRESHOLD (3), the breaker trips and rejects all calls
 * for OPEN_DURATION_MS (5 minutes) WITHOUT hitting the network. After that
 * window elapses, the next call is allowed through ("half-open"); success
 * closes the breaker, failure trips it again.
 *
 * State is module-global (per-process). In Cloudflare Workers each isolate
 * gets its own breaker, which is acceptable for V1 — protects each warm
 * isolate independently. The point isn't perfect coordination, it's
 * preventing 30s HTTP timeouts from cascading into Stoa /analyze latency
 * when Fairblock is down.
 */
import { CircuitOpenError } from "./errors.js";

const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_MS = 60_000;
const OPEN_DURATION_MS = 5 * 60_000;

interface BreakerState {
  failures: number[];
  openedAt: number | null;
}

const state: BreakerState = { failures: [], openedAt: null };

export function isOpen(now: number = Date.now()): boolean {
  if (state.openedAt === null) return false;
  if (now - state.openedAt >= OPEN_DURATION_MS) {
    // Window elapsed — half-open. Clear state; next call decides.
    state.failures = [];
    state.openedAt = null;
    return false;
  }
  return true;
}

export function recordSuccess(): void {
  state.failures = [];
  state.openedAt = null;
}

export function recordFailure(now: number = Date.now()): void {
  state.failures = state.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
  state.failures.push(now);
  if (state.failures.length >= FAILURE_THRESHOLD && state.openedAt === null) {
    state.openedAt = now;
    console.warn(
      `[stabletrust-circuit] tripped after ${state.failures.length} consecutive failures within ${FAILURE_WINDOW_MS / 1000}s — closed for ${OPEN_DURATION_MS / 1000}s`,
    );
  }
}

/**
 * Wrap a single StableTrust call. If the breaker is open, reject with
 * CircuitOpenError WITHOUT invoking fn. Otherwise run fn and record the
 * outcome. The CircuitOpenError lets the caller distinguish "I never tried"
 * from "I tried and Fairblock rejected" — both fall through to public
 * flow, but only the latter counts toward the failure threshold.
 */
export function guard<T>(fn: () => Promise<T>): Promise<T> {
  if (isOpen()) {
    return Promise.reject(new CircuitOpenError());
  }
  return fn().then(
    (v) => {
      recordSuccess();
      return v;
    },
    (e) => {
      recordFailure();
      throw e;
    },
  );
}

/** Testing-only helper — clears breaker state between unit tests. */
export function _resetBreaker(): void {
  state.failures = [];
  state.openedAt = null;
}

/** Testing-only snapshot for assertions. */
export function _snapshot(): { failureCount: number; open: boolean } {
  return { failureCount: state.failures.length, open: state.openedAt !== null };
}
