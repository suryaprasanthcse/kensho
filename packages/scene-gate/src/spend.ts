/**
 * Spend accounting for the study's $10 hard stop. All amounts are integer micro-dollars (1 USD = 1,000,000), so no
 * floating point enters the ledger.
 *
 * Prices are those on https://ai.google.dev/gemini-api/docs/pricing (page "Last updated 2026-10-30 UTC", read
 * 2026-11-01), standard tier, text. Output prices include thinking tokens.
 */
export const SPEND_CAP_MICRO_USD = 10_000_000;

/** Token counts as a provider reported them. */
export type Usage = Readonly<Record<string, number | null>>;

export interface Price {
  /** Micro-dollars per 1,000,000 input tokens. */
  readonly inputPerMTok: number;
  /** Micro-dollars per 1,000,000 output tokens, thinking included. */
  readonly outputPerMTok: number;
}

/** `gemini-3.8-flash` doubles on this date. */
const PRICE_CHANGE_3_8_FLASH = Date.parse('2027-01-01T00:00:00Z');

/** The price of a model at a given time. An unknown model is an error: a cap cannot be enforced with a guessed price. */
export function priceFor(model: string, at: Date): Price {
  if (model === 'gemini-3.5-flash-lite') return { inputPerMTok: 300_000, outputPerMTok: 2_500_000 };
  if (model === 'gemini-3.8-flash') {
    return at.getTime() < PRICE_CHANGE_3_8_FLASH ? { inputPerMTok: 750_000, outputPerMTok: 3_750_000 } : { inputPerMTok: 1_500_000, outputPerMTok: 7_500_000 };
  }
  throw new RangeError(`no price recorded for model ${model}`);
}

/**
 * What one attempt is assumed to cost before it is sent: 6,000 input tokens and 16,384 output tokens, the most the
 * study allows a reply to be (`maxOutputTokens`, which includes thinking tokens).
 */
export const WORST_CASE_INPUT_TOKENS = 6_000;
export const WORST_CASE_OUTPUT_TOKENS = 16_384;

export const worstCaseMicroUsd = (price: Price): number =>
  Math.ceil((WORST_CASE_INPUT_TOKENS * price.inputPerMTok + WORST_CASE_OUTPUT_TOKENS * price.outputPerMTok) / 1_000_000);

/**
 * The cost of a reply from its reported usage, or null when the usage does not say. Thinking tokens are billed as
 * output, and Gemini reports them apart from the candidate tokens.
 */
export function usageCostMicroUsd(usage: Usage | null | undefined, price: Price): number | null {
  const input = usage?.promptTokenCount;
  const candidates = usage?.candidatesTokenCount;
  if (typeof input !== 'number' || typeof candidates !== 'number') return null;
  const thoughts = usage?.thoughtsTokenCount;
  const output = candidates + (typeof thoughts === 'number' ? thoughts : 0);
  return Math.ceil((input * price.inputPerMTok + output * price.outputPerMTok) / 1_000_000);
}

/**
 * Every attempt counts. An attempt that reported usage costs what the usage says; one that did not (a 503, a timeout,
 * a network error, where the provider may still have done work) is counted at the worst case.
 */
export const attemptCostMicroUsd = (usage: Usage | null | undefined, price: Price): number => usageCostMicroUsd(usage, price) ?? worstCaseMicroUsd(price);

export class SpendLedger {
  #spent = 0;
  readonly cap: number;

  constructor(cap: number = SPEND_CAP_MICRO_USD, alreadySpent = 0) {
    this.cap = cap;
    this.#spent = alreadySpent;
  }

  get spent(): number {
    return this.#spent;
  }

  record(microUsd: number): void {
    if (!Number.isInteger(microUsd) || microUsd < 0) throw new RangeError(`spend must be a non-negative integer, got ${microUsd}`);
    this.#spent += microUsd;
  }

  /** True when a request that may cost up to `worstCase` can be sent without the total reaching the cap. */
  permits(worstCase: number): boolean {
    return this.#spent + worstCase < this.cap;
  }
}
