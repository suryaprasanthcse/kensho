import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotConfiguredError } from '@kensho/ir';
import { Hyper3dError, Hyper3dRodinProvider, Semaphore, TokenBucket, VirtualClock, backoffMs, createHyper3dRodin, expectedMillicredits, redact, resolveApiKey } from '../src/index.ts';
import { codeOf, req, rig, type Rig } from './helpers.ts';

let r: Rig | undefined;
afterEach(async () => {
  await r?.cleanup();
  r = undefined;
});

describe('token bucket', () => {
  it('allows a burst of one minute of requests, then spaces them at the plan rate', async () => {
    const clock = new VirtualClock();
    const bucket = new TokenBucket(120, clock);
    for (let i = 0; i < 120; i++) await bucket.take();
    expect(clock.sleeps).toEqual([]);
    await bucket.take(); // the 121st waits for half a second: 120 per minute is 2 per second
    expect(clock.slept).toBe(500);
    for (let i = 0; i < 9; i++) await bucket.take();
    expect(clock.slept).toBe(5000);
  });

  it('refills while idle, but never above the burst size', async () => {
    const clock = new VirtualClock();
    const bucket = new TokenBucket(60, clock);
    for (let i = 0; i < 60; i++) await bucket.take();
    await clock.sleep(10 * 60_000);
    clock.sleeps.length = 0;
    for (let i = 0; i < 60; i++) await bucket.take();
    expect(clock.sleeps).toEqual([]);
    await bucket.take();
    expect(clock.sleeps.length).toBe(1);
  });

  it('spaces real provider traffic at the configured rate (sequential, 6 per minute)', async () => {
    r = await rig({ pollsToDone: 1, subJobs: 1 }, { rpm: 6 });
    const start = r.clock.now();
    for (let i = 0; i < 10; i++) await r.provider.generate(req(i));
    // 30 requests: a burst of 6, then 24 more at one per ten seconds
    const elapsed = r.clock.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(235_000);
    expect(elapsed).toBeLessThanOrEqual(245_000);
  });
});

describe('semaphore', () => {
  it('never lets more than its capacity run, and hands slots on in order', async () => {
    const s = new Semaphore(3);
    let active = 0;
    let highest = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const release = await s.acquire();
        active++;
        highest = Math.max(highest, active);
        order.push(i);
        await new Promise((res) => setTimeout(res, 3));
        active--;
        release();
      }),
    );
    expect(highest).toBe(3);
    expect(s.peak).toBe(3);
    expect(s.active).toBe(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('release is idempotent', async () => {
    const s = new Semaphore(1);
    const release = await s.acquire();
    release();
    release();
    expect(s.active).toBe(0);
    await s.acquire();
    expect(s.active).toBe(1);
  });

  it('rejects a capacity that is not a positive integer', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  it('a provider with ten slots keeps at most ten jobs running at the API, out of twenty-five', async () => {
    r = await rig({ pollsToDone: 3 }, { maxConcurrent: 10, rpm: 100_000, jobDeadlineMs: 1e12 });
    const out = await Promise.all(Array.from({ length: 25 }, (_, i) => r!.provider.generate(req(i))));
    expect(out.length).toBe(25);
    expect(r.mock.peakRunning()).toBeLessThanOrEqual(10);
    expect(r.mock.peakRunning()).toBeGreaterThanOrEqual(5);
    expect(r.provider.semaphore.peak).toBeLessThanOrEqual(10);
    expect(r.provider.semaphore.active).toBe(0);
  });
});

describe('backoff', () => {
  const o = { baseMs: 1000, capMs: 30_000 };
  it('doubles, scales by jitter into [0.5, 1), caps, and respects a floor', () => {
    expect(backoffMs(0, { ...o, random: () => 0 })).toBe(500);
    expect(backoffMs(0, { ...o, random: () => 0.999999 })).toBe(1000);
    expect(backoffMs(3, { ...o, random: () => 0 })).toBe(4000);
    expect(backoffMs(20, { ...o, random: () => 0.999999 })).toBe(30_000);
    expect(backoffMs(0, { ...o, random: () => 0, floorMs: 7000 })).toBe(7000);
  });
});

describe('prices', () => {
  it('follow the documented list in thousandths of a credit', () => {
    const p = { geometry_file_format: 'glb' as const };
    expect(expectedMillicredits({ ...p, tier: 'Gen-2.5-Medium' })).toBe(500);
    expect(expectedMillicredits({ ...p, tier: 'Gen-2.5-Extreme-High' })).toBe(1000);
    expect(expectedMillicredits({ ...p, tier: 'Gen-2.5-Extreme-High', texture_mode: 'extreme-high' })).toBe(3000);
  });
});

describe('the real endpoint is refused by default', () => {
  it('will not construct against a non-loopback host without allowLive, and never calls out', () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch;
    for (const baseUrl of [undefined, 'https://api.hyper3d.com/api/v2', 'https://example.com']) {
      expect(() => new Hyper3dRodinProvider({ apiKey: 'k', maxCredits: 1, ledgerPath: join(tmpdir(), 'x.jsonl'), fetch: spy, ...(baseUrl ? { baseUrl } : {}) })).toThrowError(/LIVE_DISABLED/);
    }
    expect(called).toBe(false);
  });

  it('constructs against the real endpoint only with allowLive, still without calling it', () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), 'kensho-live-'));
    try {
      const p = new Hyper3dRodinProvider({ apiKey: 'k', maxCredits: 1, ledgerPath: join(dir, 'l.jsonl'), allowLive: true, fetch: spy });
      expect(p.id).toBe('hyper3d-rodin/gen-2.5');
      expect(called).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires a deliberate credit ceiling', () => {
    expect(() => new Hyper3dRodinProvider({ apiKey: 'k', maxCredits: -1, ledgerPath: join(tmpdir(), 'x.jsonl'), baseUrl: 'http://127.0.0.1:1' })).toThrow();
  });
});

