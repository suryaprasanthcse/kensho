import { spawnSync } from 'node:child_process';
import { cpus, arch, release, type, version as osVersion } from 'node:os';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from '@kensho/cli';
import { VALIDATOR_VERSION, evaluateReport, runAssetGate, type AssetGateReport } from '@kensho/gates-asset';
import { THREE_VERSION, ensureChromium, type SmokeReport } from '@kensho/harness-render';
import { generateAll, readLabels, type LabelEntry } from '@kensho/synthetic_oracle';
import { buildSmokeCases, type SmokeCase } from './bundles.ts';
import { renderMarkdown } from './markdown.ts';
import { ASSET_DIR, KEY_DIR, LABELS_PATH, OUT_DIR, ROOT } from './paths.ts';
import { percentile, wilson } from './stats.ts';

const log = (m: string) => console.error(`[proof] ${m}`);
const require = createRequire(import.meta.url);

async function cli(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  let stdout = '', stderr = '';
  const t0 = performance.now();
  const code = await main(argv, { stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t) }, { ...process.env, ...env });
  return { code, stdout, stderr, ms: performance.now() - t0 };
}

const exitFor = (v: string) => (v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 2);

interface AssetRun {
  exit: number;
  report: AssetGateReport;
  ms: number;
}

async function assetPass(labels: LabelEntry[], pass: number): Promise<Map<string, AssetRun>> {
  const out = new Map<string, AssetRun>();
  let i = 0;
  for (const l of labels) {
    const o = l.options;
    const argv = ['asset-gate', join(ASSET_DIR, l.file), '--tier', o.tier, '--class', o.class, '--body', o.body, ...(o.box_um ? ['--box-um', o.box_um.join(',')] : [])];
    const r = await cli(argv);
    out.set(l.id, { exit: r.code, report: JSON.parse(r.stdout) as AssetGateReport, ms: r.ms });
    if (++i % 40 === 0) log(`asset-gate pass ${pass}: ${i}/${labels.length}`);
  }
  return out;
}

interface SmokeRun {
  exit: number;
  report: SmokeReport;
  ms: number;
}

async function smokePass(cases: SmokeCase[], pass: number): Promise<Map<string, SmokeRun>> {
  const out = new Map<string, SmokeRun>();
  for (const c of cases) {
    const argv = ['smoke', c.dir, '--tier', c.tier, '--timeout-ms', String(c.timeoutMs)];
    const r = await cli(argv, { KENSHO_KEY_DIR: KEY_DIR, KENSHO_TEST_HOOKS: c.hooks.join(',') });
    out.set(c.id, { exit: r.code, report: JSON.parse(r.stdout) as SmokeReport, ms: r.ms });
    log(`smoke pass ${pass}: ${c.id} -> ${out.get(c.id)!.report.verdict}`);
  }
  return out;
}

/** Real processes, so exit codes are checked end to end and not only through the in-process entry point. */
function processExitChecks(labelOf: (id: string) => LabelEntry, smokeDirs: Record<string, string>): { name: string; expected: number; actual: number }[] {
  const tsx = pathToFileURL(require.resolve('tsx')).href;
  const bin = join(ROOT, 'packages', 'cli', 'src', 'bin.ts');
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, ['--import', tsx, bin, ...args], { cwd: ROOT, env: { ...process.env, KENSHO_KEY_DIR: KEY_DIR, ...env }, encoding: 'utf8' }).status ?? -1;
  const file = (id: string) => join(ASSET_DIR, labelOf(id).file);
  return [
    { name: 'asset-gate on a clean control', expected: 0, actual: run(['asset-gate', file('CONTROL-02'), '--tier', 'mobile']) },
    { name: 'asset-gate on a defective fixture', expected: 1, actual: run(['asset-gate', file('TRIANGLE_BUDGET-00'), '--tier', 'mobile', '--class', 'background']) },
    { name: 'asset-gate with a 1 ms deadline', expected: 2, actual: run(['asset-gate', file('CONTROL-02'), '--tier', 'mobile', '--timeout-ms', '1']) },
    { name: 'asset-gate with no tier', expected: 3, actual: run(['asset-gate', file('CONTROL-02')]) },
    { name: 'smoke on an unsigned bundle', expected: 1, actual: run(['smoke', smokeDirs.unsigned!, '--tier', 'mobile']) },
    { name: 'smoke on the clean bundle', expected: 0, actual: run(['smoke', smokeDirs.clean!, '--tier', 'mobile']) },
  ];
}

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

