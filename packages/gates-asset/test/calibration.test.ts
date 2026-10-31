import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildFixture } from '@kensho/synthetic_oracle';
import { pruneDegenerate } from '../src/index.ts';
import { codesOf, G, gate, glbOfGeometry, glbOfSpec, grey, torusWithTriangles } from './helpers.ts';

/** `k` zero-area triangles appended to a geometry: a repeated index, then isolated collinear triples. */
function withDegenerates(g: G.Geometry, k: number): G.Geometry {
  for (let i = 0; i < k; i++) {
    const n = G.vertCount(g);
    if (i % 2 === 0) g.idx.push(3, 3, 7);
    else {
      g.pos.push(0, 0, 0, 0.01, 0, 0, 0.02, 0, 0);
      g.uv.push(0, 0, 0, 0, 0, 0);
      g.idx.push(n, n + 1, n + 2);
    }
  }
  return g;
}

const sev = (r: Awaited<ReturnType<typeof gate>>, code: string) => r.diagnostics.filter((d) => d.code === code).map((d) => d.severity);

describe('degenerate triangles: prune below 0.5%, reject above', () => {
  // 1990 triangles: 10 degenerate is exactly 0.5% of 2000
  const base = () => torusWithTriangles(199, 5);

  it('warns and prunes at exactly 0.5%, and the verdict stays PASS', async () => {
    const r = await gate(await glbOfGeometry(withDegenerates(base(), 10)), { tier: 'desktop' });
    expect(r.measures.degenerate_ratio_ppm).toBe(5000);
    expect(sev(r, 'DEGENERATE_TRIANGLE')).toEqual(['warning']);
    expect(r.verdict).toBe('PASS');
    expect(r.measures.autofix).toMatchObject({ applied: 1, sound: 1, removed_triangles: 10 });
  });

  it('rejects one triangle over the threshold', async () => {
    const r = await gate(await glbOfGeometry(withDegenerates(base(), 11)), { tier: 'desktop' });
    expect(sev(r, 'DEGENERATE_TRIANGLE')).toEqual(['error']);
    expect(r.verdict).toBe('FAIL');
    expect(r.checks.autofix).toMatchObject({ status: 'not_checked' });
  });

  it('does not depend on the body kind', async () => {
    const bytes = await glbOfGeometry(withDegenerates(base(), 3));
    for (const body of ['dynamic', 'static'] as const) expect(sev(await gate(bytes, { tier: 'desktop', body }), 'DEGENERATE_TRIANGLE')).toEqual(['warning']);
  });

  it('proves the repair: the pruned file has none left, the same topology, and its hash is reported', async () => {
    const bytes = await glbOfGeometry(withDegenerates(base(), 4));
    const r = await gate(bytes, { tier: 'desktop' });
    const fixed = await pruneDegenerate(bytes);
    expect(fixed.removed).toBe(4);
    expect(createHash('sha256').update(fixed.bytes).digest('hex')).toBe((r.measures.autofix as { output_sha256: string }).output_sha256);
    const after = await gate(fixed.bytes, { tier: 'desktop' });
    expect(after.diagnostics).toEqual([]);
    expect(after.measures.degenerate_triangles).toBe(0);
    for (const k of ['boundary_edges', 'nonmanifold_edges', 'inconsistent_edges', 'islands']) expect(after.measures[k]).toBe(r.measures[k]);
    expect(after.measures.triangles).toBe((r.measures.triangles as number) - 4);
  });

  it('pruning is idempotent and leaves a clean file byte for byte alone', async () => {
    const clean = await glbOfGeometry(base());
    const once = await pruneDegenerate(clean);
    expect(once.removed).toBe(0);
    expect(once.bytes).toBe(clean);
    const dirty = await glbOfGeometry(withDegenerates(base(), 2));
    const first = await pruneDegenerate(dirty);
    const second = await pruneDegenerate(first.bytes);
    expect(second.removed).toBe(0);
  });

  it('cannot prune a triangle strip: a hard error, never a silent conversion', async () => {
    const fx = await buildFixture('DEGENERATE_UNPRUNABLE-00');
    const r = await gate(fx.bytes, { tier: fx.options.tier, body: 'static' });
    expect(r.verdict).toBe('FAIL');
    expect(r.measures.autofix).toMatchObject({ applied: 0, sound: 0 });
    expect(sev(r, 'DEGENERATE_TRIANGLE')).toContain('error');
    expect((await pruneDegenerate(fx.bytes)).unprunable).toBeGreaterThan(0);
  });

  it('property: a sound autofix never adds an error code and always removes its own', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 9 }), fc.constantFrom('torus', 'sphere'), fc.boolean(), async (k, shape, open) => {
        const g = shape === 'torus' ? torusWithTriangles(120, 10) : G.sphere(0.5, 30, 40);
        if (open) G.dropTriangles(g, 30, 3); // an unrelated error that must survive the repair unchanged
        const r = await gate(await glbOfGeometry(withDegenerates(g, k)), { tier: 'desktop', body: open ? 'dynamic' : 'static' });
        expect(sev(r, 'DEGENERATE_TRIANGLE')).toEqual(['warning']);
        expect(r.measures.autofix).toMatchObject({ applied: 1, sound: 1 });
        expect(codesOf(r).filter((c) => c !== 'DEGENERATE_TRIANGLE')).toEqual(open ? ['OPEN_BOUNDARY'] : []);
      }),
      { numRuns: 25 },
    );
  });
});

