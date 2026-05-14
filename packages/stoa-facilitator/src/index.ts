import { Hono } from "hono";
import type { FacilitatorConfig } from "./types.js";
import { buildFacilitator } from "./schemes/registry.js";
import { memoryNonceStore } from "./nonce/memory.js";
import { handleSupported } from "./routes/supported.js";
import { handleVerify } from "./routes/verify.js";
import { handleSettle } from "./routes/settle.js";

// Re-export public API
export { kvNonceStore } from "./nonce/kv.js";
export { memoryNonceStore } from "./nonce/memory.js";
export type { NonceStore } from "./nonce/types.js";
export type { FacilitatorConfig, EvmConfig, SvmConfig } from "./types.js";

/**
 * Package version, injected at build time.
 */
const PACKAGE_VERSION = "0.0.1";

/**
 * Creates a mountable Hono sub-app implementing the x402 facilitator protocol.
 *
 * The returned app exposes three routes:
 * - `GET /supported` — networks and schemes this facilitator supports
 * - `POST /verify` — verify a payment payload against requirements
 * - `POST /settle` — settle a payment on-chain
 *
 * Mount it on any Hono app via `app.route()`:
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { x402Facilitator } from "@oviato/x402-facilitator-hono";
 *
 * const app = new Hono();
 *
 * app.route("/facilitator", await x402Facilitator({
 *   evm: {
 *     privateKey: env.EVM_PRIVATE_KEY,
 *     rpcUrls: { "eip155:84532": env.RPC_URL_BASE_SEPOLIA },
 *   },
 * }));
 *
 * export default app;
 * ```
 *
 * @param config - Facilitator configuration specifying chains, keys, and optional nonce store.
 * @returns A Hono sub-app with `/supported`, `/verify`, and `/settle` routes.
 */
export async function x402Facilitator(config: FacilitatorConfig): Promise<Hono> {
  if (!config.evm && !config.svm && !config.stoaSplit) {
    throw new Error("At least one of `evm`, `svm`, or `stoaSplit` must be configured.");
  }

  const bundle = await buildFacilitator(config);
  const nonceStore = config.nonceStore ?? memoryNonceStore();

  const app = new Hono();

  app.get("/", (c) => {
    const upstream = bundle.facilitator.getSupported();
    const stoaKinds = Array.from(bundle.stoaSplitHandlers.keys()).map((network) => ({
      x402Version: 2,
      scheme: "stoa-split-evm",
      network,
    }));
    return c.json({
      name: "@stoa/facilitator",
      version: PACKAGE_VERSION,
      supported: [...upstream.kinds, ...stoaKinds],
      docs: "https://github.com/Cloakie47/stoa",
      fork_of: "@oviato/x402-facilitator-hono",
    });
  });

  app.get("/supported", handleSupported(bundle));
  app.post("/verify", handleVerify(bundle, nonceStore));
  app.post("/settle", handleSettle(bundle, nonceStore));

  return app;
}
