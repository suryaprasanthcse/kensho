import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFixture, buildGlb, geometry as G, type MaterialSpec } from '@kensho/synthetic_oracle';
import { GATE_VERSION as G4_VERSION, runAssetGate, type AssetGateReport } from '@kensho/gates-asset';
import { GATE_VERSION as G6_VERSION } from '@kensho/harness-render';
import { buildManifest, generateKeyPair, loadOrCreateDevKeys, writeSignedBundle, type BundleManifest, type KeyPair } from '@kensho/bundle';
import { BUNDLE_DIR, KEY_DIR } from './paths.ts';

export type Tier = 'mobile' | 'desktop';

/** One row of the smoke table: a bundle, how it is run and what must come out. */
export interface SmokeCase {
  id: string;
  /** Catalogue id of the fixture this row exercises (what the code registry points at). */
  fixture: string;
  dir: string;
  tier: Tier;
  hooks: string[];
  timeoutMs: number;
  expected: { verdict: 'PASS' | 'FAIL' | 'ABSTAIN'; codes: string[] };
  /** A positive control runs a probe on purpose and must make it fire. */
  positiveControl: boolean;
  note: string;
}

const MICRO = 1_000_000;
const identity = { rotation_uq: [0, 0, 0, MICRO] as [number, number, number, number], scale_ppm: [MICRO, MICRO, MICRO] as [number, number, number] };
const fov = Math.round((50 * Math.PI * MICRO) / 180);

interface Prepared {
  id: string;
  bytes: Uint8Array;
  report: AssetGateReport;
}

async function prepare(id: string, bytes: Uint8Array): Promise<Prepared> {
  const report = await runAssetGate(bytes, { tier: 'mobile', assetClass: 'prop', body: 'dynamic' });
  if (report.verdict !== 'PASS') throw new Error(`smoke fixture asset ${id} does not pass the asset gate: ${report.verdict} ${report.diagnostics.map((d) => d.code)}`);
  return { id, bytes, report };
}

function manifestOf(assets: Prepared[], placements: BundleManifest['placements'], camera: BundleManifest['camera']): BundleManifest {
  return buildManifest({
    assets: assets.map((a) => ({ id: a.id, bytes: a.bytes, verdict: a.report.verdict, verdict_hash: a.report.verdict_hash })),
    placements,
    ...(camera ? { camera } : {}),
    gateVersions: { G4: G4_VERSION, G6: G6_VERSION },
    seeds: { fixture: 1 },
    fallbacksUsed: [],
  });
}

const writeBundle = (dir: string, assets: Prepared[], manifest: BundleManifest, keys: KeyPair) => {
  writeSignedBundle(dir, manifest, new Map(assets.map((a) => [a.id, a.bytes])), keys);
};

