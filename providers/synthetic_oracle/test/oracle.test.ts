import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { NotConfiguredError } from '@kensho/ir';
import {
  CLASS_COUNTS,
  buildFixture,
  createSyntheticOracle,
  geometry as G,
  listFixtureIds,
  makeRng,
  sha256,
  solidPng,
} from '../src/index.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('seeded generation', () => {
  it('uses no ambient randomness or clock in its sources', () => {
    for (const f of readdirSync(SRC)) {
      const text = readFileSync(join(SRC, f), 'utf8');
      expect(text, f).not.toMatch(/Math\.random|Date\.now|performance\.now|new Date\(/);
    }
  });

  it('reproduces identical bytes for an id, and different bytes for different ids', async () => {
    const a = await buildFixture('CONTROL-03');
    const b = await buildFixture('CONTROL-03');
    const c = await buildFixture('CONTROL-04');
    expect(sha256(a.bytes)).toBe(sha256(b.bytes));
    expect(sha256(a.bytes)).not.toBe(sha256(c.bytes));
  });

  it('produces the same stream for the same seed', () => {
    const x = makeRng('s'), y = makeRng('s');
    expect(Array.from({ length: 8 }, () => x.float())).toEqual(Array.from({ length: 8 }, () => y.float()));
  });

  it('has at least ten seeds for each defect class and at least thirty controls', () => {
    const ids = listFixtureIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const [klass, variant, n] of CLASS_COUNTS) {
      if (variant === 'default' && klass !== 'CONTROL') expect(n, klass).toBeGreaterThanOrEqual(10);
    }
    expect(CLASS_COUNTS.find(([k]) => k === 'CONTROL')![2]).toBeGreaterThanOrEqual(30);
  });
});

describe('geometry', () => {
  const closedKinds: [string, G.Geometry][] = [
    ['box', G.box(1, 2, 3)],
    ['sphere', G.sphere(0.5, 12, 16)],
    ['cylinder', G.cylinder(0.5, 1, 3, 12)],
    ['capsule', G.capsule(0.3, 0.6, 4, 12)],
    ['cone', G.cone(0.5, 1, 3, 12)],
    ['vase', G.vase(0.5, 1, 10, 12)],
    ['torus', G.torus(0.4, 0.15, 16, 8)],
    ['tetrahedron', G.tetrahedron(1)],
  ];
  it.each(closedKinds)('%s faces outward (positive volume) and is closed after an exact weld', (_name, g) => {
    expect(G.signedVolume(g)).toBeGreaterThan(0);
    const key = (i: number) => `${g.pos[i * 3]!.toFixed(9)},${g.pos[i * 3 + 1]!.toFixed(9)},${g.pos[i * 3 + 2]!.toFixed(9)}`;
    const edges = new Map<string, number>();
    for (let t = 0; t < g.idx.length; t += 3) {
      const v = [key(g.idx[t]!), key(g.idx[t + 1]!), key(g.idx[t + 2]!)];
      for (let e = 0; e < 3; e++) {
        const a = v[e]!, b = v[(e + 1) % 3]!;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    }
    for (const n of edges.values()) expect(n).toBe(2);
  });
});

describe('solid PNG', () => {
  it('is a valid PNG of the requested size with a small file', () => {
    const png = solidPng(8192, 8192, [10, 20, 30]);
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(dv.getUint32(16)).toBe(8192);
    expect(dv.getUint32(20)).toBe(8192);
    expect(png.length).toBeLessThan(100_000);
  });

  it('round-trips through zlib to all-zero palette indices', () => {
    const png = solidPng(40, 5, [1, 2, 3]);
    let off = 8;
    const idat: Buffer[] = [];
    while (off < png.length) {
      const len = new DataView(png.buffer, png.byteOffset + off).getUint32(0);
      const type = Buffer.from(png.subarray(off + 4, off + 8)).toString('latin1');
      if (type === 'IDAT') idat.push(Buffer.from(png.subarray(off + 8, off + 8 + len)));
      off += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    expect(raw.length).toBe((1 + 5) * 5);
    expect(raw.every((b) => b === 0)).toBe(true);
  });
});

describe('labels and provider', () => {
  it('labels each fixture with a verdict and its expected codes', async () => {
    for (const id of ['CONTROL-00', 'GLTF_INVALID-02', 'NONMANIFOLD_EDGE_STATIC-01', 'OPEN_BOUNDARY-03']) {
      const fx = await buildFixture(id);
      expect(['PASS', 'FAIL']).toContain(fx.expected.verdict);
      expect(Array.isArray(fx.expected.codes)).toBe(true);
    }
    const stat = await buildFixture('NONMANIFOLD_EDGE_STATIC-01');
    expect(stat.expected).toMatchObject({ verdict: 'PASS', codes: ['NONMANIFOLD_EDGE'] });
    expect(stat.options.body).toBe('static');
  });

  it('serves fixtures through the provider interface at zero credits', async () => {
    const p = createSyntheticOracle();
    const job = await p.submit({ params: { fixture: 'CONTROL-01' }, prompt: '', assetClass: 'prop', seed: 1 });
    expect(await p.poll(job)).toEqual({ status: 'done' });
    const raw = await p.fetch(job);
    expect(raw.consumed).toBe(0);
    expect(raw.bytes.length).toBeGreaterThan(100);
    expect(NotConfiguredError).toBeDefined();
  });
});
