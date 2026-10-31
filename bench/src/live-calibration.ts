import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '@kensho/cli';
import type { AssetGateReport } from '@kensho/gates-asset';
import { Hyper3dRodinProvider, Ledger, resolveApiKey, toAssetRequest, webPreset, type RodinConfig } from '@kensho/hyper3d_rodin';
import type { AssetRequest, JobRef } from '@kensho/ir';
import { OUT_DIR, ROOT } from './paths.ts';
import type { RealManifest } from './real-assets.ts';

/**
 * Live wire calibration against the real Rodin REST API, under a hard credit ceiling.
 * Usage: pnpm live-calibration [--dry-run] [--stage first|rest|all]
 * The key comes from .env (never printed, never logged). Everything is written under bench/out/live/.
 */
const CEILING_CREDITS = 5;
const LIVE_DIR = join(OUT_DIR, 'live');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const stage = (args.includes('--stage') ? args[args.indexOf('--stage') + 1] : 'all') as 'first' | 'rest' | 'all';

interface Planned {
  id: string;
  purpose: string;
  req: AssetRequest;
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'corpus/assets/real/golem.manifest.json'), 'utf8')) as RealManifest;
const promptOf = (id: string) => manifest.assets.find((a) => a.id === id)!.raw.job.prompt;
const CRATE = 'a plain wooden crate, boxy, game prop';
const base = webPreset();
const mk = (prompt: string, seed: number, over: Record<string, unknown> = {}): AssetRequest =>
  toAssetRequest({ prompt, seed, assetClass: 'prop', params: { ...base, ...over } as never });

const PLAN: Planned[] = [
  { id: 'j01_chest_web20k', purpose: 'first job alone: consumed, polling, download; the web preset', req: mk(promptOf('chest'), 1) },
  { id: 'j02_chest_q5000', purpose: 'triangle count at the mobile prop budget', req: mk(promptOf('chest'), 1, { quality_override: 5000 }) },
  { id: 'j03_crate_bbox_200_100_50', purpose: 'bbox_condition axis order', req: mk(CRATE, 1, { quality_override: 5000, bbox_condition: '200,100,50' }) },
  { id: 'j04_crate_bbox_50_100_200', purpose: 'bbox_condition axis order', req: mk(CRATE, 1, { quality_override: 5000, bbox_condition: '50,100,200' }) },
  { id: 'j05_crate_bbox_100_200_50', purpose: 'bbox_condition axis order', req: mk(CRATE, 1, { quality_override: 5000, bbox_condition: '100,200,50' }) },
  { id: 'j06_toolbox_q5000', purpose: 'a second frozen prompt at the mobile budget', req: mk(promptOf('toolbox'), 1, { quality_override: 5000 }) },
  { id: 'j07_laptop_q5000', purpose: 'a third frozen prompt at the mobile budget', req: mk(promptOf('laptop'), 1, { quality_override: 5000 }) },
  { id: 'j08_chest_q5000_seed2', purpose: 'seed variance', req: mk(promptOf('chest'), 2, { quality_override: 5000 }) },
  { id: 'j09_vault_high_q5000', purpose: 'price of Gen-2.5-High, which the frozen vault door used', req: mk(promptOf('vault_door'), 1, { quality_override: 5000, tier: 'Gen-2.5-High' }) },
  { id: 'j10_chest_highpack', purpose: 'addons encoding and 4K texture with HighPack', req: mk(promptOf('chest'), 1, { quality_override: 5000, addons: 'HighPack' }) },
];

