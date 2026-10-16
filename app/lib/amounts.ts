/**
 * Turns what a user typed into base units without going through a float, so
 * "0.29" SOL is exactly 290000000 lamports rather than whatever
 * 0.29 * 1e9 rounds to. Returns null for anything that is not a plain
 * positive decimal, or that has more decimal places than the token supports.
 */
export function decimalToBaseUnits(text: string, decimals: number): bigint | null {
  const trimmed = text.trim();
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || trimmed === "" || trimmed === ".") return null;

  const [, whole = "", fraction = ""] = match;
  if (fraction.length > decimals) return null;

  const units = BigInt((whole || "0") + fraction.padEnd(decimals, "0"));
  return units > BigInt(0) ? units : null;
}

/**
 * Identifies what a quote was asked for. A quote may only be acted on while
 * the identity of the current inputs still matches it.
 */
export function quoteKey(inputMint: string, outputMint: string, amount: bigint | null): string | null {
  return amount === null ? null : `${inputMint}>${outputMint}:${amount}`;
}
