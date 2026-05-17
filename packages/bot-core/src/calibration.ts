/**
 * Domain-keyed calibration policy v1.2.
 *
 * Takes the raw model_p_yes the Judge ensemble produced (median across runs)
 * plus a domain classification from the Judge itself, and returns an
 * adjusted_p. v1.2 changes vs v1.1:
 *
 *   - Widened extreme-prior gate from [0.10, 0.90] to [0.20, 0.80]. The
 *     arxiv slope is fitted near p≈0.5; co-favorite tournament markets
 *     (France 0.185, Spain 0.167, England 0.114 on the FIFA 2026 event)
 *     sit exactly in 0.10-0.25 where the slope mis-applies and manufactures
 *     edges the ensemble itself doesn't see.
 *
 *   - Lowered sports_long slope 1.30 → 1.10. The 1.30 was an aggressive
 *     read of the arxiv 2602.19520 finding (1.74 on a narrower subset);
 *     for Polymarket-style tournament outright markets 1.10 still pushes
 *     in the right direction without flipping ensemble PASSes.
 *
 *   - Ensemble PASS preservation: when the Judge ensemble's aggregate
 *     signal is PASS, the policy NEVER flips that to BUY_YES/BUY_NO via
 *     a slope adjustment. `adjusted_p_capped` is forced back to `raw_p`,
 *     `final_signal = "PASS"`, and `calibration_override` records
 *     "ensemble_pass_preserved" in the pinned trace. Multi-agent consensus
 *     beats a generic statistical refinement.
 *
 *   adjusted_p = 0.5 + slope * (raw_p - 0.5)  // clipped to [0.01, 0.99]
 *   slope > 1 expands away from 0.5; slope < 1 dampens toward 0.5.
 *
 * Slope table (per arxiv 2602.19520 + supplementary literature):
 *   sports_short   1.00  — well-calibrated, no adjustment
 *   sports_long    1.10  — long-horizon markets compress favorites toward 50%
 *   weather_short  0.85  — overconfident short-term (dampening IS correct)
 *   weather_long   1.10  — generic long-horizon underconfidence
 *   politics       1.05  — slight underconfidence on directional bets
 *   tech_demo      1.00  — no academic prior either direction
 *   crypto_price   1.00  — too noisy to commit to a slope
 *   long_horizon_any 1.10 — universal long-horizon expansion
 *   other          1.00
 *
 * Policy version string is pinned in the trace, so when v1.3 ships the audit
 * log can show which policy was in effect.
 */
import {
  MIN_EDGE_FOR_TRADE,
  type CalibrationAdjustment,
  type CalibrationDomain,
  type Signal,
} from "@stoa/insight-engine";

/** Pinned in the trace; bump when slopes/gate change. */
export const CALIBRATION_POLICY_VERSION = "calibration-v1.2-2026-05-18";

/** Lower bound of the moderate-prior gate — slopes are not validated below this. */
export const CALIBRATION_GATE_LOW = 0.2;
/** Upper bound of the moderate-prior gate — symmetric with the low side. */
export const CALIBRATION_GATE_HIGH = 0.8;

const SPORTS_LONG_SLOPE = 1.1;
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

/**
 * Mirror of `computeJudgeRecommendation`'s verdict logic — but standalone so
 * applyCalibration can derive a would-be verdict from the candidate p without
 * needing a balance / Kelly. Uses the default MIN_EDGE_FOR_TRADE; the demo
 * runtime override (STOA_EDGE_THRESHOLD_BPS) only affects the orchestrator's
 * final Kelly call, not this PASS-flip safety check.
 */
function deriveVerdictFromEdge(
  model_p: number,
  market_p: number,
  threshold: number,
): Signal {
  if (!Number.isFinite(model_p) || model_p <= 0 || model_p >= 1) return "PASS";
  if (!Number.isFinite(market_p) || market_p <= 0 || market_p >= 1) return "PASS";
  const edge = model_p - market_p;
  if (Math.abs(edge) < threshold) return "PASS";
  return edge > 0 ? "YES" : "NO";
}

