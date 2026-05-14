import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorConfig } from "../types.js";
import { registerEvmSchemes } from "./evm.js";
import { registerSvmSchemes } from "./svm.js";
import { buildStoaSplitHandlers } from "./evm/stoa-split.js";

/**
 * Bundled output of `buildFacilitator`. The upstream `@x402/core` facilitator
 * handles the canonical schemes ("exact", etc.). Stoa's `stoa-split-evm`
 * scheme is layered on top via the `stoaSplitHandlers` map — the route layer
 * dispatches to it based on `paymentRequirements.scheme`.
 */
export interface FacilitatorBundle {
  facilitator: InstanceType<typeof x402Facilitator>;
  stoaSplitHandlers: ReturnType<typeof buildStoaSplitHandlers>;
}

/**
 * Creates an `x402Facilitator` instance and registers scheme handlers
 * based on the provided configuration. Also builds the per-chain handler
 * set for Stoa's split-settlement scheme when configured.
 *
 * @param config - The facilitator configuration.
 * @returns A bundle with the upstream facilitator and Stoa scheme handlers.
 */
export async function buildFacilitator(
  config: FacilitatorConfig,
): Promise<FacilitatorBundle> {
  const facilitator = new x402Facilitator();

  if (config.evm) {
    registerEvmSchemes(facilitator, config.evm);
  }

  if (config.svm) {
    await registerSvmSchemes(facilitator, config.svm);
  }

  const stoaSplitHandlers = config.stoaSplit
    ? buildStoaSplitHandlers(config.stoaSplit)
    : new Map();

  return { facilitator, stoaSplitHandlers };
}
