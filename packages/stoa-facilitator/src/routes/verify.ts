import type { Context } from "hono";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { NonceStore } from "../nonce/types.js";
import { extractNonce } from "../nonce/extract.js";
import { STOA_SPLIT_SCHEME, verifyStoaSplit } from "../schemes/evm/stoa-split.js";
import type { StoaSplitPayload, StoaSplitRequirements } from "../schemes/evm/stoa-split-types.js";
import type { FacilitatorBundle } from "../schemes/registry.js";

/**
 * Handles `POST /verify`.
 *
 * Dispatches based on `paymentRequirements.scheme`:
 *  - `stoa-split-evm` → runs Stoa's structural verifier (no on-chain call).
 *  - anything else → delegates to upstream `facilitator.verify`.
 *
 * Checks the `NonceStore` for replay protection before verifying in both paths.
 */
export function handleVerify(bundle: FacilitatorBundle, nonceStore: NonceStore) {
  const { facilitator, stoaSplitHandlers } = bundle;
  return async (c: Context) => {
    try {
      const body = (await c.req.json()) as {
        paymentPayload?: PaymentPayload;
        paymentRequirements?: PaymentRequirements;
      };

      if (!body.paymentPayload || !body.paymentRequirements) {
        return c.json({ error: "Missing paymentPayload or paymentRequirements" }, 400);
      }

      const nonce = extractNonce(body.paymentPayload);
      if (nonce) {
        const seen = await nonceStore.has(nonce);
        if (seen) {
          return c.json({ isValid: false, invalidReason: "nonce_already_used" });
        }
      }

      if (body.paymentRequirements.scheme === STOA_SPLIT_SCHEME) {
        const handler = stoaSplitHandlers.get(body.paymentRequirements.network);
        if (!handler) {
          return c.json({
            isValid: false,
            invalidReason: `stoa_split_unsupported_network:${body.paymentRequirements.network}`,
          });
        }
        const result = verifyStoaSplit(
          handler,
          body.paymentPayload.payload as unknown as StoaSplitPayload,
          body.paymentRequirements as unknown as StoaSplitRequirements,
        );
        return c.json(result);
      }

      const response = await facilitator.verify(body.paymentPayload, body.paymentRequirements);
      return c.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 500);
    }
  };
}