export interface ApplyCalibrationArgs {
  /** Raw model probability the Judge ensemble emitted (median across runs). */
  raw_p: number;
  domain: CalibrationDomain;
  /** Market YES price — used to detect would-be flips. */
  market_p: number;
  /**
   * Ensemble's aggregate verdict (BEFORE calibration is applied). When this
   * is "PASS", the policy refuses to let a slope adjustment flip it to
   * BUY_YES/BUY_NO — the ensemble's multi-model consensus dominates.
   */
  ensemble_signal: Signal;
  hours_to_resolution?: number;
  /** Optional raw CI bounds — when supplied, the same slope is applied so the
   *  point estimate stays inside the CI. Capped along with the point estimate
   *  when ensemble_pass_preserved fires. */
  raw_ci_low?: number;
  raw_ci_high?: number;
  /** Reason text supplied by the Judge — preserved verbatim in the trace. */
  judge_reason?: string;
}

export interface ApplyCalibrationResult {
  /**
   * Final probability for downstream consumption (after gate, slope, AND
   * ensemble-PASS preservation). Equals `raw_p` when the gate fired OR when
   * the ensemble's PASS verdict was honored.
   */
  adjusted_p_capped: number;
  /** The candidate probability the slope would have produced, BEFORE the
   *  PASS-preservation cap. Identical to `adjusted_p_capped` when no
   *  override fired. Kept for audit. */
  adjusted_p_yes: number;
  /** Calibrated CI bound (matches the point-estimate treatment). */
  adjusted_ci_low: number | undefined;
  adjusted_ci_high: number | undefined;
  /** Post-everything verdict. The orchestrator should USE this rather than
   *  re-deriving from `adjusted_p_capped`. */
  final_signal: Signal;
  /** "ensemble_pass_preserved" when the ensemble's PASS verdict was honored,
   *  null otherwise. The label fires whenever ensemble_signal === "PASS" —
   *  the gate may or may not have prevented a flip on its own. */
  calibration_override: "ensemble_pass_preserved" | null;
  /** Pinned to the trace. Includes both the raw slope shift
   *  (`adjustment_applied`) and the effective shift after preservation
   *  (`adjustment_applied_capped`). */
  adjustment: CalibrationAdjustment;
}

/**
 * Apply the v1.2 calibration policy. Returns the capped probability, the
 * pre-cap candidate probability, matching CI bounds, the final verdict, and
 * the audit record.
 *
 * Gate: when raw_p is outside [0.20, 0.80], the slope is a no-op — the arxiv
 * slope is fitted near 0.5 and extrapolating to lottery / co-favorite markets
 * manufactures spurious edges.
 *
 * Ensemble PASS preservation: when `ensemble_signal === "PASS"`, the result
 * is forced to PASS with `adjusted_p_capped = raw_p`. This is a one-way
 * cap — calibration may STRENGTHEN a BUY edge but cannot CREATE one when
 * the multi-agent ensemble said no.
 */