async function proof(): Promise<number> {
  const started = Date.now();
  if (ensureChromium()) log('installed Chromium into the Playwright cache');

  log('regenerating fixtures and checking every SHA-256 against its committed label');
  if (!existsSync(LABELS_PATH)) throw new Error('corpus/assets/labels.json is missing; run "pnpm fixtures write"');
  const committed = readLabels(LABELS_PATH);
  const gen = await generateAll(ASSET_DIR, committed);
  const labels = committed.fixtures;
  const labelOf = (id: string) => labels.find((l) => l.id === id)!;
  log(`${labels.length} fixtures, ${gen.drift.length} hash drift(s)`);

  log('building smoke bundles');
  const cases = await buildSmokeCases();

  const a1 = await assetPass(labels, 1);
  const a2 = await assetPass(labels, 2);

  // fail-closed controls on the asset gate: a hung or crashed check must never pass
  const control = labelOf('CONTROL-02');
  const controlBytes = new Uint8Array(gen.fixtures.find((f) => f.id === control.id)!.bytes);
  const cOpts = { tier: control.options.tier, assetClass: control.options.class, body: control.options.body };
  const failClosed = [
    { name: 'a check that never finishes (stall: textures), 4 s deadline', report: await runAssetGate(controlBytes, cOpts, { timeoutMs: 4000, hooks: { stall: ['textures'] } }) },
    { name: 'a check that hangs the thread (spin: finite), 4 s deadline', report: await runAssetGate(controlBytes, cOpts, { timeoutMs: 4000, hooks: { spin: ['finite'] } }) },
    { name: 'a check that throws (crash: bbox)', report: await runAssetGate(controlBytes, cOpts, { timeoutMs: 4000, hooks: { crash: ['bbox'] } }) },
  ];

  const s1 = await smokePass(cases, 1);
  const s2 = await smokePass(cases, 2);

  const smokeDirs = Object.fromEntries(cases.map((c) => [c.fixture, c.dir]));
  log('checking exit codes from real processes');
  const exits = processExitChecks(labelOf, smokeDirs);

  const chromium = [...s1.values()].map((r) => r.report.environment.chromium).find(Boolean) ?? null;
  const renderer = [...s1.values()].map((r) => r.report.environment.renderer).find(Boolean) ?? null;
  const dirty = git(['status', '--porcelain']).split('\n').filter((l) => l && !l.includes('bench/out')).length;
  const environment = {
    commit: git(['rev-parse', 'HEAD']) || 'unknown',
    working_tree_changes: dirty,
    os: `${type()} ${release()} (${osVersion()}) ${arch()}`,
    cpu: `${cpus()[0]?.model.trim() ?? 'unknown'} x${cpus().length}`,
    node: process.version,
    chromium,
    renderer,
    three: THREE_VERSION,
    playwright: (require('playwright/package.json') as { version: string }).version,
    gltf_validator: VALIDATOR_VERSION,
    started_at: new Date(started).toISOString(),
  };

  // ----- summaries -----
  const codesOf = (r: AssetGateReport) => [...new Set(r.diagnostics.map((d) => d.code))];
  const perCode = new Map<string, { n: number; hits: number; missed: string[] }>();
  const evals = labels.map((l) => ({ label: l, run: a1.get(l.id)!, ev: evaluateReport(a1.get(l.id)!.report, l.expected, l.control) }));
  for (const { label, run } of evals) {
    for (const code of label.expected.codes) {
      const row = perCode.get(code) ?? { n: 0, hits: 0, missed: [] };
      row.n++;
      if (codesOf(run.report).includes(code)) row.hits++;
      else row.missed.push(label.id);
      perCode.set(code, row);
    }
  }
  const controls = evals.filter((e) => e.label.control);
  const falseRejects = controls.filter((e) => e.run.report.verdict !== 'PASS');
  const errorClass = evals.filter((e) => e.label.expected.verdict === 'FAIL');
  const falsePass = errorClass.filter((e) => e.run.report.verdict === 'PASS');
  const abstainOnFixtures = evals.filter((e) => e.run.report.verdict === 'ABSTAIN');
  const mismatches = evals.filter((e) => !e.ev.ok);
  const exitMismatch = [...a1.entries()].filter(([, r]) => r.exit !== exitFor(r.report.verdict)).map(([id]) => id);

  const hashDiffAsset = labels.filter((l) => a1.get(l.id)!.report.verdict_hash !== a2.get(l.id)!.report.verdict_hash).map((l) => l.id);
  const hashDiffSmoke = cases.filter((c) => s1.get(c.id)!.report.verdict_hash !== s2.get(c.id)!.report.verdict_hash).map((c) => c.id);
  const frameRows = cases
    .filter((c) => s1.get(c.id)!.report.frame)
    .map((c) => ({ id: c.id, stable: s1.get(c.id)!.report.frame?.sha256 === s2.get(c.id)!.report.frame?.sha256, sha: s1.get(c.id)!.report.frame?.sha256 ?? '' }));

  const smokeRows = cases.map((c) => {
    const r = s1.get(c.id)!.report;
    const codes = [...new Set(r.diagnostics.map((d) => d.code))];
    const ok = r.verdict === c.expected.verdict && c.expected.codes.every((x) => codes.includes(x)) && (c.positiveControl || codes.every((x) => c.expected.codes.includes(x)));
    return { case: c, verdict: r.verdict, codes, ok, exit: s1.get(c.id)!.exit, ms: s1.get(c.id)!.ms };
  });
  const smokeExitMismatch = smokeRows.filter((r) => r.exit !== exitFor(r.verdict)).map((r) => r.case.id);
  const smokeFalsePass = smokeRows.filter((r) => r.case.expected.verdict === 'FAIL' && r.verdict === 'PASS');
  const positive = smokeRows.filter((r) => r.case.positiveControl);
  const abstainSmoke = smokeRows.filter((r) => r.verdict === 'ABSTAIN');

  const assetMs = [...a1.values()].map((r) => r.ms);
  const cleanMs = controls.map((e) => e.run.ms);
  const browserMs = smokeRows.filter((r) => r.verdict !== 'ABSTAIN' && r.case.fixture !== 'unsigned' && !['wrong_key', 'tampered_asset', 'tampered_manifest', 'malformed'].includes(r.case.fixture)).map((r) => r.ms);

  const summary = {
    fixtures: labels.length,
    fixture_hash_drift: gen.drift,
    per_code: Object.fromEntries([...perCode].map(([k, v]) => [k, { ...v, recall: v.hits / v.n, wilson95: wilson(v.hits, v.n) }])),
    controls: { n: controls.length, false_rejects: falseRejects.map((e) => ({ id: e.label.id, verdict: e.run.report.verdict, codes: codesOf(e.run.report) })), rate: falseRejects.length / controls.length, wilson95: wilson(falseRejects.length, controls.length) },
    false_pass: { error_class_fixtures: errorClass.length, count: falsePass.length, ids: falsePass.map((e) => e.label.id), smoke_count: smokeFalsePass.length },
    abstain: { on_fixtures: abstainOnFixtures.length, on_smoke: abstainSmoke.map((r) => r.case.id), fail_closed_controls: failClosed.map((f) => ({ name: f.name, verdict: f.report.verdict })) },
    label_mismatches: mismatches.map((e) => ({ id: e.label.id, problems: e.ev.problems })),
    exit_code_mismatches: { asset: exitMismatch, smoke: smokeExitMismatch, processes: exits.filter((e) => e.expected !== e.actual) },
    latency_ms: {
      asset_gate: { n: assetMs.length, p50: percentile(assetMs, 0.5), p95: percentile(assetMs, 0.95), max: Math.max(...assetMs) },
      asset_gate_clean_controls: { n: cleanMs.length, p50: percentile(cleanMs, 0.5), p95: percentile(cleanMs, 0.95) },
      smoke_with_browser: { n: browserMs.length, p50: percentile(browserMs, 0.5), p95: percentile(browserMs, 0.95) },
    },
    determinism: { asset_runs: labels.length, asset_hash_differences: hashDiffAsset, smoke_runs: cases.length, smoke_hash_differences: hashDiffSmoke, frame_hashes: frameRows },
  };

  const results = {
    environment,
    summary,
    asset_gate: evals.map((e) => ({ id: e.label.id, class: e.label.class, variant: e.label.variant, options: e.label.options, expected: e.label.expected, verdict: e.run.report.verdict, codes: codesOf(e.run.report), ok: e.ev.ok, problems: e.ev.problems, verdict_hash: e.run.report.verdict_hash, ms: Math.round(e.run.ms), measures: e.run.report.measures })),
    smoke: smokeRows.map((r) => ({ id: r.case.id, tier: r.case.tier, hooks: r.case.hooks, expected: r.case.expected, verdict: r.verdict, codes: r.codes, ok: r.ok, exit: r.exit, ms: Math.round(r.ms), positive_control: r.case.positiveControl, verdict_hash: s1.get(r.case.id)!.report.verdict_hash, frame_sha256: s1.get(r.case.id)!.report.frame?.sha256 ?? null })),
    fail_closed_controls: failClosed.map((f) => ({ name: f.name, verdict: f.report.verdict, checks: Object.fromEntries(Object.entries(f.report.checks).filter(([, c]) => c.status !== 'ran').map(([k, c]) => [k, c.reason ?? c.status])) })),
    process_exit_checks: exits,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  const md = renderMarkdown({ environment, summary, evals: evals.map((e) => ({ id: e.label.id, ok: e.ev.ok, problems: e.ev.problems })), smokeRows, failClosed: results.fail_closed_controls, exits, positive, durationS: Math.round((Date.now() - started) / 1000) });
  writeFileSync(join(OUT_DIR, 'RESULTS.md'), md);

  // ----- exit criteria -----
  const problems: string[] = [];
  if (gen.drift.length) problems.push(`${gen.drift.length} regenerated fixture(s) do not reproduce their committed SHA-256`);
  for (const [code, v] of perCode) if (v.hits !== v.n) problems.push(`recall for ${code} is ${v.hits}/${v.n}`);
  if (falsePass.length) problems.push(`false PASS on ${falsePass.map((e) => e.label.id).join(', ')}`);
  if (smokeFalsePass.length) problems.push(`smoke false PASS on ${smokeFalsePass.map((r) => r.case.id).join(', ')}`);
  if (falseRejects.length) problems.push(`false reject(s) on controls: ${falseRejects.map((e) => e.label.id).join(', ')}`);
  if (mismatches.length) problems.push(`${mismatches.length} fixture(s) differ from their labels`);
  if (abstainOnFixtures.length) problems.push(`${abstainOnFixtures.length} fixture(s) abstained`);
  if (hashDiffAsset.length || hashDiffSmoke.length) problems.push(`verdict hashes differ between runs: ${[...hashDiffAsset, ...hashDiffSmoke].join(', ')}`);
  if (!positive.every((r) => r.ok)) problems.push(`positive control(s) did not fire: ${positive.filter((r) => !r.ok).map((r) => r.case.id).join(', ')}`);
  for (const r of smokeRows) if (!r.ok) problems.push(`smoke case ${r.case.id}: expected ${r.case.expected.verdict} ${r.case.expected.codes}, got ${r.verdict} ${r.codes}`);
  if (failClosed.some((f) => f.report.verdict === 'PASS')) problems.push('a fail-closed control produced PASS');
  if (exitMismatch.length || smokeExitMismatch.length || exits.some((e) => e.expected !== e.actual)) problems.push('an exit code does not match its verdict');

  if (problems.length) {
    console.error('\n[proof] FAILED:\n - ' + problems.join('\n - '));
    console.error(`[proof] see bench/out/RESULTS.md`);
    return 1;
  }
  console.error(`\n[proof] all criteria met in ${Math.round((Date.now() - started) / 1000)} s; wrote bench/out/RESULTS.md and bench/out/results.json`);
  return 0;
}

process.exitCode = await proof().catch((e) => {
  console.error('[proof] crashed:', e);
  return 2;
});
