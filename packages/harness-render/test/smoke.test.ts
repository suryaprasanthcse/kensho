import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixture, buildGlb, geometry as G } from '@kensho/synthetic_oracle';
import { buildManifest, loadOrCreateDevKeys, writeSignedBundle, type BundleManifest } from '@kensho/bundle';
import { ensureChromium, runSmoke, startServer, type SmokeReport } from '../src/index.ts';

const MICRO = 1_000_000;
let root: string;
let keyDir: string;
let clean: string;
let manifest: BundleManifest;

function get(url: string, path: string, method = 'GET', timeoutMs = 2000): Promise<{ status: number; body: string } | 'timeout'> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path, method, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('latin1') }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve('timeout');
    });
    req.on('error', () => resolve('timeout'));
    req.end();
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kensho-render-'));
  keyDir = join(root, 'keys');
  const keys = loadOrCreateDevKeys(keyDir);
  const bytes = await buildGlb({ materials: [{ color: [0.7, 0.5, 0.3] }], nodes: [{ parts: [{ geometry: G.box(1, 1, 1), material: 0 }] }] });
  const other = (await buildFixture('CONTROL-02')).bytes;
  manifest = buildManifest({
    assets: [
      { id: 'box', bytes, verdict: 'PASS', verdict_hash: 'a'.repeat(64) },
      { id: 'prop', bytes: other, verdict: 'PASS', verdict_hash: 'b'.repeat(64) },
    ],
    placements: [
      { asset: 'box', translation_um: [0, 500_000, 0], rotation_uq: [0, 0, 0, MICRO], scale_ppm: [MICRO, MICRO, MICRO] },
      { asset: 'prop', translation_um: [2 * MICRO, 0, 0], rotation_uq: [0, 0, 0, MICRO], scale_ppm: [MICRO, MICRO, MICRO] },
    ],
    camera: { position_um: [0, 2 * MICRO, 6 * MICRO], look_at_um: [MICRO, 0, 0], fov_urad: 872_665 },
    gateVersions: { G4: 'test' },
  });
  clean = join(root, 'clean');
  writeSignedBundle(clean, manifest, new Map([['box', bytes], ['prop', other]]), keys);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the loopback server', () => {
  const assets = () => new Map(manifest.assets.map((a) => [a.path, join(clean, a.path)]));
  const manifestBytes = () => readFileSync(join(clean, 'manifest.json'));

  it('binds 127.0.0.1 on a random port and serves the page, three and the manifest', async () => {
    const s = await startServer({ manifest: manifestBytes(), assets: assets(), hooks: new Set() });
    try {
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const page = (await get(s.url, '/')) as { status: number; body: string };
      expect(page.body).toContain('importmap');
      expect(((await get(s.url, '/three/build/three.module.js')) as { status: number }).status).toBe(200);
      expect(((await get(s.url, '/three/examples/jsm/loaders/GLTFLoader.js')) as { status: number }).status).toBe(200);
      expect(((await get(s.url, '/bundle/manifest.json')) as { status: number }).status).toBe(200);
      expect(((await get(s.url, '/bundle/' + manifest.assets[0]!.path)) as { status: number }).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('serves nothing outside the allow-list', async () => {
    const s = await startServer({ manifest: manifestBytes(), assets: assets(), hooks: new Set() });
    try {
      for (const path of ['/three/../package.json', '/three/build/../../package.json', '/three/package.json', '/three/build/three.cjs.map', '/bundle/assets/' + 'f'.repeat(64) + '.glb', '/bundle/../manifest.sig', '/etc/passwd', '/three/examples/jsm/../../../package.json']) {
        const r = (await get(s.url, path)) as { status: number };
        expect([404, 405], path).toContain(r.status);
      }
      expect(((await get(s.url, '/', 'POST')) as { status: number }).status).toBe(405);
    } finally {
      await s.close();
    }
  });

  it('hooks: failed_request fails once; stall never answers', async () => {
    const failing = await startServer({ manifest: manifestBytes(), assets: assets(), hooks: new Set(['failed_request']) });
    try {
      const path = '/bundle/' + manifest.assets[0]!.path;
      expect(((await get(failing.url, path)) as { status: number }).status).toBe(404);
      expect(((await get(failing.url, path)) as { status: number }).status).toBe(200);
    } finally {
      await failing.close();
    }
    const stalled = await startServer({ manifest: manifestBytes(), assets: assets(), hooks: new Set(['stall']) });
    try {
      expect(await get(stalled.url, '/bundle/' + manifest.assets[0]!.path, 'GET', 400)).toBe('timeout');
      expect(((await get(stalled.url, '/bundle/manifest.json')) as { status: number }).status).toBe(200);
    } finally {
      await stalled.close();
    }
  });
});

describe('refusal comes before anything runs', () => {
  const refused = async (mutate: (dir: string) => void, name: string): Promise<SmokeReport> => {
    const dir = join(root, name);
    writeSignedBundle(dir, manifest, new Map(manifest.assets.map((a) => [a.id, readFileSync(join(clean, a.path))])), loadOrCreateDevKeys(keyDir));
    mutate(dir);
    return runSmoke(dir, { tier: 'mobile', keyDir, timeoutMs: 5000 });
  };

  it('an unsigned bundle is FAIL, with no browser started', async () => {
    const r = await refused((d) => rmSync(join(d, 'manifest.sig')), 'u');
    expect(r.verdict).toBe('FAIL');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['BUNDLE_UNSIGNED']);
    expect(r.environment.chromium).toBeNull();
    expect(r.checks.render).toMatchObject({ status: 'not_checked', reason: 'bundle refused' });
  });

  it('a tampered asset is FAIL', async () => {
    const r = await refused((d) => {
      const f = join(d, manifest.assets[0]!.path);
      const b = readFileSync(f);
      b[b.length - 1]! ^= 1;
      writeFileSync(f, b);
    }, 't');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['BUNDLE_TAMPERED']);
  });

  it('a missing trusted key refuses everything', async () => {
    const empty = join(root, 'nokeys');
    mkdirSync(empty);
    const r = await runSmoke(clean, { tier: 'mobile', keyDir: empty });
    expect(r.verdict).toBe('FAIL');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['BUNDLE_SIGNATURE_INVALID']);
  });

  it('rejects an unknown test hook', async () => {
    await expect(runSmoke(clean, { tier: 'mobile', keyDir, hooks: ['nonsense'] })).rejects.toThrow(/unknown test hook/);
  });
});