describe('minor islands: decorative inside the hull, debris outside', () => {
  const body = () => G.box(1, 1, 1);
  const shell = (centre: [number, number, number], half = 0.01) => G.transform(G.box(1, 1, 1), [half * 2, half * 2, half * 2], centre);
  const gateIslands = async (parts: G.Geometry[], opts = {}) => gate(await glbOfGeometry(G.merge(parts)), { tier: 'desktop', ...opts });

  it('a small shell inside the body is a warning, and the verdict is PASS', async () => {
    const r = await gateIslands([body(), shell([0.1, 0.1, 0.1])]);
    expect(sev(r, 'FLOATING_ISLANDS')).toEqual(['warning']);
    expect(r.verdict).toBe('PASS');
    expect(r.measures).toMatchObject({ floating_islands: 1, floating_outside_hull: 0, decorative_shells: 1 });
  });

  it('a small shell away from the body is an error', async () => {
    const r = await gateIslands([body(), shell([2, 0, 0])]);
    expect(sev(r, 'FLOATING_ISLANDS')).toEqual(['error']);
    expect(r.verdict).toBe('FAIL');
    expect(r.measures).toMatchObject({ floating_outside_hull: 1, decorative_shells: 0 });
  });

  it('reports how far outside, and the tolerance is 0.1% of the body extent', async () => {
    // the shell's far face reaches 0.0005 past the body's face (0.05% of a 1.0 extent): inside the tolerance
    const near = await gateIslands([body(), shell([0.5 - 0.01 + 0.0005, 0, 0])]);
    expect(sev(near, 'FLOATING_ISLANDS')).toEqual(['warning']);
    // 0.002 past (0.2%): outside
    const far = await gateIslands([body(), shell([0.5 - 0.01 + 0.002, 0, 0])]);
    expect(sev(far, 'FLOATING_ISLANDS')).toEqual(['error']);
    expect(far.measures.floating_max_outside_hull_ppm).toBeGreaterThan(1000);
  });

  it('mixed: the shell inside is a warning and the one outside is still an error', async () => {
    const r = await gateIslands([body(), shell([0.1, 0, 0]), shell([3, 0, 0])]);
    expect(sev(r, 'FLOATING_ISLANDS').sort()).toEqual(['error', 'warning']);
    expect(r.verdict).toBe('FAIL');
  });

  it('the convex hull is not the surface: a shell in a torus hole is inside the hull', async () => {
    const r = await gateIslands([G.torus(0.4, 0.15, 48, 16), shell([0, 0, 0], 0.02)]);
    expect(sev(r, 'FLOATING_ISLANDS')).toEqual(['warning']);
  });

  it('a body with no hull (flat) gives debris nowhere to be decorative', async () => {
    const flat = G.box(1, 1, 1);
    G.transform(flat, [1, 0, 1], [0, 0, 0]);
    const r = await gateIslands([flat, shell([0, 0, 0], 0.002)], { body: 'static' });
    expect(sev(r, 'FLOATING_ISLANDS')).toEqual(['error']);
  });

  it('judges each instance against its own body, so duplicates elsewhere do not turn into errors', async () => {
    const mesh = G.merge([body(), shell([0.1, 0.1, 0.1])]);
    const bytes = await glbOfSpec({
      materials: [grey],
      nodes: [
        { parts: [{ geometry: mesh, material: 0 }] },
        { parts: [{ geometry: G.merge([body(), shell([0.1, 0.1, 0.1])]), material: 0 }], translation: [5, 0, 0] },
      ],
    });
    const r = await gate(bytes, { tier: 'desktop' });
    expect(sev(r, 'FLOATING_ISLANDS')).toEqual(['warning']);
    expect(r.verdict).toBe('PASS');
  });

  it('is independent of node order', async () => {
    const parts = [
      { geometry: G.merge([body(), shell([0.1, 0.1, 0.1])]), material: 0 },
    ];
    const a = await glbOfSpec({ materials: [grey], nodes: [{ parts }, { parts: [{ geometry: shell([0, 0, 0], 0.01), material: 0 }], translation: [4, 0, 0] }] });
    const b = await glbOfSpec({ materials: [grey], nodes: [{ parts: [{ geometry: shell([0, 0, 0], 0.01), material: 0 }], translation: [4, 0, 0] }, { parts }] });
    const [ra, rb] = [await gate(a, { tier: 'desktop' }), await gate(b, { tier: 'desktop' })];
    expect(rb.measures).toEqual(ra.measures);
    expect(sev(rb, 'FLOATING_ISLANDS')).toEqual(sev(ra, 'FLOATING_ISLANDS'));
  });
});
