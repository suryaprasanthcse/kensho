import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Hyper3dError, Ledger, VirtualClock, minimalGlb, type MockFault } from '../src/index.ts';
import { codeOf, req, rig, untilDone, type Rig } from './helpers.ts';

let r: Rig;
afterEach(async () => {
  await r?.cleanup();
});
const ledgerEvents = () => new Ledger(r.ledgerPath).entries().map((e) => e.event);

describe('the happy path', () => {
  it('submits, polls and downloads, and ledgers the job the moment it is accepted', async () => {
    r = await rig();
    const job = await r.provider.submit(req(1));
    expect(ledgerEvents()).toEqual(['accepted']); // on disk before any poll
    expect(await r.provider.poll(job)).toEqual({ status: 'pending' });
    expect((await untilDone(r.provider, job)).status).toBe('done');
    const raw = await r.provider.fetch(job);
    expect(raw.consumed).toBe(0.5);
    expect(raw.providerId).toBe('hyper3d-rodin/gen-2.5');
    expect(raw.bytes).toEqual(minimalGlb());
    expect(ledgerEvents()).toEqual(['accepted', 'downloaded']);
    const e = new Ledger(r.ledgerPath).entries()[0]!;
    expect(e).toMatchObject({ uuid: 'job-1', seed: 1, tier: 'Gen-2.5-Medium', consumed_mc: 500, expected_mc: 500 });
    expect(r.provider.spentCredits).toBe(0.5);
  });

  it('always sends tier, seed and the pinned fields, with the key only to the API', async () => {
    r = await rig();
    await r.provider.generate(req(7, { bbox_condition: '100,100,200', addons: 'HighPack' }));
    const submit = r.mock.requests.find((x) => x.path === '/rodin')!;
    expect(submit.authorization).toBe('Bearer test-key');
    expect(submit.fields).toMatchObject({ tier: ['Gen-2.5-Medium'], seed: ['7'], geometry_file_format: ['glb'], mesh_mode: ['Raw'], quality_override: ['20000'], bbox_condition: ['100', '100', '200'], addons: ['HighPack'] });
    const file = r.mock.requests.filter((x) => x.path.startsWith('/files/'));
    expect(file.length).toBe(1);
    expect(file[0]!.authorization).toBeUndefined(); // the key never goes to a download host
  });

  it('every submit the mock ever sees carries a tier', async () => {
    r = await rig();
    for (let i = 0; i < 5; i++) await r.provider.submit(req(i, { tier: 'Gen-2.5-Medium' }));
    for (const x of r.mock.requests.filter((q) => q.path === '/rodin')) expect(x.fields?.tier?.[0]).toBeTruthy();
  });
});

describe('requests are validated before any network call', () => {
  it.each([
    ['no tier', { tier: undefined as never }],
    ['a legacy tier', { tier: 'Regular' }],
    ['a seed that is out of range', { __seed: 70_000 }],
    ['a float quality override', { quality_override: 20000.5 }],
    ['a quality override below the minimum', { quality_override: 100 }],
    ['an unsupported format', { geometry_file_format: 'fbx' }],
    ['a malformed bbox_condition', { bbox_condition: '1,2' }],
  ])('rejects %s', async (_name, over) => {
    r = await rig();
    const q = req(1);
    const { __seed, ...params } = over as Record<string, unknown>;
    const bad = { ...q, seed: (__seed as number | undefined) ?? q.seed, params: Object.fromEntries(Object.entries({ ...q.params, ...params }).filter(([, v]) => v !== undefined)) as typeof q.params };
    expect(await codeOf(r.provider.submit(bad))).toBe('INVALID_REQUEST');
    expect(r.mock.requests.length).toBe(0);
  });
});

