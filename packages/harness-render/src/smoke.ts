import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { DOMAINS, hashRecord, type Json } from '@kensho/ir';
import { deriveVerdict, makeDiagnostic, sortDiagnostics, type CheckRecord, type Diagnostic, type Verdict } from '@kensho/diagnostics';
import { bundleHash, loadTrustedPublicKey, verifyBundle, type BundleManifest } from '@kensho/bundle';
import { evaluateProbes, type OutsideProbe, type PageProbe, type Tier } from './evaluate.ts';
import { startServer } from './server.ts';

export const GATE_VERSION = 'g6-subset/0.1.0';
export const REPORT_FORMAT = 'kensho-smoke-report/1';
export const DEFAULT_SMOKE_TIMEOUT_MS = 60_000;
export const CHROMIUM_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

/** Hooks that make a probe fire on purpose, so a probe that cannot fire cannot go unnoticed. */
export const SMOKE_HOOKS = ['stall', 'failed_request', 'bad_shader', 'lose_context', 'gl_error', 'page_exception', 'many_programs'] as const;

export const CHECK_IDS = ['bundle', 'environment', 'load', 'render', 'probes'] as const;

export interface SmokeOptions {
  tier: Tier;
  timeoutMs?: number;
  hooks?: string[];
  /** Folder holding the trusted public key (gate.pub.pem). */
  keyDir?: string;
  frames?: number;
}

export interface SmokeReport {
  kensho: typeof REPORT_FORMAT;
  gate: 'G6';
  gate_version: string;
  bundle: { hash: string | null };
  options: { tier: Tier };
  verdict: Verdict;
  diagnostics: Diagnostic[];
  measures: { [key: string]: Json };
  checks: Record<string, CheckRecord>;
  verdict_hash: string;
  /** The last frame's pixel hash. Kept out of verdict_hash so its stability can be reported separately. */
  frame: { sha256: string; distinct_colours: number } | null;
  environment: { renderer: string | null; chromium: string | null };
  timings_ms: Record<string, number>;
  test_hooks: string[];
}

const skipped = (reason: string): CheckRecord => ({ status: 'not_checked', reason });

function finish(
  partial: { bundleHash: string | null; tier: Tier; diagnostics: Diagnostic[]; measures: { [k: string]: Json }; checks: Record<string, CheckRecord>; frame: SmokeReport['frame']; environment: SmokeReport['environment']; hooks: string[]; timings: Record<string, number> },
): SmokeReport {
  const diagnostics = sortDiagnostics(partial.diagnostics);
  const verdict = deriveVerdict(diagnostics, partial.checks);
  const verdict_hash = hashRecord(DOMAINS.verdict, {
    kensho: REPORT_FORMAT,
    gate: 'G6',
    gate_version: GATE_VERSION,
    bundle_hash: partial.bundleHash,
    options: { tier: partial.tier },
    verdict,
    diagnostics: diagnostics as unknown as Json,
    measures: partial.measures,
    checks: partial.checks as unknown as Json,
    test_hooks: [...partial.hooks].sort(),
  });
  return {
    kensho: REPORT_FORMAT,
    gate: 'G6',
    gate_version: GATE_VERSION,
    bundle: { hash: partial.bundleHash },
    options: { tier: partial.tier },
    verdict,
    diagnostics,
    measures: partial.measures,
    checks: partial.checks,
    verdict_hash,
    frame: partial.frame,
    environment: partial.environment,
    timings_ms: Object.fromEntries(Object.entries(partial.timings).map(([k, v]) => [k, Math.round(v)])),
    test_hooks: [...partial.hooks].sort(),
  };
}

/**
 * The render smoke test. The bundle is verified first and refused (FAIL) before anything is served or
 * loaded. A run that exceeds `timeoutMs`, or that cannot get a SwiftShader WebGL context, is ABSTAIN.
 */
