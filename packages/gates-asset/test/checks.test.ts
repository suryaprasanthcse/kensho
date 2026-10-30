import { describe, expect, it } from 'vitest';
import { buildGlb, editGlbJson } from '@kensho/synthetic_oracle';
import { assembleReport, runChecks } from '../src/index.ts';
import { base, codesOf, G, gate, glbOfGeometry, glbOfSpec, grey, torusWithTriangles } from './helpers.ts';

const sphere = (r = 0.5, rings = 10, segs = 16) => G.sphere(r, rings, segs);

describe('verdict basics', () => {
  it('passes a clean closed shape and lists the declared-box check as not_checked, not passed', async () => {
    const r = await gate(await glbOfGeometry(sphere()));
    expect(r.verdict).toBe('PASS');
    expect(r.diagnostics).toEqual([]);
    expect(r.checks.bbox).toMatchObject({ status: 'not_checked' });
    expect(r.measures.collider).toMatchObject({ kind: 'sphere' });
  });

  it('is a pure function of the input: identical verdict hashes, a different input changes it', async () => {
    const bytes = await glbOfGeometry(sphere());
    const a = await gate(bytes), b = await gate(bytes);
    expect(a.verdict_hash).toBe(b.verdict_hash);
    const c = await gate(await glbOfGeometry(sphere(0.6)));
    expect(c.verdict_hash).not.toBe(a.verdict_hash);
  });

  it('excludes timings from the verdict hash', async () => {
    const bytes = await glbOfGeometry(sphere());
    const results = await runChecks(bytes, { ...base }, {});
    const a = assembleReport(bytes, { ...base }, results, { total: 1 }, undefined, 'x');
    const b = assembleReport(bytes, { ...base }, results, { total: 99999 }, undefined, 'x');
    expect(a.timings_ms.total).not.toBe(b.timings_ms.total);
    expect(a.verdict_hash).toBe(b.verdict_hash);
  });
});

describe('validator', () => {
  it('flags a truncated GLB as GLTF_INVALID and skips the geometry checks', async () => {
    const bytes = await glbOfGeometry(sphere());
    const r = await gate(bytes.subarray(0, bytes.length - 40));
    expect(r.verdict).toBe('FAIL');
    expect(codesOf(r)).toContain('GLTF_INVALID');
  });

  it('refuses bytes that are not a glTF at all', async () => {
    const r = await gate(new TextEncoder().encode('this is not a model'));
    expect(r.verdict).toBe('FAIL');
    expect(codesOf(r)).toEqual(['GLTF_INVALID']);
  });

  it('refuses a dangling accessor reference', async () => {
    const bytes = editGlbJson(await glbOfGeometry(sphere()), (j) => {
      (j.accessors as { bufferView: number }[])[0]!.bufferView = 77;
    });
    expect(codesOf(await gate(bytes))).toContain('GLTF_INVALID');
  });
});

describe('triangle budget (mobile prop = 5000)', () => {
  it('passes exactly at the budget and fails one step over', async () => {
    const at = await gate(await glbOfGeometry(torusWithTriangles(100, 25)));
    expect(at.measures.triangles).toBe(5000);
    expect(codesOf(at)).not.toContain('TRIANGLE_BUDGET');
    const over = await gate(await glbOfGeometry(torusWithTriangles(101, 25)));
    expect(over.measures.triangles).toBe(5050);
    expect(codesOf(over)).toContain('TRIANGLE_BUDGET');
  });

  it('uses the class: a background asset has a smaller budget', async () => {
    const bytes = await glbOfGeometry(torusWithTriangles(40, 25)); // 2000
    expect(codesOf(await gate(bytes, { assetClass: 'prop' }))).not.toContain('TRIANGLE_BUDGET');
    expect(codesOf(await gate(bytes, { assetClass: 'background' }))).toContain('TRIANGLE_BUDGET');
  });

  it('uses the tier: desktop allows what mobile refuses', async () => {
    const bytes = await glbOfGeometry(torusWithTriangles(101, 25));
    expect(codesOf(await gate(bytes, { tier: 'desktop' }))).not.toContain('TRIANGLE_BUDGET');
  });
});

