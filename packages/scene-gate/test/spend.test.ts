import { describe, expect, it } from 'vitest';
import {
  SPEND_CAP_MICRO_USD,
  SpendLedger,
  WORST_CASE_INPUT_TOKENS,
  WORST_CASE_OUTPUT_TOKENS,
  attemptCostMicroUsd,
  priceFor,
  usageCostMicroUsd,
  worstCaseMicroUsd,
} from '../src/spend.ts';

const NOW = new Date('2026-11-01T00:00:00Z');
const LITE = priceFor('gemini-3.5-flash-lite', NOW);
const FLASH = priceFor('gemini-3.8-flash', NOW);

describe('prices', () => {
  it('are the ones on the pricing page, in micro-dollars per million tokens', () => {
    expect(LITE).toEqual({ inputPerMTok: 300_000, outputPerMTok: 2_500_000 });
    expect(FLASH).toEqual({ inputPerMTok: 750_000, outputPerMTok: 3_750_000 });
  });

  it('double for gemini-3.8-flash on 2027-01-01 UTC, to the millisecond', () => {
    expect(priceFor('gemini-3.8-flash', new Date('2026-12-31T23:59:59.999Z'))).toEqual(FLASH);
    expect(priceFor('gemini-3.8-flash', new Date('2027-01-01T00:00:00.000Z'))).toEqual({ inputPerMTok: 1_500_000, outputPerMTok: 7_500_000 });
    expect(priceFor('gemini-3.5-flash-lite', new Date('2027-06-01T00:00:00Z'))).toEqual(LITE);
  });

  it('refuse a model with no recorded price, because a cap cannot be enforced on a guess', () => {
    expect(() => priceFor('gemini-4-argon', NOW)).toThrow(RangeError);
    expect(() => priceFor('gemini-1.5-flash', NOW)).toThrow(RangeError);
  });
});

describe('cost', () => {
  it('assumes 6,000 input and 8,192 output tokens before a request is sent', () => {
    expect([WORST_CASE_INPUT_TOKENS, WORST_CASE_OUTPUT_TOKENS]).toEqual([6_000, 8_192]);
    expect(worstCaseMicroUsd(LITE)).toBe(22_280);
    expect(worstCaseMicroUsd(FLASH)).toBe(35_220);
    expect(worstCaseMicroUsd(priceFor('gemini-3.8-flash', new Date('2027-01-01T00:00:00Z')))).toBe(70_440);
  });

  it('adds up to the worst case the preregistration states for the whole study: 120 requests per model', () => {
    const now = 120 * worstCaseMicroUsd(LITE) + 120 * worstCaseMicroUsd(FLASH);
    expect(now).toBe(6_900_000);
    expect(now).toBeLessThan(SPEND_CAP_MICRO_USD);
    const after = 120 * worstCaseMicroUsd(LITE) + 120 * worstCaseMicroUsd(priceFor('gemini-3.8-flash', new Date('2027-01-01T00:00:00Z')));
    expect(after).toBe(11_126_400);
    expect(after).toBeGreaterThan(SPEND_CAP_MICRO_USD);
  });

  it('bills thinking tokens as output, and rounds a partial micro-dollar up', () => {
    expect(usageCostMicroUsd({ promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 1500 }, LITE)).toBe(5_300);
    expect(usageCostMicroUsd({ promptTokenCount: 1000, candidatesTokenCount: 500 }, LITE)).toBe(1_550);
    expect(usageCostMicroUsd({ promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: null }, LITE)).toBe(3);
  });

  it('is unknown when the usage does not give prompt and candidate tokens', () => {
    expect(usageCostMicroUsd(undefined, LITE)).toBeNull();
    expect(usageCostMicroUsd(null, LITE)).toBeNull();
    expect(usageCostMicroUsd({ promptTokenCount: 10 }, LITE)).toBeNull();
    expect(usageCostMicroUsd({ promptTokenCount: null, candidatesTokenCount: 5 }, LITE)).toBeNull();
  });

  it('counts an attempt with no reported usage at the worst case', () => {
    expect(attemptCostMicroUsd(null, LITE)).toBe(22_280);
    expect(attemptCostMicroUsd({ totalTokenCount: 5 }, FLASH)).toBe(35_220);
    expect(attemptCostMicroUsd({ promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 1500 }, LITE)).toBe(5_300);
  });
});

describe('the ledger', () => {
  it('has a $10 cap', () => {
    expect(SPEND_CAP_MICRO_USD).toBe(10_000_000);
    expect(new SpendLedger().cap).toBe(10_000_000);
  });

  it('permits a request only if the total stays strictly below the cap', () => {
    const ledger = new SpendLedger(100, 40);
    expect(ledger.permits(59)).toBe(true);
    expect(ledger.permits(60)).toBe(false);
    expect(ledger.permits(61)).toBe(false);
  });

  it('adds what is recorded and starts from what was already spent', () => {
    const ledger = new SpendLedger(1_000, 100);
    ledger.record(250);
    ledger.record(0);
    expect(ledger.spent).toBe(350);
  });

  it('refuses amounts that are negative or not whole micro-dollars', () => {
    const ledger = new SpendLedger();
    for (const bad of [-1, 0.5, Number.NaN]) expect(() => ledger.record(bad)).toThrow(RangeError);
    expect(ledger.spent).toBe(0);
  });
});
