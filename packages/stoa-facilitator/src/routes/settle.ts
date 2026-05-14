import type { Context } from "hono";
import type { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { NonceStore } from "../nonce/types.js";
import { extractNonce } from "../nonce/extract.js";
import { STOA_SPLIT_SCHEME, settleStoaSplit } from "../schemes/evm/stoa-split.js";
import type { StoaSplitPayload, StoaSplitRequirements } from "../schemes/evm/stoa-split-types.js";
import type { FacilitatorBundle } from "../schemes/registry.js";

/**
 * Handles `POST /settle`.
 *
 * Dispatches based on `paymentRequirements.scheme`:
 *  - `stoa-split-evm` → routes through Stoa's StoaSettler contract for
 *    atomic verify+split+settle (see contracts/src/StoaSettler.sol).
 *  - anything else → delegates to upstream `facilitator.settle`, which
 *    handles the canonical schemes ("exact", etc.).
 *
 * After successful settlement, the nonce is stored in the configured
 * `NonceStore` to prevent replay.
 */
export function handleSettle(bundle: FacilitatorBundle, nonceStore: NonceStore) {
  const { facilitator, stoaSplitHandlers } = bundle;
  return async (c: Context) => {
    let paymentPayload: PaymentPayload | undefined;

    try {
      const body = (await c.req.json()) as {
        paymentPayload?: PaymentPayload;
        paymentRequirements?: PaymentRequirements;
      };
      paymentPayload = body.paymentPayload;

      if (!body.paymentPayload || !body.paymentRequirements) {
        return c.json({ error: "Missing paymentPayload or paymentRequirements" }, 400);
      }

      let response: SettleResponse;

      if (body.paymentRequirements.scheme === STOA_SPLIT_SCHEME) {
        const handler = stoaSplitHandlers.get(body.paymentRequirements.network);
        if (!handler) {
          return c.json(
            {
              success: false,
              network: body.paymentRequirements.network,
              transaction: "",
              errorReason: `stoa_split_unsupported_network:${body.paymentRequirements.network}`,
            },
            200,
          );
        }
        const stoaResp = await settleStoaSplit(
          handler,
          body.paymentPayload.payload as unknown as StoaSplitPayload,
          body.paymentRequirements as unknown as StoaSplitRequirements,
        );
        response = stoaResp as unknown as SettleResponse;
      } else {
        response = await facilitator.settle(body.paymentPayload, body.paymentRequirements);
      }

      // Store nonce after successful settlement to prevent replay
      if (response.success) {
        const nonce = extractNonce(body.paymentPayload);
        if (nonce) {
          await nonceStore.set(nonce);
        }
      }

      return c.json(response);
    } catch (error) {
      // Handle settlement abort from hooks
      if (error instanceof Error && error.message.includes("Settlement aborted:")) {
        const abortResponse: SettleResponse = {
          success: false,
          errorReason: error.message.replace("Settlement aborted: ", ""),
          network: (paymentPayload?.accepted?.network ?? "unknown") as `${string}:${string}`,
          transaction: "",
        };
        return c.json(abortResponse);
      }

      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 500);
    }
  };
}

// Re-export for the bundle to be the public type, not the raw class instance.
export type { x402Facilitator };
