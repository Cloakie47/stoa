/**
 * Wire format for the `stoa-split-evm` scheme.
 *
 * The payer signs a standard EIP-3009 `transferWithAuthorization` with the
 * StoaSettler contract as the recipient. The facilitator submits that auth
 * along with the merchant's pre-declared split policy, atomically pulling
 * funds and distributing them in one transaction.
 */

import type { PaymentPayload as CorePaymentPayload, PaymentRequirements as CorePaymentRequirements } from "@x402/core/types";

export const STOA_SPLIT_SCHEME = "stoa-split-evm" as const;

/** EIP-3009 transferWithAuthorization fields signed by the payer (un-signed view). */
export interface StoaSplitAuthorization {
  from: `0x${string}`;
  to: `0x${string}`; // must equal the StoaSettler address
  value: string; // decimal string, USDC raw units (6 decimals)
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`; // 32-byte hex, unique per payer per signature
}

/** Payload posted with each stoa-split-evm payment. */
export interface StoaSplitPayload {
  authorization: StoaSplitAuthorization;
  /** 65-byte 0x-prefixed signature over the EIP-3009 typed data. */
  signature: `0x${string}`;
}

/** Per-merchant split policy. Lives inside paymentRequirements.extra. */
export interface StoaSplitExtra {
  recipients: `0x${string}`[];
  bps: number[]; // each entry 1..10_000, must sum to 10_000 (Splitter enforces)
  /** Optional reasoning-trace hash; if zero/omitted, TracePin is skipped. */
  traceHash?: `0x${string}`;
  /** Off-chain trace URI, used only when traceHash is set. */
  ipfsCid?: string;
}

/** Payment requirements for the stoa-split-evm scheme. Drop-in for the core type. */
export interface StoaSplitRequirements extends Omit<CorePaymentRequirements, "scheme" | "extra"> {
  scheme: typeof STOA_SPLIT_SCHEME;
  extra: StoaSplitExtra;
}

/** Settle response — same shape as @x402/core's SettleResponse, narrowed for clarity. */
export interface StoaSplitSettleResponse {
  success: boolean;
  network: `${string}:${string}`;
  transaction: `0x${string}` | "";
  errorReason?: string;
  /** Stoa-specific extension: address of the StoaSettler the tx hit. */
  settler?: `0x${string}`;
}

export type StoaSplitPaymentEnvelope = Omit<CorePaymentPayload, "accepted" | "payload"> & {
  accepted: StoaSplitRequirements;
  payload: StoaSplitPayload;
};