describe('429 and exponential backoff', () => {
  it('backs off with jitter, honours Retry-After as a floor, then succeeds without double charging', async () => {
    r = await rig({ faults: { submit: (n): MockFault | undefined => (n <= 3 ? { kind: 'http', status: 429, headers: { 'retry-after': '2' } } : undefined) } });
    await r.provider.submit(req(1));
    // attempts 0..2: raw 1000, 2000, 4000 scaled by 0.75, never below 2000
    expect(r.clock.sleeps).toEqual([2000, 2000, 3000]);
    expect(r.mock.counts.submit).toBe(4);
    expect(ledgerEvents()).toEqual(['accepted']);
  });

  it('grows exponentially when there is no Retry-After', async () => {
    r = await rig({ faults: { submit: (n): MockFault | undefined => (n <= 3 ? { kind: 'http', status: 429 } : undefined) } });
    await r.provider.submit(req(1));
    expect(r.clock.sleeps).toEqual([750, 1500, 3000]);
  });

  it('gives up after maxRetries and has charged nothing', async () => {
    r = await rig({ faults: { submit: (): MockFault => ({ kind: 'http', status: 429 }) } }, { maxRetries: 3 });
    expect(await codeOf(r.provider.submit(req(1)))).toBe('RATE_LIMITED');
    expect(r.mock.counts.submit).toBe(4);
    expect(r.provider.spentCredits).toBe(0);
    expect(ledgerEvents()).toEqual([]);
  });

  it('caps the delay', async () => {
    r = await rig({ faults: { submit: (n): MockFault | undefined => (n <= 8 ? { kind: 'http', status: 429 } : undefined) } }, { backoffCapMs: 5000, maxRetries: 10 });
    await r.provider.submit(req(1));
    expect(Math.max(...r.clock.sleeps)).toBeLessThanOrEqual(5000);
  });
});

describe('HTTP success is not acceptance', () => {
  it('a 201 with a non-empty error is a rejection, ledgered, and charges nothing', async () => {
    r = await rig({ faults: { submit: (n): MockFault | undefined => (n === 1 ? { kind: 'api-error', error: 'IMAGE_CONTENT_VIOLATION' } : undefined) } });
    expect(await codeOf(r.provider.submit(req(1)))).toBe('CONTENT_VIOLATION');
    expect(ledgerEvents()).toEqual(['rejected']);
    expect(r.provider.spentCredits).toBe(0);
    expect(r.provider.haltedReason).toBeNull();
    await r.provider.submit(req(2)); // an unrelated request still works
  });

  it('a 201 with an empty uuid is not a job even when error is empty', async () => {
    r = await rig({ faults: { submit: (n): MockFault | undefined => (n === 1 ? { kind: 'patch', patch: { uuid: '', error: '' } } : undefined) } });
    expect(await codeOf(r.provider.submit(req(1)))).toBe('JOB_REJECTED');
    expect(ledgerEvents()).toEqual(['rejected']);
  });

  it('an empty error string with a uuid is a normal acceptance', async () => {
    r = await rig({ faults: { submit: (): MockFault => ({ kind: 'patch', patch: { error: '' } }) } });
    await r.provider.submit(req(1));
    expect(ledgerEvents()).toEqual(['accepted']);
  });

  it('insufficient funds halts every later submission until a human resumes', async () => {
    r = await rig({ faults: { submit: (n): MockFault | undefined => (n === 1 ? { kind: 'api-error', error: 'API_INSUFFICIENT_FUNDS' } : undefined) } });
    expect(await codeOf(r.provider.submit(req(1)))).toBe('INSUFFICIENT_FUNDS');
    expect(await codeOf(r.provider.submit(req(2)))).toBe('HALTED');
    expect(r.mock.counts.submit).toBe(1);
    r.provider.resume('balance topped up');
    await r.provider.submit(req(2));
    expect(ledgerEvents()).toContain('halted');
  });

  it('a 401 halts too, and the key is not echoed', async () => {
    r = await rig({}, { apiKey: 'sk-wrong-key-999' });
    expect(await codeOf(r.provider.submit(req(1)))).toBe('UNAUTHORIZED');
    expect(await codeOf(r.provider.submit(req(2)))).toBe('HALTED');
    expect(r.mock.counts.submit).toBe(0);
    expect(readFileSync(r.ledgerPath, 'utf8')).not.toContain('sk-wrong-key-999');
  });
});