export async function runSmoke(bundleDir: string, opts: SmokeOptions): Promise<SmokeReport> {
  const t0 = Date.now();
  const hooks = opts.hooks ?? [];
  for (const h of hooks) if (!(SMOKE_HOOKS as readonly string[]).includes(h)) throw new Error(`unknown test hook "${h}"`);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
  const keyDir = opts.keyDir ?? join(process.cwd(), '.dev-keys');
  const timings: Record<string, number> = {};
  const environment: SmokeReport['environment'] = { renderer: null, chromium: null };
  const base = { tier: opts.tier, hooks, environment, timings };

  const trusted = loadTrustedPublicKey(keyDir);
  const verified = trusted ? verifyBundle(bundleDir, trusted) : null;
  timings.verify = Date.now() - t0;
  if (!verified || !verified.ok) {
    const diagnostics = verified && !verified.ok ? verified.diagnostics : [makeDiagnostic('BUNDLE_SIGNATURE_INVALID', { pointer: '', message: 'no trusted public key is available' })];
    let hash: string | null = null;
    try {
      hash = bundleHash(JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8')) as BundleManifest);
    } catch {
      /* a manifest that cannot be read has no hash */
    }
    const checks: Record<string, CheckRecord> = { bundle: { status: 'ran' } };
    for (const id of CHECK_IDS.slice(1)) checks[id] = skipped('bundle refused');
    return finish({ ...base, bundleHash: hash, diagnostics, measures: {}, checks, frame: null });
  }

  const checks: Record<string, CheckRecord> = { bundle: { status: 'ran' } };
  const abstainAll = (reason: string) => {
    for (const id of CHECK_IDS.slice(1)) if (!checks[id]) checks[id] = { status: 'abstained', reason };
  };
  let stage = 'starting the server';
  const outside: OutsideProbe = { pageErrors: [], failedRequests: [], badResponses: [] };
  const st: { browser: Browser | null; page: PageProbe | null; fatal: { message: string; ready: boolean } | null } = { browser: null, page: null, fatal: null };

  const manifestBytes = readFileSync(join(bundleDir, 'manifest.json'));
  const assets = new Map<string, string>(verified.manifest.assets.map((a) => [a.path, verified.assetPaths.get(a.id)!]));
  const server = await startServer({ manifest: manifestBytes, assets, hooks: new Set(hooks) });
  let timer: NodeJS.Timeout | undefined;

  const work = (async () => {
    stage = 'launching Chromium';
    const tl = Date.now();
    const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
    st.browser = browser;
    environment.chromium = browser.version();
    timings.launch = Date.now() - tl;
    const context = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
    const pg = await context.newPage();
    pg.on('pageerror', (e) => outside.pageErrors.push(String(e.message ?? e)));
    pg.on('requestfailed', (r) => outside.failedRequests.push({ url: new URL(r.url()).pathname, reason: r.failure()?.errorText ?? '' }));
    pg.on('response', (r) => {
      if (r.status() >= 400) outside.badResponses.push({ url: new URL(r.url()).pathname, status: r.status() });
    });
    stage = 'loading the bundle and rendering';
    const tr = Date.now();
    const query = `?frames=${opts.frames ?? 6}&hooks=${hooks.join(',')}`;
    await pg.goto(server.url + '/' + query, { waitUntil: 'load', timeout: timeoutMs });
    await pg.waitForFunction(() => (window as unknown as { __kensho: { done: boolean } }).__kensho?.done === true, undefined, { timeout: timeoutMs, polling: 50 });
    const result = (await pg.evaluate(() => (window as unknown as { __kensho: { result: unknown } }).__kensho.result)) as PageProbe & { fatal?: string; ready?: boolean };
    timings.render = Date.now() - tr;
    if (result.fatal) st.fatal = { message: result.fatal, ready: result.ready === true };
    else st.page = result;
    // let late exceptions and failed requests surface
    await new Promise((r) => setTimeout(r, 150));
  })();

  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), timeoutMs);
  });
  let outcome: 'done' | 'deadline' | 'error' = 'done';
  let errorMessage = '';
  try {
    outcome = await Promise.race([work.then(() => 'done' as const), deadline]);
  } catch (e) {
    outcome = 'error';
    errorMessage = (e as Error).message;
  } finally {
    clearTimeout(timer);
    void work.catch(() => {}); // a run abandoned at the deadline must not become an unhandled rejection
    await st.browser?.close().catch(() => {});
    await server.close();
  }
  timings.total = Date.now() - t0;
  const common = { ...base, bundleHash: verified.bundleHash };

  if (outcome === 'deadline') {
    abstainAll(`deadline of ${timeoutMs} ms passed while ${stage}`);
    return finish({ ...common, diagnostics: [], measures: {}, checks, frame: null });
  }
  if (outcome === 'error' || (!st.page && !st.fatal)) {
    abstainAll(`could not run: ${errorMessage || 'no result from the page'}`);
    return finish({ ...common, diagnostics: [], measures: {}, checks, frame: null });
  }
  if (st.fatal) {
    const f = st.fatal;
    if (!f.ready) {
      // no WebGL context to render with: the environment, not the world, is at fault
      abstainAll(`no usable WebGL context: ${f.message.split('\n')[0]}`);
      return finish({ ...common, diagnostics: [], measures: {}, checks, frame: null });
    }
    checks.environment = { status: 'ran' };
    checks.load = { status: 'ran' };
    checks.render = { status: 'ran' };
    checks.probes = { status: 'ran' };
    const d = makeDiagnostic('PAGE_EXCEPTION', { pointer: '', message: `the page failed while loading the world: ${f.message.split('\n')[0]!.slice(0, 160)}`, evidence: { count: 1 } });
    return finish({ ...common, diagnostics: [d], measures: { page_exceptions: 1 }, checks, frame: null });
  }

  const probe = st.page!;
  environment.renderer = probe.renderer;
  const isSwift = /swiftshader/i.test(probe.renderer);
  checks.environment = isSwift
    ? { status: 'ran' }
    : { status: 'abstained', reason: `renderer is "${probe.renderer.slice(0, 80)}", not SwiftShader` };
  checks.load = { status: 'ran' };
  checks.render = probe.framesRendered > 0 ? { status: 'ran' } : { status: 'abstained', reason: 'no frame was rendered' };
  const evaluated = evaluateProbes(probe, outside, opts.tier);
  checks.probes = { status: 'ran' };
  return finish({
    ...common,
    diagnostics: evaluated.diagnostics,
    measures: evaluated.measures,
    checks,
    frame: { sha256: probe.frame.sha256, distinct_colours: probe.frame.distinctColours },
  });
}
