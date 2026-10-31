import { createHash } from 'node:crypto';
import { NotConfiguredError, notConfiguredProvider, type AssetProvider, type AssetRequest, type JobRef, type JobState, type RawAsset } from '@kensho/ir';
import { resolveApiKey, redact } from './env.ts';
import { Hyper3dError } from './errors.ts';
import { checkGlbContainer } from './glb.ts';
import { Ledger, type LedgerEntry, type LedgerEvent } from './ledger.ts';
import { Semaphore, TokenBucket, backoffMs, defaultRandom, realClock, type Clock } from './limits.ts';
import { expectedMillicredits, normalizeRequest, paramsDigest, type NormalizedRequest, type RodinParams } from './params.ts';

export const RODIN_PROVIDER_ID = 'hyper3d-rodin/gen-2.5';
export const DEFAULT_BASE_URL = 'https://api.hyper3d.com/api/v2';

export interface RodinConfig {
  /** Explicit key, for tests. Normally leave unset and let `HYPER3D_API_KEY` resolve. */
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  baseUrl?: string;
  /** Required for any host other than loopback. Without it a real endpoint is refused, so nothing is spent by accident. */
  allowLive?: boolean;
  /** Hard ceiling for the whole ledger, in credits. There is no default: a budget must be chosen. */
  maxCredits: number;
  ledgerPath: string;
  /** Requests per minute (the plan card shows 120). */
  rpm?: number;
  /** Concurrent jobs (the plan allows 10). */
  maxConcurrent?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  pollIntervalMs?: number;
  jobDeadlineMs?: number;
  allowLegacyTier?: boolean;
  clock?: Clock;
  random?: () => number;
  fetch?: typeof fetch;
}

interface JobRecord {
  key: string;
  uuid: string;
  subscriptionKey: string | undefined;
  params: RodinParams;
  consumedMc: number | undefined;
  digest: string;
  done: boolean;
}

type HaltCode = 'TIER_DOWNGRADE' | 'PRICE_DRIFT' | 'UNAUTHORIZED' | 'INSUFFICIENT_FUNDS';

interface HttpResult {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  text: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Rodin REST client: rate limited, concurrency limited, ledgered, and fail-closed on anything it cannot explain. */
export class Hyper3dRodinProvider implements AssetProvider {
  readonly id = RODIN_PROVIDER_ID;
  readonly ledger: Ledger;
  readonly semaphore: Semaphore;
  readonly clock: Clock;
  private readonly key: string;
  private readonly base: URL;
  private readonly bucket: TokenBucket;
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;
  private readonly cfg: Required<Pick<RodinConfig, 'requestTimeoutMs' | 'maxRetries' | 'backoffBaseMs' | 'backoffCapMs' | 'pollIntervalMs' | 'jobDeadlineMs' | 'allowLegacyTier'>>;
  private readonly ceilingMc: number;
  private reservedMc = 0;
  private halted: { code: HaltCode; reason: string } | null = null;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly slots = new Map<string, () => void>();
  private readonly inflight = new Map<string, Promise<JobRef>>();

  constructor(config: RodinConfig & { apiKey: string }) {
    this.key = config.apiKey;
    this.base = new URL(config.baseUrl ?? DEFAULT_BASE_URL);
    if (!LOOPBACK.has(this.base.hostname) && !config.allowLive) {
      throw new Hyper3dError('LIVE_DISABLED', `${this.base.origin} is not loopback and allowLive is not set: refusing to spend credits`);
    }
    if (!(config.maxCredits >= 0) || !Number.isFinite(config.maxCredits)) throw new Hyper3dError('INVALID_REQUEST', 'maxCredits must be a non-negative number');
    this.ceilingMc = Math.round(config.maxCredits * 1000);
    this.clock = config.clock ?? realClock;
    this.random = config.random ?? defaultRandom;
    this.fetchImpl = config.fetch ?? fetch;
    this.bucket = new TokenBucket(config.rpm ?? 120, this.clock);
    this.semaphore = new Semaphore(config.maxConcurrent ?? 10);
    this.ledger = new Ledger(config.ledgerPath);
    this.cfg = {
      requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
      maxRetries: config.maxRetries ?? 5,
      backoffBaseMs: config.backoffBaseMs ?? 1_000,
      backoffCapMs: config.backoffCapMs ?? 30_000,
      pollIntervalMs: config.pollIntervalMs ?? 5_000,
      jobDeadlineMs: config.jobDeadlineMs ?? 300_000,
      allowLegacyTier: config.allowLegacyTier ?? false,
    };
  }