describe('the provider parallelism cap', () => {
  it('retries when the provider says API_PARALLELISM_LIMIT_REACHED, without losing jobs', async () => {
    r = await rig({ parallelismCap: 3, pollsToDone: 3 }, { maxRetries: 500, maxConcurrent: 10 });
    const assets = await Promise.all(Array.from({ length: 8 }, (_, i) => r.provider.generate(req(i))));
    expect(assets.length).toBe(8);
    expect(r.mock.peakRunning()).toBeLessThanOrEqual(3);
    expect(r.mock.accepted()).toBe(8);
  });
});

describe('timeouts', () => {
  it('a submit that times out is ambiguous and is never retried', async () => {
    r = await rig({ faults: { submit: (n): MockFault | undefined => (n === 1 ? { kind: 'stall' } : undefined) } }, { requestTimeoutMs: 150 });
    const err = await r.provider.submit(req(1)).catch((e) => e as Hyper3dError);
    expect(err).toBeInstanceOf(Hyper3dError);
    expect((err as Hyper3dError).code).toBe('SUBMIT_UNKNOWN');
    expect((err as Hyper3dError).ambiguous).toBe(true);
    expect(r.mock.counts.submit).toBe(1);
    expect(ledgerEvents()).toEqual(['submit_unknown']);
    expect(r.provider.semaphore.active).toBe(0);
    await r.provider.submit(req(2)); // the next request is independent
  });

  it('a dropped connection on submit is ambiguous too', async () => {
    r = await rig({ faults: { submit: (n): MockFault | undefined => (n === 1 ? { kind: 'drop' } : undefined) } });
    expect(await codeOf(r.provider.submit(req(1)))).toBe('SUBMIT_UNKNOWN');
    expect(r.mock.counts.submit).toBe(1);
  });

  it('a 5xx on submit is ambiguous and not retried', async () => {
    r = await rig({ faults: { submit: (n): MockFault | undefined => (n === 1 ? { kind: 'http', status: 503 } : undefined) } });
    expect(await codeOf(r.provider.submit(req(1)))).toBe('SUBMIT_UNKNOWN');
    expect(r.mock.counts.submit).toBe(1);
  });

  it('status polls are idempotent: a timeout and a 5xx are retried with backoff', async () => {
    r = await rig({
      pollsToDone: 1,
      subJobs: 1,
      faults: { status: (n): MockFault | undefined => (n === 1 ? { kind: 'stall' } : n === 2 ? { kind: 'http', status: 502 } : undefined) },
    }, { requestTimeoutMs: 150 });
    const job = await r.provider.submit(req(1));
    expect(await r.provider.poll(job)).toEqual({ status: 'done' });
    expect(r.mock.counts.status).toBe(3);
    expect(r.clock.sleeps.length).toBe(2);
  });

  it('gives up on a poll that never answers, as a typed error', async () => {
    r = await rig({ faults: { status: (): MockFault => ({ kind: 'stall' }) } }, { requestTimeoutMs: 60, maxRetries: 2 });
    const job = await r.provider.submit(req(1));
    expect(await codeOf(r.provider.poll(job))).toBe('TIMEOUT');
  });
});

describe('one submission is several jobs', () => {
  it('is done only when every sub-job is done: the first Done is not enough', async () => {
    r = await rig({ pollsToDone: 1, subJobs: 3 });
    const job = await r.provider.submit(req(1));
    expect(await r.provider.poll(job)).toEqual({ status: 'pending' }); // first part done, the others waiting or generating
    expect(await r.provider.poll(job)).toEqual({ status: 'pending' });
    expect(await r.provider.poll(job)).toEqual({ status: 'done' });
    expect(await codeOf(r.provider.fetch(job))).toBe('RESOLVED');
  });

  it('never asks for a download while any sub-job is unfinished', async () => {
    r = await rig({ pollsToDone: 1, subJobs: 3 });
    const job = await r.provider.submit(req(1));
    expect(await codeOf(r.provider.fetch(job))).toBe('NOT_READY');
    await r.provider.poll(job);
    expect(r.mock.counts.download).toBe(0);
  });

  it('is failed as soon as any sub-job fails', async () => {
    r = await rig({ pollsToDone: 1, subJobs: 3, failJobs: [1] });
    const job = await r.provider.submit(req(1));
    expect((await untilDone(r.provider, job)).status).toBe('failed');
  });

  it('records the sub-job ids in the ledger', async () => {
    r = await rig({ subJobs: 3 });
    await r.provider.submit(req(1));
    expect(new Ledger(r.ledgerPath).entries()[0]!.job_uuids).toEqual(['job-1-part-1', 'job-1-part-2', 'job-1-part-3']);
  });
});