describe('primitive and material budgets (mobile prop = 8 and 4)', () => {
  const banded = async (bands: number, materials: number) => {
    const parts = G.splitConsecutive(sphere(0.5, bands + 1, 16), bands).map((geometry, i) => ({ geometry, material: i % materials }));
    return glbOfSpec({ materials: Array.from({ length: materials }, () => grey), nodes: [{ parts }] });
  };

  it('primitives: 8 pass, 9 fail', async () => {
    expect(codesOf(await gate(await banded(8, 1)))).not.toContain('PRIMITIVE_BUDGET');
    expect(codesOf(await gate(await banded(9, 1)))).toContain('PRIMITIVE_BUDGET');
  });

  it('materials: 4 pass, 5 fail', async () => {
    expect(codesOf(await gate(await banded(8, 4)))).not.toContain('MATERIAL_BUDGET');
    expect(codesOf(await gate(await banded(8, 5)))).toContain('MATERIAL_BUDGET');
  });

  it('welds across primitives, so a surface split into bands is still closed', async () => {
    const r = await gate(await banded(8, 1));
    expect(r.measures.boundary_edges).toBe(0);
    expect(r.measures.islands).toBe(1);
  });
});

describe('textures', () => {
  const textured = (w: number, h: number) =>
    glbOfGeometry(sphere(), [{ color: [1, 1, 1], baseTexture: { width: w, height: h, rgb: [9, 9, 9] } }]);

  it('accepts the maximum dimension and refuses one pixel over, on either axis', async () => {
    expect(codesOf(await gate(await textured(2048, 2048)))).not.toContain('TEXTURE_BUDGET');
    expect(codesOf(await gate(await textured(2049, 16)))).toContain('TEXTURE_BUDGET');
    expect(codesOf(await gate(await textured(16, 2049)))).toContain('TEXTURE_BUDGET');
  });

  it('estimates GPU bytes as w x h x 4 x 4/3 from the image header, not the file size', async () => {
    const r = await gate(await textured(1024, 1024));
    expect(r.measures.texture_gpu_bytes).toBe(Math.ceil((1024 * 1024 * 16) / 3));
    expect(r.measures.texture_max_dim).toBe(1024);
  });

  it('flags memory over budget even when every dimension is allowed (desktop)', async () => {
    const mats = (n: number) =>
      Array.from({ length: n / 4 }, (_, m) => ({
        color: [1, 1, 1] as [number, number, number],
        baseTexture: { width: 4096, height: 4096, rgb: [m, 1, 1] as [number, number, number] },
        extraTextures: [2, 3, 4].map((k) => ({ width: 4096, height: 4096, rgb: [m, k, 1] as [number, number, number] })),
      }));
    const nodes = (n: number) => mats(n).map((_, i) => ({ parts: [{ geometry: sphere(), material: i }], translation: [i * 2, 0, 0] as [number, number, number] }));
    const ok = await gate(await glbOfSpec({ materials: mats(8), nodes: nodes(8) }), { tier: 'desktop' });
    expect(ok.measures.images).toBe(8);
    expect(codesOf(ok)).not.toContain('TEXTURE_BUDGET');
    const bad = await gate(await glbOfSpec({ materials: mats(12), nodes: nodes(12) }), { tier: 'desktop' });
    expect(codesOf(bad)).toContain('TEXTURE_BUDGET');
    expect(bad.diagnostics.find((d) => d.code === 'TEXTURE_BUDGET')!.pointer).toBe('/images');
  });
});

describe('non-finite positions', () => {
  it('fails on NaN and stops the geometry checks rather than guessing', async () => {
    const g = sphere();
    g.pos[7] = NaN;
    const r = await gate(await glbOfGeometry(g));
    expect(codesOf(r)).toContain('NONFINITE_POSITION');
    expect(r.verdict).toBe('FAIL');
    for (const id of ['degenerate', 'winding', 'boundary', 'nonmanifold', 'islands', 'bbox', 'collider']) {
      expect(r.checks[id]).toMatchObject({ status: 'not_checked', reason: 'non-finite positions' });
    }
  });
});

