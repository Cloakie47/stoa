/**
 * Calibration v1.2 — gate / slope / ensemble-PASS-preservation tests.
 *
 * v1.2 changes from v1.1 covered here:
 *   - extreme-prior gate widened to [0.20, 0.80]
 *   - sports_long slope lowered 1.30 → 1.10
 *   - ensemble PASS verdict is NEVER flipped to BUY by calibration
 */
import { describe, expect, it } from "vitest";

import {
  applyCalibration,
  CALIBRATION_GATE_HIGH,
  CALIBRATION_GATE_LOW,
  CALIBRATION_POLICY_VERSION,
} from "../src/calibration.js";

describe("calibration v1.2 — gate + slope", () => {
  it("ships v1.2-2026-05-18 with [0.20, 0.80] gate", () => {
    expect(CALIBRATION_POLICY_VERSION).toBe("calibration-v1.2-2026-05-18");
    expect(CALIBRATION_GATE_LOW).toBe(0.2);
    expect(CALIBRATION_GATE_HIGH).toBe(0.8);
  });

  it("gates raw_p below 0.20 (no slope applied)", () => {
    // raw_p in the co-favorite tournament band where the slope would
    // manufacture an edge the ensemble didn't see.
    const r = applyCalibration({
      raw_p: 0.18,
      domain: "sports_long",
      market_p: 0.185,
      ensemble_signal: "PASS",
    });
    expect(r.adjusted_p_yes).toBe(0.18);
    expect(r.adjustment.adjustment_applied).toBe(0);
  });

  it("gates raw_p above 0.80 (symmetric high end)", () => {
    const r = applyCalibration({
      raw_p: 0.85,
      domain: "long_horizon_any",
      market_p: 0.84,
      ensemble_signal: "PASS",
    });
    expect(r.adjusted_p_yes).toBe(0.85);
    expect(r.adjustment.adjustment_applied).toBe(0);
  });

  it("uses sports_long slope = 1.10 (was 1.30 in v1.1)", () => {
    // raw_p=0.30 is above the gate; ensemble BUY so no cap.
    const r = applyCalibration({
      raw_p: 0.3,
      domain: "sports_long",
      market_p: 0.5,
      ensemble_signal: "NO",
    });
    // 0.5 + 1.10*(0.30 - 0.50) = 0.5 - 0.22 = 0.28
    expect(r.adjusted_p_yes).toBeCloseTo(0.28, 5);
    // No more aggressive 0.24 the v1.1 slope produced.
    expect(r.adjusted_p_yes).toBeGreaterThan(0.24);
  });
});

describe("calibration v1.2 — ensemble PASS preservation", () => {
  it("preserves ensemble PASS verdict even when calibration would flip it", () => {
    // The exact scenario from the user spec: co-favorite at 0.175 in a
    // sports_long market. With v1.1 slope 1.30 + gate 0.10/0.90 this used
    // to flip to BUY_NO. v1.2 catches it via the wider gate AND tags the
    // trace with the override label.
    const result = applyCalibration({
      raw_p: 0.175,
      domain: "sports_long",
      ensemble_signal: "PASS",
      market_p: 0.185,
    });
    expect(result.final_signal).toBe("PASS");
    expect(result.calibration_override).toBe("ensemble_pass_preserved");
    expect(result.adjusted_p_capped).toBe(0.175);
  });

  it("caps to raw_p even when slope would have produced a flip", () => {
    // Pick inputs that would actually flip under v1.1 to exercise the
    // override mechanism (not just the gate). raw_p above the new gate
    // so the slope DOES apply, and the calibrated candidate would
    // produce a BUY verdict.
    const r = applyCalibration({
      raw_p: 0.3,
      domain: "sports_long",
      market_p: 0.2,
      ensemble_signal: "PASS",
    });
    // Slope-adjusted candidate is 0.28, edge 8¢ vs market 0.20 → BUY_YES
    // would-be verdict. Override fires, cap to raw_p, final PASS.
    expect(r.adjusted_p_yes).toBeCloseTo(0.28, 5);
    expect(r.adjusted_p_capped).toBe(0.3);
    expect(r.final_signal).toBe("PASS");
    expect(r.calibration_override).toBe("ensemble_pass_preserved");
    expect(r.adjustment.adjustment_applied_capped).toBe(0);
  });

  it("does NOT prevent BUY_YES when ensemble was already BUY_YES", () => {
    // Ensemble said BUY — calibration is free to strengthen / weaken the
    // edge. Cap MUST NOT fire (no override label).
    const r = applyCalibration({
      raw_p: 0.6,
      domain: "long_horizon_any",
      market_p: 0.4,
      ensemble_signal: "YES",
    });
    // 0.5 + 1.10*(0.6-0.5) = 0.61
    expect(r.adjusted_p_yes).toBeCloseTo(0.61, 5);
    expect(r.adjusted_p_capped).toBeCloseTo(0.61, 5);
    expect(r.final_signal).toBe("YES");
    expect(r.calibration_override).toBe(null);
    // Effective bps matches the raw shift — no cap.
    expect(r.adjustment.adjustment_applied_capped).toBe(
      r.adjustment.adjustment_applied,
    );
  });

  it("does NOT prevent BUY_NO when ensemble was already BUY_NO", () => {
    // Mirror of the above for the NO side.
    const r = applyCalibration({
      raw_p: 0.3,
      domain: "long_horizon_any",
      market_p: 0.55,
      ensemble_signal: "NO",
    });
    // Edge stays clearly negative; verdict NO; no override.
    expect(r.final_signal).toBe("NO");
    expect(r.calibration_override).toBe(null);
  });

  it("pins both raw and capped bps to the trace adjustment record", () => {
    const r = applyCalibration({
      raw_p: 0.3,
      domain: "sports_long",
      market_p: 0.2,
      ensemble_signal: "PASS",
    });
    // Slope shifted raw 0.30 → candidate 0.28 (delta -200 bps), but
    // the capped value is 0 because PASS was preserved.
    expect(r.adjustment.adjustment_applied).toBeCloseTo(-200, 0);
    expect(r.adjustment.adjustment_applied_capped).toBe(0);
    expect(r.adjustment.calibration_override).toBe("ensemble_pass_preserved");
    expect(r.adjustment.raw_model_p_yes).toBe(0.3);
    expect(r.adjustment.policy_version).toBe(CALIBRATION_POLICY_VERSION);
  });
});

describe("calibration v1.2 — FIFA-like scenario (the bug this shipped to fix)", () => {
  it("preserves PASS on France-style co-favorite in [0.10, 0.25] band", () => {
    // The bug: ensemble said PASS on France (raw_p ≈ 0.175, market 0.185)
    // but the v1.1 sports_long slope 1.30 flipped it to BUY_NO. v1.2's
    // wider gate prevents the slope from applying at all; the override
    // label ensures the trace records what we did.
    for (const raw_p of [0.114, 0.167, 0.185, 0.21, 0.25]) {
      const r = applyCalibration({
        raw_p,
        domain: "sports_long",
        market_p: raw_p, // market exactly at model — perfect PASS scenario
        ensemble_signal: "PASS",
      });
      expect(r.final_signal).toBe("PASS");
      expect(r.calibration_override).toBe("ensemble_pass_preserved");
      expect(r.adjusted_p_capped).toBe(raw_p);
    }
  });
});