describe('the API key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kensho-env-'));
  const file = (name: string, text: string) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };

  it('comes from process.env first, then from an explicit env file', () => {
    expect(resolveApiKey({ env: { HYPER3D_API_KEY: ' abc ' } })).toBe('abc');
    expect(resolveApiKey({ env: {}, envFile: file('a.env', 'HYPER3D_API_KEY=from-file\n') })).toBe('from-file');
    expect(resolveApiKey({ env: { HYPER3D_API_KEY: 'from-env' }, envFile: file('b.env', 'HYPER3D_API_KEY=from-file\n') })).toBe('from-env');
    expect(resolveApiKey({ env: {}, envFile: file('c.env', '# comment\nOTHER=1\nHYPER3D_API_KEY="quoted-key"\n') })).toBe('quoted-key');
  });

  it('treats an empty value, a missing variable and a missing file as not configured', () => {
    expect(resolveApiKey({ env: { HYPER3D_API_KEY: '' } })).toBeUndefined();
    expect(resolveApiKey({ env: {}, envFile: file('d.env', 'HYPER3D_API_KEY=\n') })).toBeUndefined();
    expect(resolveApiKey({ env: {}, envFile: file('e.env', 'OTHER=1\n') })).toBeUndefined();
    expect(resolveApiKey({ env: {}, envFile: join(dir, 'nope.env') })).toBeUndefined();
  });

  it('never loads the env file into process.env', () => {
    const before = process.env.HYPER3D_API_KEY;
    resolveApiKey({ env: {}, envFile: file('f.env', 'HYPER3D_API_KEY=leak-check\n') });
    expect(process.env.HYPER3D_API_KEY).toBe(before);
  });

  it('without a key the provider is a stub: every method throws NOT_CONFIGURED and nothing is touched', async () => {
    let called = false;
    const p = createHyper3dRodin({ env: {}, maxCredits: 1, ledgerPath: join(dir, 'never.jsonl'), fetch: (async () => ((called = true), new Response('{}'))) as typeof fetch });
    expect(await codeOf(p.submit(req(1)))).toBe('NOT_CONFIGURED');
    await expect(p.poll({ providerId: 'x', key: 'k' })).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(p.fetch({ providerId: 'x', key: 'k' })).rejects.toBeInstanceOf(NotConfiguredError);
    expect(called).toBe(false);
  });

  it('an empty .env value also leaves it a stub', async () => {
    const p = createHyper3dRodin({ env: {}, envFile: file('g.env', 'HYPER3D_API_KEY=\n'), maxCredits: 1, ledgerPath: join(dir, 'never2.jsonl') });
    expect(await codeOf(p.submit(req(1)))).toBe('NOT_CONFIGURED');
  });

  it('with a key from the environment it builds the real client, against the loopback mock', async () => {
    r = await rig();
    const p = createHyper3dRodin({ env: { HYPER3D_API_KEY: 'test-key' }, baseUrl: r.mock.baseUrl, maxCredits: 5, ledgerPath: join(r.dir, 'env.jsonl'), clock: new VirtualClock() });
    expect(p).toBeInstanceOf(Hyper3dRodinProvider);
    await p.submit(req(1));
    expect(r.mock.counts.submit).toBe(1);
  });

  it('redact strips the key from any text', () => {
    expect(redact('Bearer sk-1 and sk-1', 'sk-1')).toBe('Bearer [redacted] and [redacted]');
    expect(redact('nothing', undefined)).toBe('nothing');
  });

  it('the key never reaches the ledger, an error message or a network error', async () => {
    const secret = 'sk-live-do-not-leak-0123456789';
    r = await rig({ apiKey: secret, faults: { submit: (n) => (n === 2 ? { kind: 'http', status: 400, body: { error: 'bad prompt' } } : undefined) } }, { apiKey: secret });
    const messages: string[] = [];
    for (let i = 1; i <= 3; i++) {
      try {
        await r.provider.generate(req(i));
      } catch (e) {
        messages.push((e as Error).message);
      }
    }
    expect(messages.length).toBeGreaterThan(0);
    expect(readFileSync(r.ledgerPath, 'utf8')).not.toContain(secret);
    for (const m of messages) expect(m).not.toContain(secret);
    // and a refused connection, whose underlying message could name the request
    const dead = new Hyper3dRodinProvider({ apiKey: secret, baseUrl: 'http://127.0.0.1:1', maxCredits: 5, ledgerPath: join(r.dir, 'dead.jsonl'), clock: new VirtualClock(), requestTimeoutMs: 300 });
    const err = (await dead.submit(req(9)).catch((e) => e)) as Hyper3dError;
    expect(err.code).toBe('SUBMIT_UNKNOWN');
    expect(err.message).not.toContain(secret);
  });
});
