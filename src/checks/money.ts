// Money helpers. Amounts are plain numbers (see CLAUDE.md), so floating-point
// noise is handled in exactly two places: rounding and comparison.

/** Rounds to 2 decimals. EPSILON nudges values like 1.005 (stored as 1.00499…) the right way. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Two amounts are equal if they differ by at most one cent. */
export function sameAmount(a: number, b: number): boolean {
  return Math.abs(round2(a) - round2(b)) <= 0.01 + 1e-9;
}