describe('topology after weld', () => {
  it('a UV sphere with duplicated seam vertices is closed once welded', async () => {
    const r = await gate(await glbOfGeometry(sphere()));
    expect(r.measures).toMatchObject({ boundary_edges: 0, nonmanifold_edges: 0, inconsistent_edges: 0, degenerate_triangles: 0 });
  });

  it('degenerate triangles: repeated index, collinear and coincident', async () => {
    const g = sphere();
    const n = G.vertCount(g);
    g.pos.push(0, 0, 0, 0.01, 0, 0, 0.02, 0, 0, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1);
    g.uv.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    g.idx.push(3, 3, 5, n, n + 1, n + 2, n + 3, n + 4, n + 5);
    const r = await gate(await glbOfGeometry(g));
    expect(r.measures.degenerate_triangles).toBe(3);
    expect(codesOf(r)).toEqual(['DEGENERATE_TRIANGLE']);
  });

  it('inconsistent winding: one flipped triangle', async () => {
    const g = sphere();
    G.flipTriangles(g, [20]);
    const r = await gate(await glbOfGeometry(g));
    expect(r.measures.inconsistent_edges).toBe(3);
    expect(codesOf(r)).toEqual(['WINDING_INCONSISTENT']);
  });

  it('a fully inside-out closed surface has consistent winding', async () => {
    const g = G.flipAll(sphere());
    expect(codesOf(await gate(await glbOfGeometry(g)))).not.toContain('WINDING_INCONSISTENT');
  });

  it('open boundary: a cube missing one face is an error for dynamic and a warning for static', async () => {
    const g = G.box(1, 1, 1);
    G.dropTriangles(g, 4, 2);
    const bytes = await glbOfGeometry(g);
    const dyn = await gate(bytes, { body: 'dynamic' });
    expect(dyn.verdict).toBe('FAIL');
    expect(dyn.diagnostics[0]).toMatchObject({ code: 'OPEN_BOUNDARY', severity: 'error' });
    expect(dyn.measures.boundary_edges).toBe(4);
    const stat = await gate(bytes, { body: 'static' });
    expect(stat.verdict).toBe('PASS');
    expect(stat.diagnostics[0]).toMatchObject({ code: 'OPEN_BOUNDARY', severity: 'warning' });
  });

  it('non-manifold edge: two cubes sharing one edge, error versus warning', async () => {
    const a = G.box(1, 1, 1);
    const b = G.transform(G.box(1, 1, 1), [1, 1, 1], [1, 1, 0]);
    const bytes = await glbOfGeometry(G.merge([a, b]));
    const dyn = await gate(bytes, { body: 'dynamic' });
    expect(codesOf(dyn)).toEqual(['NONMANIFOLD_EDGE']);
    expect(dyn.verdict).toBe('FAIL');
    expect(dyn.measures.nonmanifold_edges).toBe(1);
    expect((await gate(bytes, { body: 'static' })).verdict).toBe('PASS');
  });

  it('two cubes that merely share a face plane do not weld', async () => {
    const a = G.box(1, 1, 1);
    const b = G.transform(G.box(1, 1, 1), [1, 1, 1], [3, 0, 0]);
    const r = await gate(await glbOfGeometry(G.merge([a, b])));
    expect(r.measures.islands).toBe(2);
    expect(r.measures.floating_islands).toBe(0);
  });
});

describe('floating islands (threshold 1% of area)', () => {
  const withShard = async (sharePpm: number) => {
    const main = sphere(0.5, 20, 32);
    const shard = G.box(1, 1, 1);
    const target = (G.surfaceArea(main) * sharePpm) / (1_000_000 - sharePpm);
    const k = Math.sqrt(target / G.surfaceArea(shard));
    return gate(await glbOfGeometry(G.merge([main, G.transform(shard, [k, k, k], [2, 0, 0])])));
  };

  it('flags a shard at 0.9% and spares one at 1.1%', async () => {
    expect(codesOf(await withShard(9_000))).toEqual(['FLOATING_ISLANDS']);
    const ok = await withShard(11_000);
    expect(codesOf(ok)).toEqual([]);
    expect(ok.measures.islands).toBe(2);
  });
});

