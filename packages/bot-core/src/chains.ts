/**
 * Chain definitions for the Stoa bot. Arc Testnet isn't in viem's default
 * registry so we define it via `defineChain`. Base mainnet is imported as-is.
 */
import { defineChain, type Chain } from "viem";
import { base } from "viem/chains";

import type { BotCoreConfig } from "./config.js";

export const arcTestnet: Chain = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

export { base };

export function arcRpc(cfg: BotCoreConfig): string {
  return cfg.ARC_TESTNET_RPC;
}
export function baseRpc(cfg: BotCoreConfig): string {
  return cfg.BASE_RPC;
}
