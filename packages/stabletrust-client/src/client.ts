/**
 * Thin HTTP client for the Fairblock StableTrust confidential-token API.
 *
 * All amounts are STRING base units (e.g. "150000" for $0.15 USDC at 6
 * decimals) — JSON cannot safely carry uint256 as a number, and the
 * StableTrust API treats them as strings end-to-end.
 *
 * Trust model: the API takes the user's PRIVATE KEY directly because
 * StableTrust generates the ZK proofs server-side and requires the key
 * to do so. This is a hard trust assumption on Fairblock's infrastructure
 * — Stoa accepts it as the V1 trade-off for confidential payments. Users
 * who don't trust the API can simply never call /shield; the public
 * fee flow is always available and is the default when STOA_USE_STABLETRUST
 * is false.
 */
import { StableTrustError } from "./errors.js";
import { guard } from "./circuit-breaker.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/** REST paths the client POSTs to. Exported so callers can patch them if
 *  Fairblock's actual paths drift from REST convention. */
export const STABLETRUST_ENDPOINTS = {
  depositToShield: "/deposit-to-shield",
  getShieldedBalance: "/get-shielded-balance",
  confidentialTransfer: "/confidential-transfer",
  withdrawToPublic: "/withdraw-to-public",
} as const;

export interface StableTrustClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to the global fetch (available in both
   *  Node 18+ and Cloudflare Workers). */
  fetchImpl?: typeof fetch;
  /** Override the default REST paths. Useful if Fairblock ships a
   *  versioned URL pattern. */
  endpoints?: Partial<typeof STABLETRUST_ENDPOINTS>;
}

export interface DepositArgs {
  privateKey: string;
  tokenAddress: string;
  amount: string;
  waitForFinalization?: boolean;
}

export interface BalanceArgs {
  privateKey: string;
  tokenAddress: string;
  address?: string;
}

export interface BalanceResponse {
  balance: {
    total: string;
    available: string;
    pending: string;
  };
}

export interface TransferArgs {
  privateKey: string;
  recipientAddress: string;
  tokenAddress: string;
  amount: string;
  useOffchainVerify?: boolean;
  waitForFinalization?: boolean;
}

export interface WithdrawArgs {
  privateKey: string;
  tokenAddress: string;
  amount: string;
  useOffchainVerify?: boolean;
  waitForFinalization?: boolean;
}

export interface TxReceipt {
  receipt: { hash: string };
}

export class StableTrustClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoints: typeof STABLETRUST_ENDPOINTS;

  constructor(opts: StableTrustClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.endpoints = { ...STABLETRUST_ENDPOINTS, ...(opts.endpoints ?? {}) };
  }

  async depositToShield(args: DepositArgs): Promise<TxReceipt> {
    return this.post<TxReceipt>(this.endpoints.depositToShield, {
      privateKey: args.privateKey,
      tokenAddress: args.tokenAddress,
      amount: args.amount,
      waitForFinalization: args.waitForFinalization ?? true,
    });
  }

  async getShieldedBalance(args: BalanceArgs): Promise<BalanceResponse> {
    return this.post<BalanceResponse>(this.endpoints.getShieldedBalance, {
      privateKey: args.privateKey,
      tokenAddress: args.tokenAddress,
      ...(args.address ? { address: args.address } : {}),
    });
  }

  async confidentialTransfer(args: TransferArgs): Promise<TxReceipt> {
    return this.post<TxReceipt>(this.endpoints.confidentialTransfer, {
      privateKey: args.privateKey,
      recipientAddress: args.recipientAddress,
      tokenAddress: args.tokenAddress,
      amount: args.amount,
      useOffchainVerify: args.useOffchainVerify ?? false,
      waitForFinalization: args.waitForFinalization ?? true,
    });
  }

  async withdrawToPublic(args: WithdrawArgs): Promise<TxReceipt> {
    return this.post<TxReceipt>(this.endpoints.withdrawToPublic, {
      privateKey: args.privateKey,
      tokenAddress: args.tokenAddress,
      amount: args.amount,
      useOffchainVerify: args.useOffchainVerify ?? false,
      waitForFinalization: args.waitForFinalization ?? true,
    });
  }

  /**
   * Internal POST helper wrapped in the circuit breaker. Times out at
   * timeoutMs via AbortController; throws StableTrustError on non-2xx with
   * the API error body parsed if present.
   */
  private async post<T>(path: string, body: unknown): Promise<T> {
    return guard(async () => {
      const url = `${this.baseUrl}${path}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const resp = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await resp.text();
        let parsed: unknown = null;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }
        if (!resp.ok) {
          const detail =
            typeof parsed === "object" && parsed !== null && "message" in parsed
              ? String((parsed as { message: unknown }).message)
              : typeof parsed === "string" && parsed.length > 0
                ? parsed
                : `HTTP ${resp.status}`;
          throw new StableTrustError(
            `StableTrust ${path} failed: ${detail}`,
            resp.status,
            parsed,
          );
        }
        return parsed as T;
      } finally {
        clearTimeout(timer);
      }
    });
  }
}