describe('downloads', () => {
  it('retries a silently truncated body and still delivers the file', async () => {
    r = await rig({ faults: { file: (n) => (n === 1 ? 'truncate-silent' : undefined) } });
    const raw = await r.provider.generate(req(1));
    expect(raw.bytes).toEqual(minimalGlb());
    expect(r.mock.counts.file).toBe(2);
    expect(r.provider.spentCredits).toBe(0.5); // retrying a download costs nothing
  });

  it('retries a connection cut mid-body', async () => {
    r = await rig({ faults: { file: (n) => (n === 1 ? 'cut-socket' : undefined) } });
    await r.provider.generate(req(1));
    expect(r.mock.counts.file).toBe(2);
  });

  it('never returns a file that stays truncated or corrupt', async () => {
    r = await rig({ faults: { file: () => 'truncate-silent' } });
    expect(await codeOf(r.provider.generate(req(1)))).toBe('TRUNCATED_DOWNLOAD');
    expect(r.mock.counts.file).toBe(3);
    await r.cleanup();
    r = await rig({ faults: { file: () => 'corrupt' } });
    expect(await codeOf(r.provider.generate(req(1)))).toBe('CORRUPT_DOWNLOAD');
  });

  it('fetch before the job is done is NOT_READY', async () => {
    r = await rig();
    const job = await r.provider.submit(req(1));
    expect(await codeOf(r.provider.fetch(job))).toBe('NOT_READY');
  });
});

describe('a silent tier downgrade or a price change halts spending', () => {
  it('a response that reports a different tier is TIER_DOWNGRADE, ledgered, and stops further submits', async () => {
    r = await rig({ faults: { submit: (n): MockFault | undefined => (n === 1 ? { kind: 'patch', patch: { tier: 'Regular' } } : undefined) } });
    expect(await codeOf(r.provider.submit(req(1)))).toBe('TIER_DOWNGRADE');
    expect(ledgerEvents()).toEqual(['accepted', 'halted']); // the charge is on record
    expect(await codeOf(r.provider.submit(req(2)))).toBe('HALTED');
    expect(r.mock.counts.submit).toBe(1);
  });

  it('a cheaper-than-documented charge is PRICE_DRIFT: the job stands, further spending stops', async () => {
    r = await rig({ consumed: 0.3 });
    const job = await r.provider.submit(req(1));
    expect(r.provider.haltedReason).toMatch(/PRICE_DRIFT.*0\.3.*0\.5/);
    expect(ledgerEvents()).toEqual(['accepted', 'drift', 'halted']);
    expect(await codeOf(r.provider.submit(req(2)))).toBe('HALTED');
    expect(await r.provider.poll(job)).toEqual({ status: 'pending' }); // existing jobs can still be followed
    r.provider.resume('price list re-read');
    await r.provider.submit(req(2));
  });

  it('a response that does not report consumed is treated as drift', async () => {
    r = await rig({ faults: { submit: (): MockFault => ({ kind: 'patch', patch: { consumed: null } }) } });
    await r.provider.submit(req(1));
    expect(r.provider.haltedReason).toMatch(/did not report consumed/);
  });

  it('a premium tier is expected to cost more, and that is not drift', async () => {
    r = await rig({ consumed: (f) => (f.tier === 'Gen-2.5-Extreme-High' ? 1.0 : 0.5) });
    await r.provider.submit(req(1, { tier: 'Gen-2.5-Extreme-High' }));
    expect(r.provider.haltedReason).toBeNull();
    expect(r.provider.spentCredits).toBe(1);
  });
});

