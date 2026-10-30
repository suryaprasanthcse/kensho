/** Wilson score interval for a binomial proportion. */
export function wilson(k: number, n: number, z = 1.959964): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** Nearest-rank percentile of a list of numbers (q in [0, 1]). */
export function percentile(values: readonly number[], q: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1]!;
}

export const fmtPct = (x: number): string => `${(x * 100).toFixed(1)}%`;
export const fmtInterval = (k: number, n: number): string => {
  const { lo, hi } = wilson(k, n);
  return `[${fmtPct(lo)}, ${fmtPct(hi)}]`;
};
