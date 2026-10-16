import { describe, expect, it } from "vitest";
import { tokenByMint } from "./constants";
import { unitsForUsd } from "./devnet";

const BONK = { ...tokenByMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")!, price: 0.000003 };
const USDC = tokenByMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")!;

describe("unitsForUsd", () => {
  it("sizes a top-up by notional, at BONK's 5 decimals", () => {
    // $250k at $0.000003 is 83,333,333,333.33333 BONK.
    expect(unitsForUsd(BONK, 250_000)).toBe(BigInt("8333333333333333"));
  });

  it("values a stablecoin at $1 when no price is available", () => {
    expect(unitsForUsd({ ...USDC, price: 0 }, 250_000)).toBe(BigInt(250_000_000_000));
  });

  it("refuses to size a thin token with no price instead of guessing", () => {
    expect(() => unitsForUsd({ ...BONK, price: 0 }, 250_000)).toThrow(/No mainnet price for BONK/);
  });
});