describe('the credit ceiling', () => {
  it('refuses a submission that would pass it, without calling the API', async () => {
    r = await rig({}, { maxCredits: 1.0 });
    await r.provider.submit(req(1));
    await r.provider.submit(req(2));
    expect(await codeOf(r.provider.submit(req(3)))).toBe('CREDIT_CEILING');
    expect(r.mock.counts.submit).toBe(2);
  });

  it('holds under concurrency: five at once against a 1.0 ceiling accept exactly two', async () => {
    r = await rig({}, { maxCredits: 1.0 });
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => codeOf(r.provider.submit(req(i)))));
    expect(results.filter((x) => x === 'RESOLVED').length).toBe(2);
    expect(results.filter((x) => x === 'CREDIT_CEILING').length).toBe(3);
    expect(r.mock.accepted()).toBe(2);
  });

  it('a ceiling of zero allows nothing', async () => {
    r = await rig({}, { maxCredits: 0 });
    expect(await codeOf(r.provider.submit(req(1)))).toBe('CREDIT_CEILING');
    expect(r.mock.requests.length).toBe(0);
  });
});

describe('idempotency and resume', () => {
  it('the same request twice is one job and one charge', async () => {
    r = await rig();
    const [a, b] = await Promise.all([r.provider.submit(req(1)), r.provider.submit(req(1))]);
    const c = await r.provider.submit(req(1));
    expect(a.key).toBe(b.key);
    expect(c.key).toBe(a.key);
    expect(r.mock.counts.submit).toBe(1);
    expect(r.provider.spentCredits).toBe(0.5);
  });

  it('a different seed is a different request', async () => {
    r = await rig();
    const a = await r.provider.submit(req(1));
    const b = await r.provider.submit({ ...req(1), seed: 2 });
    expect(a.key).not.toBe(b.key);
  });

  it('a new process resumes from the ledger without paying again', async () => {
    r = await rig({ pollsToDone: 1, subJobs: 1 });
    const job = await r.provider.submit(req(1));
    const { Hyper3dRodinProvider } = await import('../src/index.ts');
    const second = new Hyper3dRodinProvider({ apiKey: 'test-key', baseUrl: r.mock.baseUrl, maxCredits: 1000, ledgerPath: r.ledgerPath, clock: new VirtualClock(), random: () => 0.5 });
    expect((await second.submit(req(1))).key).toBe(job.key);
    expect(r.mock.counts.submit).toBe(1);
    expect(await second.poll(job)).toEqual({ status: 'done' });
    const raw = await second.fetch(job);
    expect(raw.consumed).toBe(0.5);
    expect(raw.paramsDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('survives a torn last ledger line', async () => {
    r = await rig();
    await r.provider.submit(req(1));
    const { appendFileSync } = await import('node:fs');
    appendFileSync(r.ledgerPath, '{"v":1,"at":"2026-');
    const l = new Ledger(r.ledgerPath);
    expect(l.entries().length).toBe(1);
    expect(l.corruptLines).toBe(1);
    expect(l.spentMillicredits()).toBe(500);
  });
});

describe('job failure and deadline', () => {
  it('a job the provider fails is JOB_FAILED, ledgered, and frees its slot', async () => {
    r = await rig({ failJobs: [1], pollsToDone: 1 });
    expect(await codeOf(r.provider.generate(req(1)))).toBe('JOB_FAILED');
    expect(ledgerEvents()).toEqual(['accepted', 'failed']);
    expect(r.provider.semaphore.active).toBe(0);
    await r.provider.generate(req(1)); // a failed job is not resumed: the request may be tried again
  });

  it('a job that never finishes hits the per-job deadline, frees its slot and stays resumable', async () => {
    r = await rig({ pollsToDone: 1_000_000 }, { jobDeadlineMs: 60_000, pollIntervalMs: 5000 });
    expect(await codeOf(r.provider.generate(req(1)))).toBe('JOB_DEADLINE');
    expect(r.provider.semaphore.active).toBe(0);
    expect(ledgerEvents()).toEqual(['accepted']);
    expect(r.clock.slept).toBeGreaterThanOrEqual(60_000);
  });
});
