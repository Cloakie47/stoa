/**
 * Domain-keyed calibration policy v1.0.
 *
 * Takes the raw model_p_yes the Judge ensemble produced (median across runs)
 * plus a domain classification from the Judge itself, and returns an
 * adjusted_p_yes. The shifts are small, deterministic, and reasoned from
 * the Metaculus + academic forecasting literature:
 *
 *   - sports_long  (>30 days): markets are overconfident on favorites;
 *                  damp |p − 0.5| by 0.74 (arxiv 2602.19520 slope 1.74).
 *   - weather_short: markets overconfident short-term; damp by 0.85.
 *   - crypto_price: high noise; damp extremes by 0.95.
 *   - long_horizon_any (>30 days, no other match): damp extremes by 0.95
 *                  (universal long-horizon underconfidence).
 *   - other domains: no adjustment.
 *
 * The damp factor pulls |p − 0.5| toward 0 by `factor`. A factor of 1.0
 * is a no-op; <1 dampens; >1 sharpens (we never sharpen).
 *
 * Policy version string is pinned in the trace, so when v1.1 ships the
 * audit log can show which policy was in effect.
 */
import type {
  CalibrationAdjustment,
  CalibrationDomain,
} from "@stoa/insight-engine";

/** Pinned in the trace; bump when shifts change. */
export const CALIBRATION_POLICY_VERSION = "calibration-v1.0-2026-05-17";

const SPORTS_LONG_FACTOR = 0.74;
const WEATHER_SHORT_FACTOR = 0.85;
const CRYPTO_PRICE_FACTOR = 0.95;
const LONG_HORIZON_FACTOR = 0.95;

/** Pull p toward 0.5 by `factor`. factor=1 → identity. factor=0 → 0.5. */
function dampTowardCenter(p: number, factor: number): number {
  const distance = p - 0.5;
  return 0.5 + distance * factor;
}

export interface ApplyCalibrationArgs {
  raw_model_p_yes: number;
  domain: CalibrationDomain;
  hours_to_resolution?: number;
  /** Reason text supplied by the Judge — preserved verbatim in the trace. */
  judge_reason?: string;
}

export interface ApplyCalibrationResult {
  adjusted_p_yes: number;
  adjustment: CalibrationAdjustment;
}

/**
 * Apply the v1.0 calibration policy. Returns both the adjusted probability
 * AND the full CalibrationAdjustment record (for pinning into the trace).
 */
export function applyCalibration(
  args: ApplyCalibrationArgs,
): ApplyCalibrationResult {
  const { raw_model_p_yes, domain, hours_to_resolution, judge_reason } = args;
  const isLongHorizon =
    typeof hours_to_resolution === "number" && hours_to_resolution > 24 * 30;

  let factor = 1.0;
  let reason = `Domain "${domain}" — no calibration adjustment applied.`;

  switch (domain) {
    case "sports_short":
      // Well-calibrated category — no adjustment.
      break;
    case "sports_long":
      factor = SPORTS_LONG_FACTOR;
      reason = `Sports markets >30 days are overconfident on favorites (arxiv 2602.19520). Damping |p−0.5| by ${SPORTS_LONG_FACTOR}.`;
      break;
    case "weather_short":
      factor = WEATHER_SHORT_FACTOR;
      reason = `Short-horizon weather markets overstate extremes. Damping |p−0.5| by ${WEATHER_SHORT_FACTOR}.`;
      break;
    case "politics":
      // No adjustment on Polymarket (the published effect is Kalshi-specific).
      reason = "Politics on Polymarket — no calibration adjustment (Kalshi-specific effect).";
      break;
    case "tech_demo":
      // No adjustment.
      break;
    case "crypto_price":
      factor = CRYPTO_PRICE_FACTOR;
      reason = `Crypto-price markets are noisy. Damping |p−0.5| by ${CRYPTO_PRICE_FACTOR}.`;
      break;
    case "geopolitics":
    case "entertainment":
      // No adjustment — too few data points to commit to a shift.
      break;
    case "long_horizon_any":
      factor = LONG_HORIZON_FACTOR;
      reason = `Long-horizon markets are universally underconfident. Damping |p−0.5| by ${LONG_HORIZON_FACTOR}.`;
      break;
    case "other":
    default:
      // Apply long-horizon damp as a catch-all if we know the horizon.
      if (isLongHorizon) {
        factor = LONG_HORIZON_FACTOR;
        reason = `Unclassified market >30 days to resolution — applying long-horizon damp ${LONG_HORIZON_FACTOR}.`;
      }
      break;
  }

  const adjusted_p_yes = dampTowardCenter(raw_model_p_yes, factor);
  const adjustment_bps = Math.round((adjusted_p_yes - raw_model_p_yes) * 10_000);

  return {
    adjusted_p_yes,
    adjustment: {
      domain,
      adjustment_applied: adjustment_bps,
      reason: judge_reason ? `${judge_reason} ${reason}` : reason,
      policy_version: CALIBRATION_POLICY_VERSION,
      raw_model_p_yes,
    },
  };
}
