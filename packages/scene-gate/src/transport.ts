import { z } from 'zod';
import { SpendLedger, attemptCostMicroUsd, priceFor, worstCaseMicroUsd, type Usage } from './spend.ts';

/**
 * Transport policy: how a request that did not get a usable reply is handled. It is deliberately dull.
 * - Timeout 180 s per attempt.
 * - Up to 3 retries (4 attempts), after 2 s, 4 s and 8 s, and only for HTTP 429, 500, 502, 503 or 504, a timeout, or a
 *   network error.
 * - Never retry any other 4xx, and never retry a reply that arrived: a 200 is final whatever it says (a refusal and a
 *   truncated reply are results, not failures).
 * - Every attempt is logged on the tape and counted against the spend cap.
 * - When the retries run out the generation is recorded as `transport_failure`. It is never regenerated.
 */
export const TRANSPORT_POLICY = { timeoutMs: 180_000, maxRetries: 3, baseDelayMs: 2_000, factor: 2 } as const;

/** Delay before retry number `retryIndex` (0 for the first retry): 2 s, 4 s, 8 s. No jitter, so a run is reproducible. */
export const retryDelayMs = (retryIndex: number, policy = TRANSPORT_POLICY): number => policy.baseDelayMs * policy.factor ** retryIndex;

/** What the provider returned. `response` is present for a 2xx status. */
export interface ModelResponse {
  readonly rawOutput: string;
  readonly finishReason: string | null;
  readonly usage?: Usage;
}

export interface ProviderReply {
  readonly status: number;
  readonly response?: ModelResponse;
}

export const AttemptSchema = z.strictObject({
  /** 1-based. */
  attempt: z.number().int().min(1),
  /** ISO 8601 UTC, when the attempt was sent. */
  started: z.iso.datetime(),
  duration_ms: z.number().int().min(0),
  /** The HTTP status, or null when no reply arrived (a timeout or a network error). */
  http_status: z.number().int().nullable(),
  /** The error class when no reply arrived (for example `TimeoutError`), else null. */
  error: z.string().nullable(),
  /** Token counts the provider reported for this attempt, if any. */
  usage: z.record(z.string(), z.number().int().nullable()).nullable(),
  /** What this attempt counted against the spend cap, in micro-dollars. */
  cost_micro_usd: z.number().int().min(0),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export type Disposition = 'response' | 'retry' | 'transport_failure' | 'abort';

/**
 * - 2xx: a reply, final.
 * - 429, 500, 502, 503 and 504: retry.
 * - any other 5xx (501, 505 and up): a transport failure that is not retried, because it is not on the retry list.
 * - any other status, which includes every other 4xx: abort the run, because it is a setup error (a rejected schema, an
 *   invalid key, an unknown model) that retrying cannot fix.
 */
export function classifyStatus(status: number): Disposition {
  if (status >= 200 && status < 300) return 'response';
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return 'retry';
  if (status >= 500 && status < 600) return 'transport_failure';
  return 'abort';
}

export type RequestOutcome =
  | { readonly kind: 'response'; readonly reply: ProviderReply & { readonly response: ModelResponse }; readonly attempts: Attempt[] }
  | { readonly kind: 'transport_failure'; readonly attempts: Attempt[] }
  | { readonly kind: 'abort'; readonly status: number; readonly attempts: Attempt[] }
  | { readonly kind: 'spend_cap'; readonly attempts: Attempt[] };

export interface TransportDeps {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly ledger: SpendLedger;
}

/**
 * Sends one request under the policy. `call` performs a single attempt with the given timeout and throws on a network
 * error or a timeout. Before every attempt, retries included, the spend cap is checked; after it, the attempt's cost is
 * recorded on the ledger.
 */
export async function requestWithRetries(
  model: string,
  call: (timeoutMs: number) => Promise<ProviderReply>,
  deps: TransportDeps,
  policy = TRANSPORT_POLICY,
): Promise<RequestOutcome> {
  const attempts: Attempt[] = [];
  for (let retry = 0; retry <= policy.maxRetries; retry++) {
    const started = deps.now();
    const price = priceFor(model, started);
    if (!deps.ledger.permits(worstCaseMicroUsd(price))) return { kind: 'spend_cap', attempts };

    let reply: ProviderReply | null = null;
    let error: string | null = null;
    try {
      reply = await call(policy.timeoutMs);
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.name : 'Error';
    }
    const finished = deps.now();

    // A 2xx whose body could not be read is not a reply that arrived, so it is handled like a network error.
    const emptyReply = reply !== null && reply.status >= 200 && reply.status < 300 && reply.response === undefined;
    if (emptyReply) error = 'EmptyReply';
    const usage = reply?.response?.usage ?? null;
    const cost = attemptCostMicroUsd(usage, price);
    deps.ledger.record(cost);
    attempts.push({
      attempt: retry + 1,
      started: started.toISOString(),
      duration_ms: Math.max(0, finished.getTime() - started.getTime()),
      http_status: reply?.status ?? null,
      error,
      usage: usage ? { ...usage } : null,
      cost_micro_usd: cost,
    });

    const disposition: Disposition = reply === null || emptyReply ? 'retry' : classifyStatus(reply.status);
    if (disposition === 'response') return { kind: 'response', reply: reply as ProviderReply & { response: ModelResponse }, attempts };
    if (disposition === 'abort') return { kind: 'abort', status: reply!.status, attempts };
    if (disposition === 'transport_failure') return { kind: 'transport_failure', attempts };
    if (retry < policy.maxRetries) await deps.sleep(retryDelayMs(retry, policy));
  }
  return { kind: 'transport_failure', attempts };
}

/** More than 10% of a model's planned generations ended in `transport_failure`: stop that model. Integer arithmetic. */
export const transportFailureLimitExceeded = (failures: number, planned: number): boolean => failures * 10 > planned;