// wire records accumulate across runs, so a resumed job keeps its earlier history
const wirePath = join(LIVE_DIR, 'wire.json');
const wire: Record<string, unknown>[] = existsSync(wirePath) ? (JSON.parse(readFileSync(wirePath, 'utf8')) as Record<string, unknown>[]) : [];
const hdrs = ['content-type', 'content-length', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'date'];
const scrub = (t: string) => t.replace(/([?&][^"\s]*)(X-[A-Za-z-]+|Signature|Credential|Token)=[^&"\s]*/g, '$1$2=[redacted]').replace(/https:\/\/[^"\s?]+\?[^"\s]*/g, (u) => u.split('?')[0] + '?[query removed]');

/** A fetch that records what crossed the wire, without the key and without signed URL queries. */
const tap: typeof fetch = async (input, init) => {
  const url = String(input);
  const t0 = Date.now();
  const res = await fetch(input, init);
  const entry: Record<string, unknown> = { at: new Date(t0).toISOString(), ms: Date.now() - t0, method: init?.method ?? 'GET', url: scrub(url), status: res.status, headers: Object.fromEntries(hdrs.map((h) => [h, res.headers.get(h)]).filter(([, v]) => v !== null)) };
  if (init?.body instanceof FormData) entry.request_fields = [...init.body.keys()].filter((k, i, a) => a.indexOf(k) === i);
  else if (typeof init?.body === 'string') entry.request_body_keys = Object.keys(JSON.parse(init.body));
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json')) entry.response_body = scrub((await res.clone().text()).slice(0, 3000));
  wire.push(entry);
  return res;
};

interface JobResult {
  id: string;
  purpose: string;
  status: 'ok' | 'error';
  error?: string;
  uuid?: string;
  consumed?: number;
  expected_credits?: number;
  submit_ms?: number;
  polls?: { at_ms: number; status: string }[];
  total_ms?: number;
  download_ms?: number;
  bytes?: number;
  sha256?: string;
  glb?: string;
  gate?: Record<string, { verdict: string; codes: string[]; triangles: number; images: number; texture_max_dim: number; bbox_um: number[] | undefined }>;
}

async function gate(file: string, tier: 'mobile' | 'desktop'): Promise<AssetGateReport> {
  let out = '';
  await main(['asset-gate', file, '--tier', tier, '--class', 'prop', '--body', 'dynamic', '--timeout-ms', '300000'], { stdout: (t) => void (out += t), stderr: () => {} });
  return JSON.parse(out) as AssetGateReport;
}

async function runJob(p: Hyper3dRodinProvider, plan: Planned): Promise<JobResult> {
  const r: JobResult = { id: plan.id, purpose: plan.purpose, status: 'error' };
  const t0 = Date.now();
  try {
    const ts = Date.now();
    const job: JobRef = await p.submit(plan.req);
    r.submit_ms = Date.now() - ts;
    const acc = new Ledger(p.ledger.path).accepted(job.key);
    r.uuid = acc?.uuid;
    r.consumed = acc?.consumed_mc !== undefined ? acc.consumed_mc / 1000 : undefined;
    r.expected_credits = acc?.expected_mc !== undefined ? acc.expected_mc / 1000 : undefined;
    r.polls = [];
    let wait = 5000; // the documented polling guidance: begin at 5 s, back off to 30 s
    for (;;) {
      await new Promise((res) => setTimeout(res, wait));
      const s = await p.poll(job);
      r.polls.push({ at_ms: Date.now() - t0, status: s.status });
      if (s.status === 'done') break;
      if (s.status === 'failed') throw new Error('the provider reported the job failed');
      if (Date.now() - t0 > 900_000) throw new Error('client deadline of 15 minutes passed');
      wait = Math.min(Math.round(wait * 1.5), 30_000);
    }
    const td = Date.now();
    const raw = await p.fetch(job);
    r.download_ms = Date.now() - td;
    r.total_ms = Date.now() - t0;
    r.bytes = raw.bytes.length;
    r.sha256 = createHash('sha256').update(raw.bytes).digest('hex');
    mkdirSync(join(LIVE_DIR, 'glb'), { recursive: true });
    const file = join(LIVE_DIR, 'glb', `${plan.id}.glb`);
    writeFileSync(file, raw.bytes);
    r.glb = `glb/${plan.id}.glb`;
    r.gate = {};
    for (const tier of ['mobile', 'desktop'] as const) {
      const g = await gate(file, tier);
      r.gate[tier] = { verdict: g.verdict, codes: [...new Set(g.diagnostics.map((d) => d.code))], triangles: g.measures.triangles as number, images: g.measures.images as number, texture_max_dim: g.measures.texture_max_dim as number, bbox_um: g.measures.bbox_um as number[] | undefined };
    }
    r.status = 'ok';
  } catch (e) {
    r.error = (e as Error).message.slice(0, 400);
    r.total_ms = Date.now() - t0;
  }
  return r;
}

async function main2(): Promise<number> {
  const key = resolveApiKey({ envFile: join(ROOT, '.env') });
  if (!key) {
    console.error('[live] HYPER3D_API_KEY is empty or missing in .env; nothing was sent.');
    return 3;
  }
  console.error(`[live] key present (${key.length} characters, not shown); ceiling ${CEILING_CREDITS} credits; ${dry ? 'DRY RUN' : 'LIVE'}`);
  if (dry) {
    for (const p of PLAN) console.error(`  ${p.id}: ${p.purpose}`);
    return 0;
  }
  mkdirSync(LIVE_DIR, { recursive: true });
  const cfg: RodinConfig & { apiKey: string } = { apiKey: key, allowLive: true, maxCredits: CEILING_CREDITS, ledgerPath: join(LIVE_DIR, 'ledger.jsonl'), fetch: tap, jobDeadlineMs: 900_000 };
  const p = new Hyper3dRodinProvider(cfg);
  const resultsPath = join(LIVE_DIR, 'jobs.json');
  const results: JobResult[] = existsSync(resultsPath) ? (JSON.parse(readFileSync(resultsPath, 'utf8')) as JobResult[]) : [];
  const done = new Set(results.filter((r) => r.status === 'ok').map((r) => r.id));
  const save = () => {
    writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n');
    writeFileSync(join(LIVE_DIR, 'wire.json'), JSON.stringify(wire, null, 2) + '\n');
  };
  const record = (r: JobResult) => {
    const i = results.findIndex((x) => x.id === r.id);
    if (i >= 0) results[i] = r;
    else results.push(r);
    save();
    console.error(`[live] ${r.id}: ${r.status}${r.error ? ' ' + r.error : ''} consumed=${r.consumed ?? '-'} polls=${r.polls?.length ?? 0} total=${r.total_ms}ms spent=${p.spentCredits}`);
  };

  const todo = (ids: string[]) => PLAN.filter((x) => ids.includes(x.id) && !done.has(x.id));
  if (stage === 'first' || stage === 'all') {
    for (const j of todo([PLAN[0]!.id])) record(await runJob(p, j));
  }
  if (stage === 'rest' || stage === 'all') {
    const first = results.find((r) => r.id === PLAN[0]!.id);
    if (first?.status !== 'ok') {
      console.error('[live] the first job did not complete cleanly; not going further.');
      return 1;
    }
    if (p.haltedReason) {
      console.error(`[live] halted: ${p.haltedReason}`);
      return 1;
    }
    // same-cost jobs together, then the two that change the price list
    const sameCost = PLAN.slice(1, 8).map((x) => x.id);
    await Promise.all(todo(sameCost).map(async (j) => record(await runJob(p, j))));
    for (const j of todo(PLAN.slice(8).map((x) => x.id))) {
      if (p.haltedReason) {
        console.error(`[live] halted before ${j.id}: ${p.haltedReason}`);
        break;
      }
      record(await runJob(p, j));
    }
  }
  save();
  console.error(`[live] done. credits spent per ledger: ${p.spentCredits}; halted: ${p.haltedReason ?? 'no'}`);
  return 0;
}

process.exitCode = await main2().catch((e) => {
  console.error('[live] crashed:', (e as Error).message.replace(/Bearer\s+\S+/g, 'Bearer [redacted]'));
  return 2;
});