/** Builds every smoke bundle into `.generated/bundles` and returns the cases to run. */
export async function buildSmokeCases(): Promise<SmokeCase[]> {
  rmSync(BUNDLE_DIR, { recursive: true, force: true });
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const keys = loadOrCreateDevKeys(KEY_DIR);
  const dirOf = (name: string) => join(BUNDLE_DIR, name);

  // props taken from the synthetic controls: mobile-tier, plain props that pass the asset gate
  const propIds = ['CONTROL-02', 'CONTROL-04', 'CONTROL-06', 'CONTROL-08', 'CONTROL-10', 'CONTROL-12'];
  const props: Prepared[] = [];
  for (const id of propIds) props.push(await prepare(`a${props.length}`, (await buildFixture(id)).bytes));
  const grid = (assets: Prepared[]) =>
    assets.map((a, i) => ({ asset: a.id, translation_um: [((i % 3) - 1) * 3 * MICRO, 0, 0 - Math.floor(i / 3) * 3 * MICRO] as [number, number, number], ...identity }));
  const cleanCamera = { position_um: [0, 4 * MICRO, 9 * MICRO] as [number, number, number], look_at_um: [0, Math.round(0.5 * MICRO), -1.5 * MICRO] as [number, number, number], fov_urad: fov };

  // clean
  const cleanManifest = manifestOf(props, grid(props), cleanCamera);
  writeBundle(dirOf('clean'), props, cleanManifest, keys);

  // 600 unmerged props, all in view
  const crate = await prepare('crate', await buildGlb({ materials: [{ color: [0.7, 0.5, 0.3] }], nodes: [{ parts: [{ geometry: G.box(0.2, 0.2, 0.2), material: 0 }] }] }));
  const crates: BundleManifest['placements'] = [];
  for (let r = 0; r < 20; r++) for (let c = 0; c < 30; c++) crates.push({ asset: 'crate', translation_um: [Math.round((c - 14.5) * 0.25 * MICRO), Math.round((r * 0.25 + 0.1) * MICRO), 0], ...identity });
  writeBundle(dirOf('drawcalls'), [crate], manifestOf([crate], crates, { position_um: [0, Math.round(2.5 * MICRO), 10 * MICRO], look_at_um: [0, Math.round(2.5 * MICRO), 0], fov_urad: fov }), keys);

  // camera inside a wall
  const wall = await prepare('wall', await buildGlb({ materials: [{ color: [0.6, 0.6, 0.65] }], nodes: [{ parts: [{ geometry: G.box(1, 1, 1), material: 0 }] }] }));
  const wallPlacements: BundleManifest['placements'] = [
    { asset: 'wall', translation_um: [0, 2 * MICRO, 0], rotation_uq: identity.rotation_uq, scale_ppm: [8 * MICRO, 4 * MICRO, 8 * MICRO] },
    ...props.slice(0, 2).map((a, i) => ({ asset: a.id, translation_um: [(i * 3 + 7) * MICRO, 0, 0] as [number, number, number], ...identity })),
  ];
  writeBundle(dirOf('wall'), [wall, ...props.slice(0, 2)], manifestOf([wall, ...props.slice(0, 2)], wallPlacements, { position_um: [0, MICRO, 0], look_at_um: [0, MICRO, -MICRO], fov_urad: fov }), keys);

  // texture memory: each asset stays under the per-asset budget, the world does not
  const heavyMat = (seed: number): MaterialSpec => ({
    color: [1, 1, 1],
    baseTexture: { width: 2048, height: 2048, rgb: [seed, 10, 10] },
    extraTextures: [1, 2, 3].map((k) => ({ width: 2048, height: 2048, rgb: [seed, 10 + k, 20] as [number, number, number] })),
  });
  const heavy: Prepared[] = [];
  for (const h of [0, 1]) {
    heavy.push(
      await prepare(`heavy${h}`, await buildGlb({
        materials: [heavyMat(h * 20 + 1), heavyMat(h * 20 + 2)],
        nodes: [0, 1].map((m) => ({ parts: [{ geometry: G.sphere(0.5, 8, 12), material: m }], translation: [m * 1.5, 0.5, 0] as [number, number, number] })),
      })),
    );
  }
  writeBundle(dirOf('texture_heavy'), heavy, manifestOf(heavy, grid(heavy).slice(0, 2), { position_um: [0, 2 * MICRO, 6 * MICRO], look_at_um: [0, 0, 0], fov_urad: fov }), keys);

  // refusals, all derived from the clean bundle
  const copyClean = (name: string) => {
    const dir = dirOf(name);
    cpSync(dirOf('clean'), dir, { recursive: true });
    return dir;
  };
  rmSync(join(copyClean('unsigned'), 'manifest.sig'));
  writeBundle(dirOf('wrong_key'), props, cleanManifest, generateKeyPair());
  {
    const dir = copyClean('tampered_asset');
    const file = join(dir, cleanManifest.assets[0]!.path);
    const bytes = readFileSync(file);
    bytes[bytes.length - 1]! ^= 0xff;
    writeFileSync(file, bytes);
  }
  {
    const dir = copyClean('tampered_manifest');
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as BundleManifest;
    m.placements[0]!.translation_um[1] += 1_000_000;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
  }
  {
    const dir = copyClean('malformed');
    writeFileSync(join(dir, 'manifest.json'), '{"kensho":"bundle/1","assets":');
  }

  const c = (id: string, fixture: string, dirName: string, tier: Tier, expected: SmokeCase['expected'], extra: Partial<SmokeCase> = {}): SmokeCase => ({
    id, fixture, dir: dirOf(dirName), tier, hooks: [], timeoutMs: 90_000, expected, positiveControl: false, note: '', ...extra,
  });
  const probe = (name: string, code: string): SmokeCase =>
    c(`probe:${name}`, `probe:${name}`, 'clean', 'mobile', { verdict: 'FAIL', codes: [code] }, { hooks: [name], positiveControl: true, note: `test hook ${name} must fire ${code}` });
  return [
    c('clean@mobile', 'clean', 'clean', 'mobile', { verdict: 'PASS', codes: [] }),
    c('clean@desktop', 'clean', 'clean', 'desktop', { verdict: 'PASS', codes: [] }),
    c('drawcalls@mobile', 'drawcalls', 'drawcalls', 'mobile', { verdict: 'FAIL', codes: ['DRAWCALL_BUDGET'] }, { note: '600 unmerged props' }),
    c('drawcalls@desktop', 'drawcalls', 'drawcalls', 'desktop', { verdict: 'FAIL', codes: ['DRAWCALL_BUDGET'] }, { note: '600 unmerged props' }),
    c('wall@mobile', 'wall', 'wall', 'mobile', { verdict: 'FAIL', codes: ['BLANK_FRAME'] }, { note: 'camera inside a wall' }),
    c('wall@desktop', 'wall', 'wall', 'desktop', { verdict: 'FAIL', codes: ['BLANK_FRAME'] }, { note: 'camera inside a wall' }),
    c('texture_heavy@mobile', 'texture_heavy', 'texture_heavy', 'mobile', { verdict: 'FAIL', codes: ['TEXTURE_MEMORY_BUDGET'] }, { note: 'each asset within budget, the world over it' }),
    c('texture_heavy@desktop', 'texture_heavy', 'texture_heavy', 'desktop', { verdict: 'PASS', codes: [] }, { note: 'same world under the larger desktop budget' }),
    c('unsigned@mobile', 'unsigned', 'unsigned', 'mobile', { verdict: 'FAIL', codes: ['BUNDLE_UNSIGNED'] }, { note: 'refused before anything loads' }),
    c('wrong_key@mobile', 'wrong_key', 'wrong_key', 'mobile', { verdict: 'FAIL', codes: ['BUNDLE_SIGNATURE_INVALID'] }, { note: 'refused before anything loads' }),
    c('tampered_asset@mobile', 'tampered_asset', 'tampered_asset', 'mobile', { verdict: 'FAIL', codes: ['BUNDLE_TAMPERED'] }, { note: 'refused before anything loads' }),
    c('tampered_manifest@mobile', 'tampered_manifest', 'tampered_manifest', 'mobile', { verdict: 'FAIL', codes: ['BUNDLE_SIGNATURE_INVALID'] }, { note: 'refused before anything loads' }),
    c('malformed@mobile', 'malformed', 'malformed', 'mobile', { verdict: 'FAIL', codes: ['BUNDLE_MALFORMED'] }, { note: 'refused before anything loads' }),
    c('stalled@mobile', 'stalled', 'clean', 'mobile', { verdict: 'ABSTAIN', codes: [] }, { hooks: ['stall'], timeoutMs: 8_000, note: 'an asset request that never answers; ABSTAIN at the deadline' }),
    probe('bad_shader', 'SHADER_COMPILE'),
    probe('lose_context', 'CONTEXT_LOST'),
    probe('gl_error', 'GL_ERROR'),
    probe('page_exception', 'PAGE_EXCEPTION'),
    probe('failed_request', 'LOAD_FAILED'),
    probe('many_programs', 'PROGRAM_BUDGET'),
  ];
}

