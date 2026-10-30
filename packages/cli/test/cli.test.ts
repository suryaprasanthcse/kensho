import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

async function run(...argv: string[]) {
  let stdout = '', stderr = '';
  const code = await main(argv, { stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t) });
  return { code, stdout, stderr };
}

describe('kensho asset-gate', () => {
  it('exits 0 on PASS and prints one JSON report', async () => {
    const { code, stdout } = await run('asset-gate', files['CONTROL-02']!, '--tier', 'desktop');
    expect(code).toBe(0);
    const r = JSON.parse(stdout);
    expect(r).toMatchObject({ verdict: 'PASS', gate: 'G4', options: { tier: 'desktop', class: 'prop', body: 'dynamic', box_um: null } });
    expect(r.input.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.verdict_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(r)).toEqual(expect.arrayContaining(['verdict', 'diagnostics', 'measures', 'checks', 'input', 'verdict_hash', 'timings_ms']));
  });

  it('exits 1 on FAIL', async () => {
    const { code, stdout } = await run('asset-gate', files['TRIANGLE_BUDGET-00']!, '--tier', 'mobile', '--class', 'background');
    expect(code).toBe(1);
    expect(JSON.parse(stdout).diagnostics.map((d: { code: string }) => d.code)).toContain('TRIANGLE_BUDGET');
  });

  it('applies --box-um', async () => {
    const { code, stdout } = await run('asset-gate', files['BBOX_CONFORMANCE-00']!, '--tier', 'mobile', '--box-um', '1000000,1000000,1000000');
    expect([0, 1]).toContain(code);
    expect(JSON.parse(stdout).options.box_um).toEqual([1_000_000, 1_000_000, 1_000_000]);
    expect(JSON.parse(stdout).checks.bbox.status).toBe('ran');
  });

  it('exits 2 (ABSTAIN) when the deadline passes, never 0', async () => {
    const { code, stdout } = await run('asset-gate', files['CONTROL-02']!, '--tier', 'mobile', '--timeout-ms', '1');
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
    const { code, stderr } = await run(...argv);
    expect(code).toBe(3);
    expect(stderr).toContain('usage');
  });
});
