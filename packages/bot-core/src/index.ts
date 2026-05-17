// Public surface of @stoa/bot-core. Both apps/bot (Cloudflare Worker) and
// apps/analyzer (Railway/Express) import from here.

export type { BotCoreConfig } from "./config.js";
export { feeAnalyzeMicros, feeConfirmMicros } from "./config.js";

export type {
  DbClient,
  WalletRow,
  PreparedOrderRow,
  InsertPreparedOrderRow,
} from "./db-client.js";

export { arcTestnet, base, arcRpc, baseRpc } from "./chains.js";
export { encryptPrivateKey, decryptPrivateKey } from "./crypto.js";

export {
  getOrCreateUserWallet,
  loadUserWallet,
  readUsdcBalanceArc,
  readUsdcBalanceBase,
  withdrawUsdcOnBase,
  type UserWallet,
} from "./wallet.js";

export {
  publicArc,
  operatorWallet,
  fetchUsdcDomain,
  buildSignedAuth,
  splitConfigFromCfg,
  submitSettle,
  payStoaFee,
  type Eip3009Auth,
  type SplitConfig,
  type SettleResult,
} from "./stoa.js";

export {
  runFullAnalysis,
  runSingleLLMPreview,
  type SingleLLMSummary,
  type FullAnalysis,
} from "./insight.js";

export {
  placeMockOrder,
  type MockOrderArgs,
  type MockOrderResult,
} from "./limitless.js";

export { sendTelegramMessage, newRequestId, type ParseMode } from "./telegram.js";

export {
  applyCalibration,
  CALIBRATION_POLICY_VERSION,
  CALIBRATION_GATE_LOW,
  CALIBRATION_GATE_HIGH,
  type ApplyCalibrationArgs,
  type ApplyCalibrationResult,
} from "./calibration.js";

export {
  runAnalyzePipeline,
  runConfirmPipeline,
  type AnalyzePipelineArgs,
  type ConfirmPipelineArgs,
  type AnalyzePipelineResult,
  type ConfirmPipelineResult,
} from "./pipelines.js";
