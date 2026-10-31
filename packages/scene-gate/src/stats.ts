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

/**
 * What became of one generation: a verdict, or `transport_failure` when no reply arrived after the retries. A
 * transport failure is its own outcome, never a schema problem, and it stays in every denominator.
 */
export type Outcome = Verdict | 'transport_failure';

export interface VerdictSample {
  readonly model: string;
  readonly prompt_id: string;
  readonly verdict: Outcome;
}

export interface FlipRate {
  /** Prompt x model groups with exactly three outcomes. A transport failure counts as an outcome. */
  readonly triples: number;
  /** Triples whose three outcomes are not all the same. */
  readonly flips: number;
  /** Groups that did not have exactly three outcomes; they are left out of the rate. */
  readonly incomplete: number;
  readonly interval: Interval | null;
  /** The same rate over the triples that contain no transport failure, so infrastructure noise can be told apart. */
  readonly excludingTransport: { readonly triples: number; readonly flips: number; readonly interval: Interval | null };
}

/** Flip rate over (prompt, model) triples. The outcome is compared, not the diagnostic hash. */
export function flipRate(samples: readonly VerdictSample[]): FlipRate {
  const groups = new Map<string, Outcome[]>();
  for (const s of samples) {
    const key = JSON.stringify([s.model, s.prompt_id]);
    const list = groups.get(key);
    if (list) list.push(s.verdict);
    else groups.set(key, [s.verdict]);
  }
  let triples = 0;
  let flips = 0;
  let incomplete = 0;
  let cleanTriples = 0;
  let cleanFlips = 0;
  for (const outcomes of groups.values()) {
    if (outcomes.length !== 3) {
      incomplete++;
      continue;
    }
    const flipped = new Set(outcomes).size > 1;
    triples++;
    if (flipped) flips++;
    if (!outcomes.includes('transport_failure')) {
      cleanTriples++;
      if (flipped) cleanFlips++;
    }
  }
  return {
    triples,
    flips,
    incomplete,
    interval: triples ? wilson(flips, triples) : null,
    excludingTransport: { triples: cleanTriples, flips: cleanFlips, interval: cleanTriples ? wilson(cleanFlips, cleanTriples) : null },
  };
}

export interface UnplayableRate {
  /** `pass` plus `fail`: the scenes that were schema-valid. */
  readonly schemaValid: number;
  readonly unplayable: number;
  readonly schemaInvalid: number;
  readonly transportFailures: number;
  /** Every generation, transport failures included. */
  readonly generations: number;
  /** `unplayable` over `schemaValid`. */
  readonly interval: Interval | null;
  /** `unplayable` over every generation. */
  readonly intervalOfGenerations: Interval | null;
}

/**
 * Of the schema-valid scenes, how many fail a check. Schema-invalid outputs and transport failures are counted apart:
 * they are left out of the conditional rate (`interval`) and kept in the rate over all generations.
 */
export function unplayableRate(outcomes: readonly Outcome[]): UnplayableRate {
  const count = (o: Outcome): number => outcomes.filter((x) => x === o).length;
  const schemaInvalid = count('schema_invalid');
  const transportFailures = count('transport_failure');
  const unplayable = count('fail');
  const schemaValid = count('pass') + unplayable;
  return {
    schemaValid,
    unplayable,
    schemaInvalid,
    transportFailures,
    generations: outcomes.length,
    interval: schemaValid ? wilson(unplayable, schemaValid) : null,
    intervalOfGenerations: outcomes.length ? wilson(unplayable, outcomes.length) : null,
  };
}
