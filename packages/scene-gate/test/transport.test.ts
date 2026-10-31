import { describe, expect, it } from 'vitest';
import { SpendLedger } from '../src/spend.ts';
import {
  AttemptSchema,
  ProviderConfigError,
  TRANSPORT_POLICY,
  classifyStatus,
  requestWithRetries,
  retryDelayMs,
  transportFailureLimitExceeded,
  type ProviderReply,
  type TransportDeps,
} from '../src/transport.ts';

const MODEL = 'gemini-3.5-flash-lite';
const USAGE = { promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 1500 };
const COST_OF_USAGE = 5_300;
const WORST = 42_760;

const ok = (rawOutput = '{}', over: Partial<NonNullable<ProviderReply['response']>> = {}): ProviderReply => ({
  status: 200,
  response: { rawOutput, finishReason: 'STOP', usage: USAGE, ...over },
});
const status = (code: number): ProviderReply => ({ status: code });
const boom = (name: string): Error => Object.assign(new Error(`${name} with details that never reach a tape`), { name });

/** A scripted sequence of attempts: a reply to return or an error to throw. */
function script(steps: (ProviderReply | Error)[]) {
  const timeouts: number[] = [];
  let i = 0;
  const call = async (timeoutMs: number): Promise<ProviderReply> => {
    timeouts.push(timeoutMs);
    const step = steps[i++];
    if (step === undefined) throw new Error('script ran out');
    if (step instanceof Error) throw step;
    return step;
  };
  return { call, timeouts, calls: () => i };
}

function deps(ledger = new SpendLedger()): TransportDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  let t = Date.parse('2026-11-01T00:00:00Z');
  return { sleeps, ledger, sleep: async (ms) => void sleeps.push(ms), now: () => new Date((t += 1000)) };
}

describe('the transport policy', () => {
  it('is a 180 s timeout and up to 3 retries after 2 s, 4 s and 8 s', () => {
    expect(TRANSPORT_POLICY).toEqual({ timeoutMs: 180_000, maxRetries: 3, baseDelayMs: 2_000, factor: 2 });
    expect([0, 1, 2].map((n) => retryDelayMs(n))).toEqual([2_000, 4_000, 8_000]);
  });

  it('classifies a status: retry only 429, 500, 502, 503 and 504, never another 4xx', () => {
    for (const s of [200, 201, 204]) expect(classifyStatus(s), String(s)).toBe('response');
    for (const s of [429, 500, 502, 503, 504]) expect(classifyStatus(s), String(s)).toBe('retry');
    for (const s of [501, 505, 507, 511, 599]) expect(classifyStatus(s), String(s)).toBe('transport_failure');
    for (const s of [301, 400, 401, 403, 404, 408, 422]) expect(classifyStatus(s), String(s)).toBe('abort');
  });

  it('stops a model when more than 10% of its planned generations are transport failures', () => {
    expect(transportFailureLimitExceeded(6, 60)).toBe(false);
    expect(transportFailureLimitExceeded(7, 60)).toBe(true);
    expect(transportFailureLimitExceeded(0, 60)).toBe(false);
    expect(transportFailureLimitExceeded(3, 30)).toBe(false);
    expect(transportFailureLimitExceeded(4, 30)).toBe(true);
  });
});

