import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Z95, flipRate, unplayableRate, wilson } from '../src/stats.ts';

// Reference values from an independent 40-digit decimal implementation of the Wilson formula, rounded to 4 places.
const KNOWN: [k: number, n: number, lower: number, upper: number][] = [
  [1, 10, 0.0179, 0.4042],
  [5, 10, 0.2366, 0.7634],
  [0, 20, 0.0, 0.1611],
  [20, 20, 0.8389, 1.0],
  [81, 263, 0.2553, 0.3662],
  [3, 60, 0.0171, 0.137],
  [1, 3, 0.0615, 0.7923],
];

describe('the Wilson 95% interval', () => {
  it.each(KNOWN)('k=%i n=%i -> [%f, %f]', (k, n, lower, upper) => {
    const w = wilson(k, n);
    expect(w.lower).toBeCloseTo(lower, 4);
    expect(w.upper).toBeCloseTo(upper, 4);
    expect(w.estimate).toBe(k / n);
  });

  it('uses the 97.5th percentile of the normal distribution', () => {
    expect(Z95).toBeCloseTo(1.96, 2);
  });

  it('is exact at the edges: zero successes start at 0, all successes end at 1', () => {
    expect(wilson(0, 7).lower).toBe(0);
    expect(wilson(7, 7).upper).toBe(1);
    expect(wilson(0, 20).upper).toBeCloseTo(Z95 ** 2 / (20 + Z95 ** 2), 12);
  });

  it('is symmetric: k of n mirrors n-k of n', () => {
    const a = wilson(2, 9);
    const b = wilson(7, 9);
    expect(a.lower).toBeCloseTo(1 - b.upper, 12);
    expect(a.upper).toBeCloseTo(1 - b.lower, 12);
  });

  it('narrows as the sample grows', () => {
    const small = wilson(5, 10);
    const large = wilson(500, 1000);
    expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower);
  });

  it('rejects impossible counts', () => {
    for (const [k, n] of [[1, 0], [-1, 5], [6, 5], [1.5, 5], [1, 5.5]] as const) expect(() => wilson(k, n)).toThrow(RangeError);
  });

  it('property: the interval is ordered, inside [0, 1], and contains the estimate', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), fc.double({ min: 0, max: 1, noNaN: true }), (n, f) => {
        const k = Math.floor(f * n);
        const w = wilson(k, n);
        expect(w.lower).toBeGreaterThanOrEqual(0);
        expect(w.upper).toBeLessThanOrEqual(1);
        expect(w.lower).toBeLessThanOrEqual(w.estimate + 1e-12);
        expect(w.upper).toBeGreaterThanOrEqual(w.estimate - 1e-12);
      }),
    );
  });
});

describe('flip rate', () => {
  const s = (model: string, prompt_id: string, verdicts: ('pass' | 'fail' | 'schema_invalid' | 'transport_failure')[]) => verdicts.map((verdict) => ({ model, prompt_id, verdict }));

  it('counts a triple as a flip unless all three verdicts match', () => {
    const r = flipRate([
      ...s('m', 'p1', ['pass', 'pass', 'pass']),
      ...s('m', 'p2', ['fail', 'fail', 'fail']),
      ...s('m', 'p3', ['pass', 'fail', 'pass']),
      ...s('m', 'p4', ['schema_invalid', 'schema_invalid', 'fail']),
    ]);
    expect(r).toMatchObject({ triples: 4, flips: 2, incomplete: 0 });
    expect(r.interval?.estimate).toBe(0.5);
  });

  it('keeps prompts and models apart', () => {
    const r = flipRate([...s('a', 'p', ['pass', 'pass', 'pass']), ...s('b', 'p', ['fail', 'fail', 'fail'])]);
    expect(r).toMatchObject({ triples: 2, flips: 0 });
  });

  it('leaves out groups that do not have exactly three verdicts and says so', () => {
    const r = flipRate([...s('m', 'p1', ['pass', 'fail']), ...s('m', 'p2', ['pass', 'pass', 'pass']), ...s('m', 'p3', ['pass', 'pass', 'pass', 'fail'])]);
    expect(r).toMatchObject({ triples: 1, flips: 0, incomplete: 2 });
  });

  it('has no interval when there is no triple', () => {
    expect(flipRate([])).toEqual({ triples: 0, flips: 0, incomplete: 0, interval: null, excludingTransport: { triples: 0, flips: 0, interval: null } });
  });

  it('does not depend on sample order', () => {
    const a = [...s('m', 'p1', ['pass', 'fail', 'pass']), ...s('m', 'p2', ['pass', 'pass', 'pass'])];
    expect(flipRate([...a].reverse())).toEqual(flipRate(a));
  });
});

describe('unplayable rate', () => {
  it('divides failures by schema-valid scenes and counts schema-invalid apart', () => {
    const r = unplayableRate(['pass', 'fail', 'fail', 'schema_invalid', 'pass', 'pass']);
    expect(r).toMatchObject({ schemaValid: 5, unplayable: 2, schemaInvalid: 1 });
    expect(r.interval?.estimate).toBe(0.4);
  });

  it('has no interval when nothing was schema-valid', () => {
    expect(unplayableRate(['schema_invalid']).interval).toBeNull();
  });
});

describe('transport failures in the rates', () => {
  const s = (prompt_id: string, verdicts: ('pass' | 'fail' | 'schema_invalid' | 'transport_failure')[]) => verdicts.map((verdict) => ({ model: 'm', prompt_id, verdict }));

  it('count as an outcome in a triple, so a triple with one is a flip, and are also shown apart', () => {
    const r = flipRate([...s('p1', ['pass', 'pass', 'transport_failure']), ...s('p2', ['pass', 'pass', 'pass']), ...s('p3', ['pass', 'fail', 'pass'])]);
    expect(r).toMatchObject({ triples: 3, flips: 2 });
    expect(r.excludingTransport).toMatchObject({ triples: 2, flips: 1 });
    expect(r.excludingTransport.interval?.estimate).toBe(0.5);
  });

  it('three failures in one triple agree with each other and are not a flip', () => {
    expect(flipRate(s('p1', ['transport_failure', 'transport_failure', 'transport_failure']))).toMatchObject({ triples: 1, flips: 0 });
  });

  it('stay out of the conditional unplayable rate and in the rate over every generation', () => {
    const r = unplayableRate(['pass', 'fail', 'fail', 'schema_invalid', 'transport_failure', 'transport_failure', 'pass', 'pass']);
    expect(r).toMatchObject({ schemaValid: 5, unplayable: 2, schemaInvalid: 1, transportFailures: 2, generations: 8 });
    expect(r.interval?.estimate).toBe(0.4);
    expect(r.intervalOfGenerations?.estimate).toBe(0.25);
  });

  it('are not counted as schema_invalid', () => {
    const r = unplayableRate(['transport_failure', 'transport_failure']);
    expect(r).toMatchObject({ schemaInvalid: 0, transportFailures: 2, schemaValid: 0, interval: null });
    expect(r.intervalOfGenerations?.estimate).toBe(0);
  });
});
