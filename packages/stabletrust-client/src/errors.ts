/**
 * StableTrust-specific error types. Callers MUST distinguish between
 * StableTrustError (a real API failure that we should surface to the user
 * AND count toward the circuit breaker) and CircuitOpenError (we never
 * even attempted the call — fall through to public flow immediately).
 */
export class StableTrustError extends Error {
  public readonly status?: number;
  public readonly body?: unknown;
  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = "StableTrustError";
    this.status = status;
    this.body = body;
  }
}

export class CircuitOpenError extends Error {
  constructor(message = "stabletrust circuit breaker is open — call skipped") {
    super(message);
    this.name = "CircuitOpenError";
  }
}