describe('in headless Chromium on SwiftShader', () => {
  beforeAll(() => {
    ensureChromium();
  });

  it('passes a clean bundle, reads a SwiftShader renderer and hashes the frame', async () => {
    const r = await runSmoke(clean, { tier: 'mobile', keyDir, timeoutMs: 60_000 });
    expect(r.diagnostics).toEqual([]);
    expect(r.verdict).toBe('PASS');
    expect(r.environment.renderer).toMatch(/SwiftShader/i);
    expect(r.frame?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.measures.draw_calls).toBe(2);
    expect(Object.values(r.checks).every((c) => c.status === 'ran')).toBe(true);
  });

  it('a forced context loss is recorded as CONTEXT_LOST, and the hook is named in the report', async () => {
    const r = await runSmoke(clean, { tier: 'mobile', keyDir, hooks: ['lose_context'], timeoutMs: 60_000 });
    expect(r.verdict).toBe('FAIL');
    expect(r.diagnostics.map((d) => d.code)).toContain('CONTEXT_LOST');
    expect(r.test_hooks).toEqual(['lose_context']);
  });

  it('a stalled load is ABSTAIN at the deadline, never PASS', async () => {
    const t0 = Date.now();
    const r = await runSmoke(clean, { tier: 'mobile', keyDir, hooks: ['stall'], timeoutMs: 4000 });
    expect(r.verdict).toBe('ABSTAIN');
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.checks.render?.reason).toMatch(/deadline of 4000 ms/);
  });
});
