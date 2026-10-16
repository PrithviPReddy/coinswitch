import { describe, expect, it } from "vitest";
import { applyShortfall, decideFill, minOutFor } from "./fill";

const QUOTED = BigInt(105_023_201); // 105.023201 USDC

describe("minOutFor", () => {
  it("is quoted x (1 - bps/10000), rounded up so 'below' is exact", () => {
    // 105023201 x 0.995 = 104498084.995. Jupiter's own otherAmountThreshold
    // for this recorded quote was 104498085 too.
    expect(minOutFor(QUOTED, 50)).toBe(BigInt(104_498_085));
  });
});

describe("applyShortfall", () => {
  it("leaves the quote untouched at 0 bps", () => {
    expect(applyShortfall(QUOTED, 0)).toBe(QUOTED);
  });

  it("keeps fractional bps instead of rounding them away", () => {
    // 105023201 x (1 - 0.00125) = 104891921.998..., rounded up.
    expect(applyShortfall(QUOTED, 12.5)).toBe(BigInt(104_891_922));
  });

  it("pays above the quote for a negative shortfall, since drift runs both ways", () => {
    // 105023201 x 1.0001, rounded up.
    expect(applyShortfall(QUOTED, -1)).toBe(BigInt(105_033_704));
  });

  it("refuses a shortfall of 100% or more in either direction", () => {
    expect(() => applyShortfall(QUOTED, 10_000)).toThrow();
    expect(() => applyShortfall(QUOTED, -10_000)).toThrow();
    expect(() => applyShortfall(QUOTED, Number.NaN)).toThrow();
  });
});

describe("decideFill", () => {
  it("pays the quote exactly in exact mode, whatever shortfall is passed", () => {
    const fill = decideFill({ quotedOut: QUOTED, slippageBps: 50, mode: "exact", shortfallBps: 999 });
    expect(fill).toMatchObject({
      mode: "exact",
      fillOut: QUOTED,
      shortfallBps: 0,
      modelVersion: null,
      withinBound: true,
    });
  });

  it("refuses a simulated fill below the slippage cap", () => {
    const fill = decideFill({
      quotedOut: QUOTED,
      slippageBps: 50,
      mode: "simulated",
      shortfallBps: 80,
      modelVersion: "test",
    });
    expect(fill.withinBound).toBe(false);
    expect(fill.fillOut < fill.minOut).toBe(true);
  });

  it("accepts a simulated fill that lands exactly on the cap", () => {
    const fill = decideFill({ quotedOut: QUOTED, slippageBps: 50, mode: "simulated", shortfallBps: 50 });
    expect(fill.fillOut).toBe(fill.minOut);
    expect(fill.withinBound).toBe(true);
  });
});