export function applyCalibration(
  args: ApplyCalibrationArgs,
): ApplyCalibrationResult {
  const {
    raw_p,
    domain,
    market_p,
    ensemble_signal,
    hours_to_resolution,
    raw_ci_low,
    raw_ci_high,
    judge_reason,
  } = args;

  // ── Phase 1: compute the candidate (post-slope, pre-cap) probability ────
  const isLongHorizon =
    typeof hours_to_resolution === "number" && hours_to_resolution > 24 * 30;
  const gateFired = raw_p < CALIBRATION_GATE_LOW || raw_p > CALIBRATION_GATE_HIGH;

  let candidate_p: number;
  let candidate_ci_low: number | undefined;
  let candidate_ci_high: number | undefined;
  let slopeReason: string;
  if (gateFired) {
    candidate_p = raw_p;
    candidate_ci_low = raw_ci_low;
    candidate_ci_high = raw_ci_high;
    slopeReason =
      `Raw model estimate (${raw_p.toFixed(3)}) outside [${CALIBRATION_GATE_LOW}, ${CALIBRATION_GATE_HIGH}] moderate-prior gate. ` +
      `Calibration slope not applied (arxiv 2602.19520 slopes fitted near p≈0.5).`;
  } else {
    const { slope, reason } = slopeForDomain(domain, isLongHorizon);
    candidate_p = applySlope(raw_p, slope);
    candidate_ci_low =
      typeof raw_ci_low === "number" && Number.isFinite(raw_ci_low)
        ? applySlope(raw_ci_low, slope)
        : raw_ci_low;
    candidate_ci_high =
      typeof raw_ci_high === "number" && Number.isFinite(raw_ci_high)
        ? applySlope(raw_ci_high, slope)
        : raw_ci_high;
    slopeReason = reason;
  }

  const adjustmentBpsRaw = Math.round((candidate_p - raw_p) * 10_000);

  // ── Phase 2: derive the would-be verdict + apply ensemble-PASS cap ──────
  const wouldBeVerdict = deriveVerdictFromEdge(
    candidate_p,
    market_p,
    MIN_EDGE_FOR_TRADE,
  );

  let final_signal: Signal;
  let adjusted_p_capped: number;
  let adjusted_ci_low: number | undefined;
  let adjusted_ci_high: number | undefined;
  let calibration_override: "ensemble_pass_preserved" | null;
  let adjustmentBpsCapped: number;
  let capReason = "";

  if (ensemble_signal === "PASS") {
    // Ensemble said PASS — preserve it regardless of what calibration wanted
    // to do. Whether the gate already kept us at raw_p or the slope would
    // have flipped a flip, we ALWAYS cap to raw_p and tag the trace.
    final_signal = "PASS";
    adjusted_p_capped = raw_p;
    adjusted_ci_low = raw_ci_low;
    adjusted_ci_high = raw_ci_high;
    calibration_override = "ensemble_pass_preserved";
    adjustmentBpsCapped = 0;

    if (wouldBeVerdict !== "PASS") {
      // Calibration WOULD have flipped — log loudly so the operator can see
      // the override fired and inspect the flip.
      console.warn(
        `[calibration] WARNING: would have flipped PASS→${wouldBeVerdict} via ${adjustmentBpsRaw} bps adjustment. Honoring ensemble PASS. raw_p=${raw_p.toFixed(4)}, adjusted_p=${candidate_p.toFixed(4)}, capped_p=${raw_p.toFixed(4)}.`,
      );
      capReason = ` Calibration would have flipped PASS→${wouldBeVerdict}; ensemble PASS preserved (cap to raw_p).`;
    } else {
      capReason = ` Ensemble PASS preserved (calibration would not have flipped).`;
    }
  } else {
    // Ensemble was BUY — calibration applies normally. May strengthen the
    // edge, may also reduce it; the orchestrator's Kelly stage handles
    // whatever comes out.
    final_signal = wouldBeVerdict;
    adjusted_p_capped = candidate_p;
    adjusted_ci_low = candidate_ci_low;
    adjusted_ci_high = candidate_ci_high;
    calibration_override = null;
    adjustmentBpsCapped = adjustmentBpsRaw;
  }

  const reason = (judge_reason ? `${judge_reason} ` : "") + slopeReason + capReason;

  return {
    adjusted_p_capped,
    adjusted_p_yes: candidate_p,
    adjusted_ci_low,
    adjusted_ci_high,
    final_signal,
    calibration_override,
    adjustment: {
      domain,
      adjustment_applied: adjustmentBpsRaw,
      adjustment_applied_capped: adjustmentBpsCapped,
      calibration_override,
      reason,
      policy_version: CALIBRATION_POLICY_VERSION,
      raw_model_p_yes: raw_p,
    },
  };
}