  // ---- state the caller may inspect ----
  get haltedReason(): string | null {
    return this.halted ? `${this.halted.code}: ${this.halted.reason}` : null;
  }
  get spentCredits(): number {
    return this.ledger.spentMillicredits() / 1000;
  }
  /** Clears a halt after a human has looked at it. The reason is written to the ledger. */
  resume(reason: string): void {
    if (this.halted) this.ledger.append(this.entry('halted', 'resume', { note: `resumed: ${reason}` }));
    this.halted = null;
  }

  // ---- AssetProvider ----
  async submit(req: AssetRequest): Promise<JobRef> {
    const n = normalizeRequest(req, { allowLegacyTier: this.cfg.allowLegacyTier });
    const ref: JobRef = { providerId: this.id, key: n.key };
    if (this.lookup(n.key)) return ref; // already paid for: resume
    const pending = this.inflight.get(n.key);
    if (pending) return pending;
    const p = this.submitNew(n).finally(() => this.inflight.delete(n.key));
    this.inflight.set(n.key, p);
    return p;
  }

  async poll(job: JobRef): Promise<JobState> {
    const rec = this.recordOf(job);
    if (rec.done) return { status: 'done' };
    if (!rec.subscriptionKey) throw new Hyper3dError('PROTOCOL', `job ${rec.uuid} has no subscription key to poll with`);
    const res = await this.retrying('POST', '/status', () => this.json({ subscription_key: rec.subscriptionKey }));
    const body = this.parse(res);
    this.rejectIfError(body, 'status');
    const jobs = Array.isArray(body.jobs) ? (body.jobs as { uuid?: string; status?: string }[]) : null;
    if (!jobs || jobs.length === 0) throw new Hyper3dError('PROTOCOL', 'status response has no jobs');
    // one submission fans out into several jobs (the live API returns three); it is done only when every one is
    const states = jobs.map((j) => String(j.status ?? '').toLowerCase());
    const status = states.some((x) => x === 'failed' || x === 'error') ? 'failed' : states.every((x) => x === 'done') ? 'done' : 'pending';
    if (status === 'done') {
      rec.done = true;
      this.releaseSlot(rec.key);
      return { status: 'done' };
    }
    if (status === 'failed') {
      this.ledger.append(this.entry('failed', rec.key, { uuid: rec.uuid, note: 'provider reported a job failed' }));
      this.releaseSlot(rec.key);
      this.jobs.delete(rec.key); // a failed job is not resumed: the same request may be submitted again
      return { status: 'failed', detail: 'the provider reported the job failed' };
    }
    return { status: 'pending' };
  }

