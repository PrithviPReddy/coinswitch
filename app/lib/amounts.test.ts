import { describe, expect, it } from "vitest";
import { decimalToBaseUnits, quoteKey } from "./amounts";

describe("decimalToBaseUnits", () => {
  it("converts without float error", () => {
    expect(decimalToBaseUnits("0.29", 9)).toBe(BigInt(290_000_000));
    expect(decimalToBaseUnits("1", 6)).toBe(BigInt(1_000_000));
    expect(decimalToBaseUnits(".5", 6)).toBe(BigInt(500_000));
    expect(decimalToBaseUnits("12.", 6)).toBe(BigInt(12_000_000));
  });

  it("rejects what cannot be an amount", () => {
    for (const bad of ["", ".", "0", "0.000", "-1", "1e3", "abc", "1.2.3"]) {
      expect(decimalToBaseUnits(bad, 6), bad).toBeNull();
    }
  });

  it("rejects more decimals than the token has rather than truncating", () => {
    expect(decimalToBaseUnits("0.0000001", 6)).toBeNull();
  });
});

describe("quoteKey", () => {
  it("changes with the pair and with the exact amount", () => {
    const a = quoteKey("SOL", "USDC", BigInt(1));
    expect(quoteKey("SOL", "USDT", BigInt(1))).not.toBe(a);
    expect(quoteKey("SOL", "USDC", BigInt(2))).not.toBe(a);
    expect(quoteKey("SOL", "USDC", null)).toBeNull();
  });
});
