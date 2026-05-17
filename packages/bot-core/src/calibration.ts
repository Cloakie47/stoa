/**
 * Domain-keyed calibration policy v1.1.
 *
 * Takes the raw model_p_yes the Judge ensemble produced (median across runs)
 * plus a domain classification from the Judge itself, and returns an
 * adjusted_p_yes. v1.1 reverses the direction of v1.0 — the arxiv 2602.19520
 * regression slope > 1 means market prices are COMPRESSED toward 50% relative
 * to truth, so the bot's bias-corrected estimate should be pushed AWAY from
 * 50%, not toward it. v1.0 had it backwards (damp toward 0.5) which produced
 * the Uzbekistan-World-Cup pathology: a tiny raw prior (~0.01) got pulled to
 * ~0.13, manufacturing a 12-point edge on a $0.002 market.
 *
 * v1.1 also introduces a moderate-prior gate: the paper's slopes are derived
 * from observed prices in the 0.2-0.8 range. Extrapolating to lottery markets
 * (p < 0.10 or p > 0.90) is dangerous, so the policy short-circuits to a
 * no-op for extreme priors.
 *
 *   adjusted_p = 0.5 + slope * (raw_p - 0.5)  // clipped to [0.01, 0.99]
 *   slope > 1 expands away from 0.5; slope < 1 dampens toward 0.5.
 *
 * Slope table (per arxiv 2602.19520 + supplementary literature):
 *   sports_short   1.00  — well-calibrated, no adjustment
 *   sports_long    1.30  — long-horizon markets compress favorites toward 50%
 *   weather_short  0.85  — overconfident short-term (dampening IS correct)
 *   weather_long   1.10  — generic long-horizon underconfidence
 *   politics       1.05  — slight underconfidence on directional bets
 *   tech_demo      1.00  — no academic prior either direction
 *   crypto_price   1.00  — too noisy to commit to a slope
 *   long_horizon_any 1.10 — universal long-horizon expansion
 *   other          1.00
 *
 * Policy version string is pinned in the trace, so when v1.2 ships the audit
 * log can show which policy was in effect.
 */
import type {
  CalibrationAdjustment,
  CalibrationDomain,
} from "@stoa/insight-engine";

/** Pinned in the trace; bump when slopes change. */
export const CALIBRATION_POLICY_VERSION = "calibration-v1.1-2026-05-17";

/** Lower bound of the moderate-prior gate — slopes are not validated below this. */
export const CALIBRATION_GATE_LOW = 0.1;
/** Upper bound of the moderate-prior gate — symmetric with the low side. */
export const CALIBRATION_GATE_HIGH = 0.9;

const SPORTS_LONG_SLOPE = 1.3;
const WEATHER_SHORT_SLOPE = 0.85;
const WEATHER_LONG_SLOPE = 1.1;
const POLITICS_SLOPE = 1.05;
const LONG_HORIZON_SLOPE = 1.1;

/**
 * Slope transformation: adjusted = 0.5 + slope * (raw - 0.5), clipped.
 * slope > 1 pushes AWAY from 0.5 (expansion).
 * slope < 1 pulls TOWARD 0.5 (compression — used for weather_short only).
 * slope = 1 is the identity.
 */
function applySlope(p: number, slope: number): number {
  const adj = 0.5 + slope * (p - 0.5);
  return Math.max(0.01, Math.min(0.99, adj));
}

function slopeForDomain(
  domain: CalibrationDomain,
  isLongHorizon: boolean,
): { slope: number; reason: string } {
  switch (domain) {
    case "sports_short":
      return { slope: 1.0, reason: `Short-horizon sports — well-calibrated, no adjustment (slope 1.0).` };
    case "sports_long":
      return {
        slope: SPORTS_LONG_SLOPE,
        reason: `Long-horizon sports markets compress favorites/longshots toward 50% (arxiv 2602.19520). Expanding |p−0.5| by ${SPORTS_LONG_SLOPE}.`,
      };
    case "weather_short":
      return {
        slope: WEATHER_SHORT_SLOPE,
        reason: `Short-horizon weather markets are overconfident — dampening |p−0.5| by ${WEATHER_SHORT_SLOPE}.`,
      };
    case "weather_long":
      return {
        slope: WEATHER_LONG_SLOPE,
        reason: `Long-horizon weather markets are underconfident — expanding |p−0.5| by ${WEATHER_LONG_SLOPE}.`,
      };
    case "politics":
      return {
        slope: POLITICS_SLOPE,
        reason: `Polymarket politics markets show mild underconfidence on directional bets — expanding |p−0.5| by ${POLITICS_SLOPE}.`,
      };
    case "tech_demo":
      return { slope: 1.0, reason: `Tech demo — no academic prior; slope 1.0.` };
    case "crypto_price":
      return { slope: 1.0, reason: `Crypto price markets are too noisy to commit to a slope; slope 1.0.` };
    case "geopolitics":
    case "entertainment":
      return { slope: 1.0, reason: `Domain "${domain}" — too few data points to commit to a slope.` };
    case "long_horizon_any":
      return {
        slope: LONG_HORIZON_SLOPE,
        reason: `Long-horizon market — universal underconfidence; expanding |p−0.5| by ${LONG_HORIZON_SLOPE}.`,
      };
    case "other":
    default:
      if (isLongHorizon) {
        return {
          slope: LONG_HORIZON_SLOPE,
          reason: `Unclassified market >30 days — applying long-horizon expansion ${LONG_HORIZON_SLOPE}.`,
        };
      }
      return { slope: 1.0, reason: `Domain "${domain}" — no calibration adjustment applied.` };
  }
}