  async fetch(job: JobRef): Promise<RawAsset> {
    const rec = this.recordOf(job);
    if (!rec.done) throw new Hyper3dError('NOT_READY', `job ${rec.uuid} is not done`);
    let last: Hyper3dError | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const listing = this.parse(await this.retrying('POST', '/download', () => this.json({ task_uuid: rec.uuid })));
        this.rejectIfError(listing, 'download');
        const list = Array.isArray(listing.list) ? (listing.list as { name?: string; url?: string }[]) : [];
        const item = list.find((f) => nonEmpty(f.name) && f.name.toLowerCase().endsWith('.glb') && nonEmpty(f.url));
        if (!item) throw new Hyper3dError('PROTOCOL', 'the download list has no .glb file');
        const url = new URL(item.url!);
        if (url.protocol !== 'https:' && !LOOPBACK.has(url.hostname)) throw new Hyper3dError('PROTOCOL', `refusing to download over ${url.protocol}`);
        const file = await this.retrying('GET', url.href, () => ({ method: 'GET', url: url.href, auth: false }), true);
        if (file.status !== 200) throw new Hyper3dError('PROTOCOL', `download answered ${file.status}`);
        const declared = file.headers.get('content-length');
        if (declared !== null && Number(declared) !== file.bytes.length) throw new Hyper3dError('TRUNCATED_DOWNLOAD', `Content-Length ${declared}, received ${file.bytes.length}`);
        checkGlbContainer(file.bytes);
        const sha256 = createHash('sha256').update(file.bytes).digest('hex');
        this.ledger.append(this.entry('downloaded', rec.key, { uuid: rec.uuid, sha256, bytes: file.bytes.length }));
        return { bytes: file.bytes, providerId: this.id, paramsDigest: rec.digest, consumed: (rec.consumedMc ?? 0) / 1000 };
      } catch (e) {
        if (e instanceof Hyper3dError && (e.code === 'TRUNCATED_DOWNLOAD' || e.code === 'CORRUPT_DOWNLOAD')) last = e;
        else throw e;
      }
    }
    throw last!;
  }

  /** Submit, poll until done or the per-job deadline, then fetch. A deadline leaves the job accepted and resumable. */
  async generate(req: AssetRequest): Promise<RawAsset> {
    const job = await this.submit(req);
    const rec = this.recordOf(job);
    const start = this.clock.now();
    let interval = this.cfg.pollIntervalMs;
    for (;;) {
      const s = await this.poll(job);
      if (s.status === 'done') break;
      if (s.status === 'failed') throw new Hyper3dError('JOB_FAILED', `job ${rec.uuid} failed at the provider`);
      if (this.clock.now() - start >= this.cfg.jobDeadlineMs) {
        this.releaseSlot(rec.key);
        throw new Hyper3dError('JOB_DEADLINE', `job ${rec.uuid} was not done after ${this.cfg.jobDeadlineMs} ms; it stays accepted in the ledger`);
      }
      await this.clock.sleep(interval);
      interval = Math.min(interval * 1.5, 30_000 /* the documented polling ceiling */);
    }
    return this.fetch(job);
  }

  // ---- internals ----
  private entry(event: LedgerEvent, key: string, extra: Partial<LedgerEntry> = {}): LedgerEntry {
    return { v: 1 as const, at: new Date(this.clock.now()).toISOString(), event, provider: this.id, key, ...extra };
  }

  private lookup(key: string): JobRecord | undefined {
    const cached = this.jobs.get(key);
    if (cached) return cached;
    const acc = this.ledger.accepted(key);
    if (!acc || !acc.uuid) return undefined;
    const rec: JobRecord = { key, uuid: acc.uuid, subscriptionKey: acc.subscription_key, params: { tier: acc.tier ?? '', geometry_file_format: 'glb' }, consumedMc: acc.consumed_mc, digest: acc.params_digest ?? '', done: false };
    this.jobs.set(key, rec);
    return rec;
  }

  private recordOf(job: JobRef): JobRecord {
    const rec = this.lookup(job.key);
    if (!rec) throw new Hyper3dError('UNKNOWN_JOB', `no accepted job for ${job.key.slice(0, 12)}`);
    return rec;
  }

  private releaseSlot(key: string): void {
    const r = this.slots.get(key);
    if (r) {
      this.slots.delete(key);
      r();
    }
  }

  private assertNotHalted(): void {
    if (this.halted) throw new Hyper3dError('HALTED', `no further submissions: ${this.halted.code}: ${this.halted.reason}`);
  }

  private halt(code: HaltCode, reason: string, key: string): void {
    this.halted = { code, reason };
    this.ledger.append(this.entry('halted', key, { note: `${code}: ${reason}` }));
  }

  private async submitNew(n: NormalizedRequest): Promise<JobRef> {
    this.assertNotHalted();
    const expected = expectedMillicredits(n.params);
    const release = await this.semaphore.acquire();
    let handedOver = false;
    let reserved = 0;
    try {
      this.assertNotHalted();
      if (this.lookup(n.key)) return { providerId: this.id, key: n.key };
      if (this.ledger.spentMillicredits() + this.reservedMc + expected > this.ceilingMc) {
        throw new Hyper3dError('CREDIT_CEILING', `${(this.ledger.spentMillicredits() + this.reservedMc + expected) / 1000} credits would pass the ceiling of ${this.ceilingMc / 1000}`);
      }
      this.reservedMc += expected;
      reserved = expected;
      const rec = await this.postSubmit(n, expected);
      this.jobs.set(n.key, rec);
      this.slots.set(n.key, release);
      handedOver = true;
      return { providerId: this.id, key: n.key };
    } finally {
      this.reservedMc -= reserved;
      if (!handedOver) release();
    }
  }

  private form(n: NormalizedRequest): FormData {
    const f = new FormData();
    f.append('prompt', n.prompt);
    f.append('tier', n.params.tier); // always sent: omitting it silently selects a legacy generation
    f.append('seed', String(n.seed));
    f.append('geometry_file_format', n.params.geometry_file_format);
    if (n.params.mesh_mode) f.append('mesh_mode', n.params.mesh_mode);
    if (n.params.quality_override !== undefined) f.append('quality_override', String(n.params.quality_override));
    if (n.params.texture_mode) f.append('texture_mode', n.params.texture_mode);
    if (n.params.uhd_texture !== undefined) f.append('uhd_texture', String(n.params.uhd_texture));
    for (const a of n.params.addons ?? []) f.append('addons', a);
    for (const b of n.params.bbox_condition ?? []) f.append('bbox_condition', String(b));
    if (n.params.TAPose !== undefined) f.append('TAPose', String(n.params.TAPose));
    return f;
  }

  private async postSubmit(n: NormalizedRequest, expectedMc: number): Promise<JobRecord> {
    const common = { seed: n.seed, tier: n.params.tier, params_digest: paramsDigest(n.params), expected_mc: expectedMc };
    for (let attempt = 0; ; attempt++) {
      await this.bucket.take();
      let res: HttpResult;
      try {
        res = await this.http({ method: 'POST', url: this.api('/rodin'), body: this.form(n), auth: true });
      } catch (e) {
        // the request may have been delivered and charged: never retry it blindly
        this.ledger.append(this.entry('submit_unknown', n.key, { ...common, note: (e as Error).message.slice(0, 200) }));
        throw new Hyper3dError('SUBMIT_UNKNOWN', `${(e as Error).message}; the job may or may not exist at the provider, check the dashboard before resubmitting`, { ambiguous: true });
      }
      const retryDelay = (floorMs = 0) => backoffMs(attempt, { baseMs: this.cfg.backoffBaseMs, capMs: this.cfg.backoffCapMs, random: this.random, floorMs });
      if (res.status === 429) {
        if (attempt >= this.cfg.maxRetries) throw new Hyper3dError('RATE_LIMITED', `still throttled after ${attempt + 1} attempts`);
        await this.clock.sleep(retryDelay(this.retryAfterMs(res)));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        this.halt('UNAUTHORIZED', `HTTP ${res.status}`, n.key);
        throw new Hyper3dError('UNAUTHORIZED', `HTTP ${res.status}: the API key was refused`);
      }
      if (res.status >= 500) {
        this.ledger.append(this.entry('submit_unknown', n.key, { ...common, note: `HTTP ${res.status}` }));
        throw new Hyper3dError('SUBMIT_UNKNOWN', `HTTP ${res.status} on submit; the job may or may not exist`, { ambiguous: true });
      }
      let body: Record<string, unknown>;
      try {
        body = this.parse(res);
      } catch (e) {
        if (res.status >= 400) throw new Hyper3dError('BAD_REQUEST', `HTTP ${res.status}`);
        this.ledger.append(this.entry('submit_unknown', n.key, { ...common, note: 'unparseable success response' }));
        throw new Hyper3dError('SUBMIT_UNKNOWN', `${(e as Error).message}; the job may or may not exist`, { ambiguous: true });
      }
      const err = nonEmpty(body.error) ? body.error : null;
      if (err || res.status >= 400) {
        const text = err ?? `HTTP ${res.status}`;
        if (/PARALLELISM/i.test(text) && attempt < this.cfg.maxRetries) {
          await this.clock.sleep(retryDelay());
          continue;
        }
        this.ledger.append(this.entry('rejected', n.key, { ...common, note: text.slice(0, 200) }));
        if (/INSUFFICIENT_FUNDS/i.test(text)) {
          this.halt('INSUFFICIENT_FUNDS', text, n.key);
          throw new Hyper3dError('INSUFFICIENT_FUNDS', text);
        }
        if (/PARALLELISM/i.test(text)) throw new Hyper3dError('PARALLELISM_LIMIT', text);
        if (/CONTENT_VIOLATION|NOT_FOUND_ON_IMAGE/i.test(text)) throw new Hyper3dError('CONTENT_VIOLATION', text);
        throw new Hyper3dError(res.status >= 400 ? 'BAD_REQUEST' : 'JOB_REJECTED', text);
      }
      // HTTP success is not acceptance: a job exists only with no error and a non-empty uuid
      if (!nonEmpty(body.uuid)) {
        this.ledger.append(this.entry('rejected', n.key, { ...common, note: 'success response without a uuid' }));
        throw new Hyper3dError('JOB_REJECTED', 'the response had no error but no job uuid either');
      }
      const sub = (body.jobs as { subscription_key?: unknown } | undefined)?.subscription_key;
      const consumed = typeof body.consumed === 'number' && Number.isFinite(body.consumed) ? Math.round(body.consumed * 1000) : undefined;
      const rec: JobRecord = { key: n.key, uuid: body.uuid, subscriptionKey: nonEmpty(sub) ? sub : undefined, params: n.params, consumedMc: consumed, digest: paramsDigest(n.params), done: false };
      this.ledger.append(this.entry('accepted', n.key, { ...common, uuid: rec.uuid, ...(rec.subscriptionKey ? { subscription_key: rec.subscriptionKey } : {}), ...(Array.isArray((body.jobs as { uuids?: unknown } | undefined)?.uuids) ? { job_uuids: ((body.jobs as { uuids: unknown[] }).uuids).filter(nonEmpty) } : {}), ...(consumed !== undefined ? { consumed_mc: consumed } : {}) }));
      this.jobs.set(n.key, rec);
      const echoed = typeof body.tier === 'string' ? body.tier : undefined;
      if (echoed !== undefined && echoed !== n.params.tier) {
        const why = `requested ${n.params.tier}, the provider reports ${echoed}`;
        this.halt('TIER_DOWNGRADE', why, n.key);
        throw new Hyper3dError('TIER_DOWNGRADE', `${why}; the job was charged and is in the ledger`);
      }
      if (consumed === undefined || consumed !== expectedMc) {
        const why = consumed === undefined ? 'the response did not report consumed' : `consumed ${consumed / 1000} credits, expected ${expectedMc / 1000}`;
        this.ledger.append(this.entry('drift', n.key, { ...common, ...(consumed !== undefined ? { consumed_mc: consumed } : {}), note: why }));
        this.halt('PRICE_DRIFT', why, n.key); // the job stands; further spending waits for a human
      }
      if (!rec.subscriptionKey) throw new Hyper3dError('PROTOCOL', `job ${rec.uuid} was accepted without a subscription key`);
      return rec;
    }
  }

  // ---- HTTP ----
  private api(path: string): string {
    return `${this.base.href.replace(/\/$/, '')}${path}`;
  }

  private json(payload: Record<string, unknown>) {
    return { method: 'POST' as const, url: '', body: JSON.stringify(payload), auth: true, json: true };
  }

  private parse(res: HttpResult): Record<string, unknown> {
    try {
      const v = JSON.parse(res.text) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* fall through */
    }
    throw new Hyper3dError('PROTOCOL', `HTTP ${res.status} with a body that is not a JSON object`);
  }

  private rejectIfError(body: Record<string, unknown>, what: string): void {
    if (nonEmpty(body.error)) throw new Hyper3dError('JOB_REJECTED', `${what}: ${body.error}`);
  }

  private retryAfterMs(res: HttpResult): number {
    const v = Number(res.headers.get('retry-after'));
    return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : 0;
  }

  /**
   * Idempotent requests (status, download, file) retry on timeouts, network errors, 5xx and 429, with
   * backoff, within the token bucket. Submit never goes through here.
   */
  private async retrying(
    method: string,
    path: string,
    build: () => { method: string; url: string; body?: string; auth: boolean; json?: boolean },
    absolute = false,
  ): Promise<HttpResult> {
    let lastError: Hyper3dError | null = null;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      if (!absolute) await this.bucket.take(); // only the API is rate limited, not the file host
      const spec = build();
      try {
        const res = await this.http({ ...spec, url: absolute ? spec.url : this.api(path) });
        if (res.status === 429 || res.status >= 500) {
          lastError = new Hyper3dError(res.status === 429 ? 'RATE_LIMITED' : 'NETWORK', `${method} ${absolute ? 'file' : path} answered ${res.status}`);
          await this.clock.sleep(backoffMs(attempt, { baseMs: this.cfg.backoffBaseMs, capMs: this.cfg.backoffCapMs, random: this.random, floorMs: this.retryAfterMs(res) }));
          continue;
        }
        return res;
      } catch (e) {
        if (!(e instanceof Hyper3dError) || (e.code !== 'TIMEOUT' && e.code !== 'NETWORK')) throw e;
        lastError = e;
        await this.clock.sleep(backoffMs(attempt, { baseMs: this.cfg.backoffBaseMs, capMs: this.cfg.backoffCapMs, random: this.random }));
      }
    }
    throw lastError ?? new Hyper3dError('NETWORK', 'request failed');
  }

  private async http(spec: { method: string; url: string; body?: string | FormData; auth: boolean; json?: boolean }): Promise<HttpResult> {
    const headers: Record<string, string> = {};
    // the key goes only to the API origin: never to a download host named in a response
    if (spec.auth) headers.authorization = `Bearer ${this.key}`;
    if (spec.json) headers['content-type'] = 'application/json';
    try {
      const r = await this.fetchImpl(spec.url, {
        method: spec.method,
        headers,
        ...(spec.body !== undefined ? { body: spec.body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
      });
      const bytes = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, headers: r.headers, bytes, text: new TextDecoder().decode(bytes) };
    } catch (e) {
      const err = e as Error & { name: string; cause?: unknown };
      const name = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
      throw new Hyper3dError(name, redact(`${spec.method} ${new URL(spec.url).pathname}: ${err.message}`, this.key));
    }
  }
}

/**
 * The AssetProvider for this service. Without a key it is a stub whose methods throw NOT_CONFIGURED, so an
 * unconfigured checkout can never reach the network.
 */
export function createHyper3dRodin(config: RodinConfig): Hyper3dRodinProvider | AssetProvider {
  const apiKey = config.apiKey?.trim() || resolveApiKey({ ...(config.env ? { env: config.env } : {}), ...(config.envFile ? { envFile: config.envFile } : {}) });
  if (!apiKey) return notConfiguredProvider(RODIN_PROVIDER_ID);
  return new Hyper3dRodinProvider({ ...config, apiKey });
}

export { NotConfiguredError };
