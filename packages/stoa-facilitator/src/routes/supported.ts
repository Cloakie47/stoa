import type { Context } from "hono";
import { STOA_SPLIT_SCHEME } from "../schemes/evm/stoa-split.js";
import type { FacilitatorBundle } from "../schemes/registry.js";

/**
 * Handles `GET /supported`.
 *
 * Returns which networks, schemes, and extensions this facilitator supports,
 * dynamically based on which keys and RPC URLs were configured. The Stoa
 * split-settlement scheme is advertised separately per configured chain.
 */
export function handleSupported(bundle: FacilitatorBundle) {
  const { facilitator, stoaSplitHandlers } = bundle;
  return (c: Context) => {
    const upstream = facilitator.getSupported() as {
      kinds: Array<{ x402Version: number; scheme: string; network: `${string}:${string}` }>;
      extensions?: unknown[];
      signers?: Record<string, string[]>;
    };

    const stoaKinds = Array.from(stoaSplitHandlers.keys()).map((network) => ({
      x402Version: 2,
      scheme: STOA_SPLIT_SCHEME,
      network: network as `${string}:${string}`,
    }));

    return c.json({
      ...upstream,
      kinds: [...upstream.kinds, ...stoaKinds],
    });
  };
}