describe('conformance to a declared box (tolerance 15%)', () => {
  const unit = () => glbOfGeometry(G.box(1, 1, 1));
  it('is not_checked without a box, and says so', async () => {
    const r = await gate(await unit());
    expect(r.checks.bbox).toEqual({ status: 'not_checked', reason: 'no declared box (--box-um)' });
    expect(r.measures.bbox_um).toEqual([1_000_000, 1_000_000, 1_000_000]);
  });

  it('accepts a uniformly scaled box and 14% skew; refuses 16% skew', async () => {
    expect(codesOf(await gate(await unit(), { boxUm: [2_000_000, 2_000_000, 2_000_000] }))).toEqual([]);
    expect(codesOf(await gate(await unit(), { boxUm: [1_000_000, 1_000_000, 1_140_000] }))).toEqual([]);
    const bad = await gate(await unit(), { boxUm: [1_000_000, 1_000_000, 1_160_000] });
    expect(codesOf(bad)).toEqual(['BBOX_CONFORMANCE']);
    expect(bad.diagnostics[0]!.evidence).toMatchObject({ box_um: [1_000_000, 1_000_000, 1_160_000], tolerance_ppm: 150_000 });
  });

  it('a tall lamp for a wide table box fails', async () => {
    const lamp = G.transform(G.cylinder(0.5, 1, 2, 16), [0.3, 1.6, 0.3], [0, 0, 0]);
    expect(codesOf(await gate(await glbOfGeometry(lamp), { boxUm: [1_600_000, 750_000, 900_000] }))).toContain('BBOX_CONFORMANCE');
  });

  it('measures the world box, including node scale and translation', async () => {
    const bytes = await glbOfSpec({ materials: [grey], nodes: [{ parts: [{ geometry: G.box(1, 1, 1), material: 0 }], translation: [5, 5, 5], scale: [2, 1, 3] }] });
    expect((await gate(bytes)).measures.bbox_um).toEqual([2_000_000, 1_000_000, 3_000_000]);
  });
});

describe('collider proxy', () => {
  it('fits a sphere, a box, and otherwise a capped hull', async () => {
    expect((await gate(await glbOfGeometry(sphere()))).measures.collider).toMatchObject({ kind: 'sphere' });
    expect((await gate(await glbOfGeometry(G.box(1, 2, 3)))).measures.collider).toMatchObject({ kind: 'box' });
    const t = (await gate(await glbOfGeometry(torusWithTriangles(40, 20)))).measures.collider as Record<string, number | string>;
    expect(t.kind).toBe('convex_hull');
    expect(t.hull_vertices).toBeLessThanOrEqual(64);
    expect(t.hull_vertices_full).toBeGreaterThan(64);
  });

  it('allows a larger hull on the desktop tier', async () => {
    const m = (await gate(await glbOfGeometry(torusWithTriangles(40, 20)), { tier: 'desktop' })).measures.collider as Record<string, number | string>;
    expect(m.hull_vertices).toBeLessThanOrEqual(128);
    expect(m.hull_vertices).toBeGreaterThan(64);
  });

  it('refuses to derive a hull from a source above 60000 triangles', async () => {
    const at = await gate(await glbOfGeometry(torusWithTriangles(300, 100)), { tier: 'desktop', assetClass: 'hero' });
    expect(at.measures.triangles).toBe(60_000);
    expect(codesOf(at)).not.toContain('HULL_COMPLEXITY');
    expect(at.measures.collider).toMatchObject({ kind: 'convex_hull' });
    const over = await gate(await glbOfGeometry(G.merge([torusWithTriangles(300, 100), G.tetrahedron(0.01)])), { tier: 'desktop', assetClass: 'hero' });
    expect(codesOf(over)).toContain('HULL_COMPLEXITY');
    expect(over.checks.collider.status).toBe('not_checked');
    expect(over.measures.collider).toEqual({ kind: 'none' });
  });

  it('falls back to a box for a flat source', async () => {
    const quad = G.box(1, 1, 1);
    G.transform(quad, [1, 0, 1], [0, 0, 0]);
    expect((await gate(await glbOfGeometry(quad), { body: 'static' })).measures.collider).toMatchObject({ kind: 'box' });
  });
});

describe('an unreadable but valid-looking file', () => {
  it('buildGlb output round-trips through the gate with no abstentions', async () => {
    const bytes = await buildGlb({ materials: [grey], nodes: [{ parts: [{ geometry: sphere(), material: 0 }] }] });
    const r = await gate(bytes);
    expect(Object.values(r.checks).every((c) => c.status !== 'abstained')).toBe(true);
  });
});
