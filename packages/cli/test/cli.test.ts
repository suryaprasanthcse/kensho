import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildManifest, loadOrCreateDevKeys, writeSignedBundle } from '@kensho/bundle';
import { buildFixture } from '@kensho/synthetic_oracle';
import { main } from '../src/main.ts';

let dir: string;
const files: Record<string, string> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kensho-cli-'));
  for (const id of ['CONTROL-02', 'TRIANGLE_BUDGET-00', 'BBOX_CONFORMANCE-00']) {
    files[id] = join(dir, `${id}.glb`);
    writeFileSync(files[id]!, (await buildFixture(id)).bytes);
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(env: NodeJS.ProcessEnv, ...argv: string[]) {
  let stdout = '', stderr = '';
  const code = await main(argv, { stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t) }, env);
  return { code, stdout, stderr };
}

describe('kensho asset-gate', () => {
  it('exits 0 on PASS and prints one JSON report', async () => {
    const { code, stdout } = await run({}, 'asset-gate', files['CONTROL-02']!, '--tier', 'desktop');
    expect(code).toBe(0);
    const r = JSON.parse(stdout);
    expect(r).toMatchObject({ verdict: 'PASS', gate: 'G4', options: { tier: 'desktop', class: 'prop', body: 'dynamic', box_um: null } });
    expect(r.input.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.verdict_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(r)).toEqual(expect.arrayContaining(['verdict', 'diagnostics', 'measures', 'checks', 'input', 'verdict_hash', 'timings_ms']));
  });

  it('exits 1 on FAIL', async () => {
    const { code, stdout } = await run({}, 'asset-gate', files['TRIANGLE_BUDGET-00']!, '--tier', 'mobile', '--class', 'background');
    expect(code).toBe(1);
    expect(JSON.parse(stdout).diagnostics.map((d: { code: string }) => d.code)).toContain('TRIANGLE_BUDGET');
  });

  it('applies --box-um', async () => {
    const { code, stdout } = await run({}, 'asset-gate', files['BBOX_CONFORMANCE-00']!, '--tier', 'mobile', '--box-um', '1000000,1000000,1000000');
    expect([0, 1]).toContain(code);
    expect(JSON.parse(stdout).options.box_um).toEqual([1_000_000, 1_000_000, 1_000_000]);
    expect(JSON.parse(stdout).checks.bbox.status).toBe('ran');
  });

  it('exits 2 (ABSTAIN) when the deadline passes, never 0', async () => {
    const { code, stdout } = await run({}, 'asset-gate', files['CONTROL-02']!, '--tier', 'mobile', '--timeout-ms', '1');
    expect(code).toBe(2);
    expect(JSON.parse(stdout).verdict).toBe('ABSTAIN');
  });

  it.each([
    [['asset-gate']],
    [['asset-gate', 'a.glb', 'b.glb', '--tier', 'mobile']],
    [['asset-gate', 'a.glb']],
    [['asset-gate', 'a.glb', '--tier', 'tablet']],
    [['asset-gate', 'a.glb', '--tier', 'mobile', '--class', 'giant']],
    [['asset-gate', 'a.glb', '--tier', 'mobile', '--body', 'floppy']],
    [['asset-gate', 'a.glb', '--tier', 'mobile', '--box-um', '1,2']],
    [['asset-gate', 'a.glb', '--tier', 'mobile', '--box-um', '1,2,-3']],
    [['asset-gate', 'a.glb', '--tier', 'mobile', '--timeout-ms', '0']],
    [['asset-gate', 'a.glb', '--tier', 'mobile', '--frobnicate']],
    [['asset-gate', 'does-not-exist.glb', '--tier', 'mobile']],
    [['launch']],
    [[]],
  ])('exits 3 on a usage error: %j', async (argv) => {
    const { code, stderr } = await run({}, ...argv);
    expect(code).toBe(3);
    expect(stderr).toContain('usage');
  });
});

describe('kensho asset-gate --write-fixed', () => {
  it('writes the pruned file only when the gate proved the prune sound, and says which hash', async () => {
    const fx = await buildFixture('DEGENERATE_AUTOFIX-01');
    const input = join(dir, 'autofix.glb');
    const output = join(dir, 'autofix.fixed.glb');
    writeFileSync(input, fx.bytes);
    const r = await run({}, 'asset-gate', input, '--tier', fx.options.tier, '--write-fixed', output);
    const report = JSON.parse(r.stdout);
    expect(r.code).toBe(0);
    expect(report.measures.autofix).toMatchObject({ applied: 1, sound: 1 });
    expect(r.stderr).toContain(report.measures.autofix.output_sha256);
    const again = await run({}, 'asset-gate', output, '--tier', fx.options.tier);
    expect(JSON.parse(again.stdout).measures.degenerate_triangles).toBe(0);
  });

  it('writes nothing for a clean file or for a rejection', async () => {
    const output = join(dir, 'never.glb');
    const r = await run({}, 'asset-gate', files['CONTROL-02']!, '--tier', 'desktop', '--write-fixed', output);
    expect(r.stderr).toContain('nothing to write');
    const { existsSync } = await import('node:fs');
    expect(existsSync(output)).toBe(false);
  });
});

describe('kensho smoke', () => {
  let keyDir: string, bundle: string;
  beforeAll(() => {
    keyDir = join(dir, 'keys');
    const keys = loadOrCreateDevKeys(keyDir);
    const bytes = new Uint8Array([1, 2, 3]);
    const m = buildManifest({ assets: [{ id: 'a', bytes, verdict: 'PASS', verdict_hash: 'a'.repeat(64) }], placements: [], gateVersions: { G4: 't' } });
    bundle = join(dir, 'bundle');
    writeSignedBundle(bundle, m, new Map([['a', bytes]]), keys);
  });

  it('exits 1 on a refused bundle, before launching any browser', async () => {
    rmSync(join(bundle, 'manifest.sig'));
    const { code, stdout } = await run({ KENSHO_KEY_DIR: keyDir }, 'smoke', bundle, '--tier', 'mobile');
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ verdict: 'FAIL', gate: 'G6', environment: { chromium: null } });
  });

  it.each([
    [['smoke']],
    [['smoke', 'x', '--tier', 'huge']],
    [['smoke', 'x', '--tier', 'mobile', '--timeout-ms', 'soon']],
  ])('exits 3 on a usage error: %j', async (argv) => {
    expect((await run({}, ...argv)).code).toBe(3);
  });

  it('exits 3 on an unknown test hook', async () => {
    const { code, stderr } = await run({ KENSHO_TEST_HOOKS: 'nonsense' }, 'smoke', bundle, '--tier', 'mobile');
    expect(code).toBe(3);
    expect(stderr).toContain('unknown test hook');
  });
});
