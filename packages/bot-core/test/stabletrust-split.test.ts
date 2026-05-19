import { describe, expect, it } from "vitest";

import { computeSplitLegs } from "../src/stabletrust.js";
import type { Address } from "viem";

const OP = "0x1111111111111111111111111111111111111111" as Address;
const MT = "0x2222222222222222222222222222222222222222" as Address;
const CN = "0x3333333333333333333333333333333333333333" as Address;
const recipients = { operator: OP, maintainers: MT, canteen: CN };

describe("computeSplitLegs", () => {
  it("splits $0.15 exactly into 105k / 30k / 15k", () => {
    const legs = computeSplitLegs(150_000n, recipients);
    expect(legs).toEqual([
      { recipient: OP, amount_micros: 105_000n },
      { recipient: MT, amount_micros: 30_000n },
      { recipient: CN, amount_micros: 15_000n },
    ]);
  });

  it("splits $0.20 exactly into 140k / 40k / 20k", () => {
    const legs = computeSplitLegs(200_000n, recipients);
    expect(legs).toEqual([
      { recipient: OP, amount_micros: 140_000n },
      { recipient: MT, amount_micros: 40_000n },
      { recipient: CN, amount_micros: 20_000n },
    ]);
  });

  it("assigns any rounding remainder to the operator leg", () => {
    // 7 micros: 20% = 1 (truncated from 1.4), 10% = 0 (truncated from 0.7),
    // operator = 7 - 1 - 0 = 6. Sum = 7 exactly.
    const legs = computeSplitLegs(7n, recipients);
    expect(legs.map((l) => l.amount_micros)).toEqual([6n, 1n, 0n]);
    const sum = legs.reduce((s, l) => s + l.amount_micros, 0n);
    expect(sum).toBe(7n);
  });

  it("always sums exactly to the input fee", () => {
    for (const fee of [1n, 7n, 99n, 150_000n, 200_000n, 333_333n, 1_000_000n]) {
      const legs = computeSplitLegs(fee, recipients);
      const sum = legs.reduce((s, l) => s + l.amount_micros, 0n);
      expect(sum).toBe(fee);
    }
  });

  it("preserves recipient addresses in canonical order", () => {
    const legs = computeSplitLegs(150_000n, recipients);
    expect(legs[0]!.recipient).toBe(OP);
    expect(legs[1]!.recipient).toBe(MT);
    expect(legs[2]!.recipient).toBe(CN);
  });
});
