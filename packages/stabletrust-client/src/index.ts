// Public surface of @stoa/stabletrust-client.

export {
  StableTrustClient,
  STABLETRUST_ENDPOINTS,
  type StableTrustClientOptions,
  type DepositArgs,
  type BalanceArgs,
  type BalanceResponse,
  type TransferArgs,
  type WithdrawArgs,
  type TxReceipt,
} from "./client.js";

export { StableTrustError, CircuitOpenError } from "./errors.js";

export {
  isOpen as isStableTrustCircuitOpen,
  _resetBreaker as _resetStableTrustCircuit,
  _snapshot as _stableTrustCircuitSnapshot,
} from "./circuit-breaker.js";
