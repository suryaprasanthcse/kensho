import type { Verdict } from './verdict.ts';

/** The two-sided 95% normal quantile. */
export const Z95 = 1.959963984540054;

export interface Interval {
  readonly k: number;
  readonly n: number;
  readonly estimate: number;
  readonly lower: number;
  readonly upper: number;
}

/** Wilson score interval for k successes in n trials. Statistics only; nothing in the checks uses floating point. */
export function wilson(k: number, n: number, z: number = Z95): Interval {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1 || k < 0 || k > n) {
    throw new RangeError(`wilson: need integers with 0 <= k <= n and n >= 1, got k=${k}, n=${n}`);
  }
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    k,
    n,
    estimate: p,
    lower: k === 0 ? 0 : Math.max(0, centre - half),
    upper: k === n ? 1 : Math.min(1, centre + half),
  };
}

export interface VerdictSample {
  readonly model: string;
  readonly prompt_id: string;
  readonly verdict: Verdict;
}

export interface FlipRate {
  /** Prompt x model groups with exactly three verdicts. */
  readonly triples: number;
  /** Triples whose three verdicts are not all the same. */
  readonly flips: number;
  /** Groups that did not have exactly three verdicts; they are left out of the rate. */
  readonly incomplete: number;
  readonly interval: Interval | null;
}

/** Flip rate over (prompt, model) triples. The verdict is compared, not the diagnostic hash. */
export function flipRate(samples: readonly VerdictSample[]): FlipRate {
  const groups = new Map<string, Verdict[]>();
  for (const s of samples) {
    const key = JSON.stringify([s.model, s.prompt_id]);
    const list = groups.get(key);
    if (list) list.push(s.verdict);
    else groups.set(key, [s.verdict]);
  }
  let triples = 0;
  let flips = 0;
  let incomplete = 0;
  for (const verdicts of groups.values()) {
    if (verdicts.length !== 3) {
      incomplete++;
      continue;
    }
    triples++;
    if (new Set(verdicts).size > 1) flips++;
  }
  return { triples, flips, incomplete, interval: triples ? wilson(flips, triples) : null };
}

export interface UnplayableRate {
  readonly schemaValid: number;
  readonly unplayable: number;
  readonly schemaInvalid: number;
  readonly interval: Interval | null;
}

/** Of the schema-valid scenes, how many fail a check. Schema-invalid outputs are counted apart and left out. */
export function unplayableRate(verdicts: readonly Verdict[]): UnplayableRate {
  const schemaInvalid = verdicts.filter((v) => v === 'schema_invalid').length;
  const schemaValid = verdicts.length - schemaInvalid;
  const unplayable = verdicts.filter((v) => v === 'fail').length;
  return { schemaValid, unplayable, schemaInvalid, interval: schemaValid ? wilson(unplayable, schemaValid) : null };
}