export interface ApplyCalibrationArgs {
  raw_model_p_yes: number;
  domain: CalibrationDomain;
  hours_to_resolution?: number;
  /** Optional raw CI bounds — when supplied, the same slope is applied so the
   *  point estimate stays inside the CI. */
  raw_ci_low?: number;
  raw_ci_high?: number;
  /** Reason text supplied by the Judge — preserved verbatim in the trace. */
  judge_reason?: string;
}

export interface ApplyCalibrationResult {
  adjusted_p_yes: number;
  /** Calibrated CI bound (or the raw value when CI input was not supplied / gate triggered). */
  adjusted_ci_low: number | undefined;
  adjusted_ci_high: number | undefined;
  adjustment: CalibrationAdjustment;
}

/**
 * Apply the v1.1 calibration policy. Returns the adjusted probability, the
 * (matching) CI bounds, and the full CalibrationAdjustment record.
 *
 * Gate: when raw_model_p_yes is outside [0.10, 0.90], the policy is a no-op
 * — slopes are validated for 0.2-0.8 prices in the source paper and
 * extrapolating to lottery markets manufactures spurious edges.
 */
export function applyCalibration(
  args: ApplyCalibrationArgs,
): ApplyCalibrationResult {
  const {
    raw_model_p_yes,
    domain,
    hours_to_resolution,
    raw_ci_low,
    raw_ci_high,
    judge_reason,
  } = args;

  // ── Gate 1: extreme priors get NO adjustment ──────────────────────────────
  // The arxiv 2602.19520 slopes are fitted on observed prices in 0.2-0.8.
  // Extrapolating to lottery markets (Uzbekistan @ 0.002) generates a fake
  // 12-point edge. Short-circuit to a no-op + record the gate in the trace.
  if (raw_model_p_yes < CALIBRATION_GATE_LOW || raw_model_p_yes > CALIBRATION_GATE_HIGH) {
    const gateReason =
      `Raw model estimate (${raw_model_p_yes.toFixed(3)}) outside [${CALIBRATION_GATE_LOW}, ${CALIBRATION_GATE_HIGH}] moderate-prior gate. ` +
      `Calibration policy not applied to extreme priors (arxiv 2602.19520 slopes validated for 0.2-0.8 range).`;
    return {
      adjusted_p_yes: raw_model_p_yes,
      adjusted_ci_low: raw_ci_low,
      adjusted_ci_high: raw_ci_high,
      adjustment: {
        domain,
        adjustment_applied: 0,
        reason: judge_reason ? `${judge_reason} ${gateReason}` : gateReason,
        policy_version: CALIBRATION_POLICY_VERSION,
        raw_model_p_yes,
      },
    };
  }

  // ── Gate 2: within band — apply the domain slope ──────────────────────────
  const isLongHorizon =
    typeof hours_to_resolution === "number" && hours_to_resolution > 24 * 30;
  const { slope, reason } = slopeForDomain(domain, isLongHorizon);

  const adjusted_p_yes = applySlope(raw_model_p_yes, slope);
  const adjusted_ci_low =
    typeof raw_ci_low === "number" && Number.isFinite(raw_ci_low)
      ? applySlope(raw_ci_low, slope)
      : raw_ci_low;
  const adjusted_ci_high =
    typeof raw_ci_high === "number" && Number.isFinite(raw_ci_high)
      ? applySlope(raw_ci_high, slope)
      : raw_ci_high;
  const adjustment_bps = Math.round((adjusted_p_yes - raw_model_p_yes) * 10_000);

  return {
    adjusted_p_yes,
    adjusted_ci_low,
    adjusted_ci_high,
    adjustment: {
      domain,
      adjustment_applied: adjustment_bps,
      reason: judge_reason ? `${judge_reason} ${reason}` : reason,
      policy_version: CALIBRATION_POLICY_VERSION,
      raw_model_p_yes,
    },
  };
}