describe('a request under the policy', () => {
  it('returns a reply on the first attempt, logging it and counting its cost from usage', async () => {
    const d = deps();
    const s = script([ok('{"scene":1}')]);
    const out = await requestWithRetries(MODEL, s.call, d);
    expect(out.kind).toBe('response');
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]).toEqual({
      attempt: 1,
      started: '2026-11-01T00:00:01.000Z',
      duration_ms: 1000,
      http_status: 200,
      error: null,
      usage: USAGE,
      cost_micro_usd: COST_OF_USAGE,
    });
    expect(s.timeouts).toEqual([180_000]);
    expect(d.sleeps).toEqual([]);
    expect(d.ledger.spent).toBe(COST_OF_USAGE);
  });

  it('retries a 503, waiting 2 s, and keeps every attempt on the log', async () => {
    const d = deps();
    const out = await requestWithRetries(MODEL, script([status(503), ok()]).call, d);
    expect(out.kind).toBe('response');
    expect(out.attempts.map((a) => [a.attempt, a.http_status, a.error])).toEqual([[1, 503, null], [2, 200, null]]);
    expect(d.sleeps).toEqual([2_000]);
  });

  it('retries a 429, a timeout and a network error, with 2 s, 4 s and 8 s between the four attempts', async () => {
    const d = deps();
    const out = await requestWithRetries(MODEL, script([boom('TimeoutError'), boom('TypeError'), status(429), ok()]).call, d);
    expect(out.kind).toBe('response');
    expect(out.attempts.map((a) => [a.http_status, a.error])).toEqual([[null, 'TimeoutError'], [null, 'TypeError'], [429, null], [200, null]]);
    expect(d.sleeps).toEqual([2_000, 4_000, 8_000]);
  });

  it('gives up after the retries, as a transport failure, with four attempts and no sleep after the last', async () => {
    const d = deps();
    const s = script([status(503), status(503), boom('TimeoutError'), status(429), ok()]);
    const out = await requestWithRetries(MODEL, s.call, d);
    expect(out.kind).toBe('transport_failure');
    expect(out.attempts).toHaveLength(4);
    expect(s.calls()).toBe(4);
    expect(d.sleeps).toEqual([2_000, 4_000, 8_000]);
  });

  it('never retries any other 4xx: it aborts at once, with one attempt and no wait', async () => {
    for (const code of [400, 401, 403, 404, 422]) {
      const d = deps();
      const s = script([status(code), ok()]);
      const out = await requestWithRetries(MODEL, s.call, d);
      expect(out, String(code)).toMatchObject({ kind: 'abort', status: code });
      expect(out.attempts).toHaveLength(1);
      expect(s.calls()).toBe(1);
      expect(d.sleeps).toEqual([]);
    }
  });

  it('retries a 500, 502 and 504 as it does a 503, each with a 2 s wait', async () => {
    for (const code of [500, 502, 504]) {
      const d = deps();
      const s = script([status(code), ok()]);
      const out = await requestWithRetries(MODEL, s.call, d);
      expect(out.kind, String(code)).toBe('response');
      expect(out.attempts.map((a) => a.http_status)).toEqual([code, 200]);
      expect(d.sleeps).toEqual([2_000]);
    }
  });

  it('gives up on a 500 that keeps coming after four attempts, like any other retried status', async () => {
    const d = deps();
    const s = script([status(500), status(502), status(504), status(500), ok()]);
    const out = await requestWithRetries(MODEL, s.call, d);
    expect(out.kind).toBe('transport_failure');
    expect(s.calls()).toBe(4);
  });

  it('does not retry a 5xx that is not on the list: it is a transport failure on the first attempt', async () => {
    for (const code of [501, 505, 511]) {
      const d = deps();
      const s = script([status(code), ok()]);
      const out = await requestWithRetries(MODEL, s.call, d);
      expect(out.kind, String(code)).toBe('transport_failure');
      expect(s.calls()).toBe(1);
      expect(d.sleeps).toEqual([]);
    }
  });

  it('never retries a reply that arrived, whatever it says: a refusal, a truncation and an empty text are results', async () => {
    for (const reply of [ok('', { finishReason: 'SAFETY' }), ok('{"scene": ', { finishReason: 'MAX_TOKENS' }), ok("I can't help with that.")]) {
      const s = script([reply, ok()]);
      const out = await requestWithRetries(MODEL, s.call, deps());
      expect(out.kind).toBe('response');
      expect(s.calls()).toBe(1);
    }
  });

  it('treats a 2xx whose body could not be read like a network error and retries it', async () => {
    const d = deps();
    const out = await requestWithRetries(MODEL, script([{ status: 200 }, ok()]).call, d);
    expect(out.kind).toBe('response');
    expect(out.attempts.map((a) => [a.http_status, a.error])).toEqual([[200, 'EmptyReply'], [200, null]]);
  });

  it('lets a configuration error through without retrying it or billing for it', async () => {
    const d = deps();
    const s = script([new ProviderConfigError('bad parameter'), ok()]);
    await expect(requestWithRetries(MODEL, s.call, d)).rejects.toThrow(ProviderConfigError);
    expect(s.calls()).toBe(1);
    expect(d.sleeps).toEqual([]);
    expect(d.ledger.spent).toBe(0);
  });

  it('records only the error class, never the message, which could hold anything', async () => {
    const out = await requestWithRetries(MODEL, script([boom('TimeoutError'), ok()]).call, deps());
    expect(JSON.stringify(out.attempts)).not.toContain('never reach a tape');
  });

  it('writes attempts that satisfy the tape schema', async () => {
    const out = await requestWithRetries(MODEL, script([status(503), boom('TimeoutError'), ok()]).call, deps());
    for (const a of out.attempts) expect(AttemptSchema.safeParse(a).success).toBe(true);
  });
});

describe('every attempt counts toward the cap', () => {
  it('counts an attempt that got no reply at the worst case, and one with usage at its cost', async () => {
    const d = deps();
    const out = await requestWithRetries(MODEL, script([status(503), boom('TimeoutError'), ok()]).call, d);
    expect(out.attempts.map((a) => a.cost_micro_usd)).toEqual([WORST, WORST, COST_OF_USAGE]);
    expect(d.ledger.spent).toBe(2 * WORST + COST_OF_USAGE);
  });

  it('counts a transport failure as four worst-case attempts', async () => {
    const d = deps();
    await requestWithRetries(MODEL, script([status(503), status(503), status(503), status(503)]).call, d);
    expect(d.ledger.spent).toBe(4 * WORST);
  });

  it('does not send an attempt that could reach the cap', async () => {
    const d = deps(new SpendLedger(WORST, 0));
    const s = script([ok()]);
    const out = await requestWithRetries(MODEL, s.call, d);
    expect(out).toEqual({ kind: 'spend_cap', attempts: [] });
    expect(s.calls()).toBe(0);
  });

  it('stops between retries when the attempts so far have used up the room, and keeps those attempts', async () => {
    const d = deps(new SpendLedger(100_000, 0));
    const s = script([status(503), status(503), status(503), ok()]);
    const out = await requestWithRetries(MODEL, s.call, d);
    expect(out.kind).toBe('spend_cap');
    expect(out.attempts).toHaveLength(2);
    expect(s.calls()).toBe(2);
    expect(d.ledger.spent).toBe(2 * WORST);
  });
});
