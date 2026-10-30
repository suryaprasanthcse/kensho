import { createHash } from 'node:crypto';
import * as G from './geometry.ts';
import { buildGlb, editGlbJson, type AssetSpec, type MaterialSpec, type NodeSpec } from './glb.ts';
import { makeRng, type Rng } from './prng.ts';

export type Tier = 'mobile' | 'desktop';
export type AssetClass = 'hero' | 'prop' | 'background';
export type Body = 'dynamic' | 'static';

/** The options a fixture is run with. */
export interface GateOptions {
  tier: Tier;
  class: AssetClass;
  body: Body;
  box_um?: [number, number, number];
}

export interface Expected {
  verdict: 'PASS' | 'FAIL';
  /** Codes that must appear in the report, whatever their severity. */
  codes: string[];
  /** Codes that may appear without counting as unexpected. */
  allowed: string[];
}

export interface Fixture {
  id: string;
  /** The defect class, or CONTROL. */
  klass: string;
  /** `error` variants expect a FAIL; `static` variants downgrade topology errors to warnings. */
  variant: 'default' | 'static';
  seed: number;
  control: boolean;
  options: GateOptions;
  expected: Expected;
  bytes: Uint8Array;
}

/** Ground truth from the design's budget table, kept here independently of the gate under test. */
export const TRUTH = {
  triangles: { mobile: { hero: 20_000, prop: 5_000, background: 1_500 }, desktop: { hero: 60_000, prop: 15_000, background: 5_000 } },
  // Primitive and material budgets are this proof's own placeholders; the design gives none.
  primitives: { mobile: { hero: 16, prop: 8, background: 4 }, desktop: { hero: 32, prop: 16, background: 8 } },
  materials: { mobile: { hero: 8, prop: 4, background: 2 }, desktop: { hero: 16, prop: 8, background: 4 } },
  maxTextureDim: { mobile: 2048, desktop: 4096 },
  textureBytes: { mobile: 256 * 1024 * 1024, desktop: 768 * 1024 * 1024 },
  hullSourceTriangles: 60_000,
} as const;

export const CLASS_COUNTS: ReadonlyArray<readonly [string, string, number]> = [
  ['CONTROL', 'default', 40],
  ['GLTF_INVALID', 'default', 10],
  ['TEXTURE_BUDGET', 'default', 10],
  ['NONMANIFOLD_EDGE', 'default', 10],
  ['NONMANIFOLD_EDGE', 'static', 4],
  ['OPEN_BOUNDARY', 'default', 10],
  ['OPEN_BOUNDARY', 'static', 4],
  ['FLOATING_ISLANDS', 'default', 10],
  ['BBOX_CONFORMANCE', 'default', 10],
  ['HULL_COMPLEXITY', 'default', 10],
  ['TRIANGLE_BUDGET', 'default', 10],
  ['PRIMITIVE_BUDGET', 'default', 10],
  ['MATERIAL_BUDGET', 'default', 10],
  ['NONFINITE_POSITION', 'default', 10],
  ['DEGENERATE_TRIANGLE', 'default', 10],
  ['WINDING_INCONSISTENT', 'default', 10],
];

export const fixtureId = (klass: string, variant: string, seed: number): string =>
  `${klass}${variant === 'static' ? '_STATIC' : ''}-${String(seed).padStart(2, '0')}`;

export function listFixtureIds(): string[] {
  const ids: string[] = [];
  for (const [klass, variant, n] of CLASS_COUNTS) for (let s = 0; s < n; s++) ids.push(fixtureId(klass, variant, s));
  return ids;
}

function parseId(id: string): { klass: string; variant: 'default' | 'static'; seed: number } {
  const m = /^([A-Z_]+?)(_STATIC)?-(\d+)$/.exec(id);
  if (!m) throw new Error(`bad fixture id ${id}`);
  return { klass: m[1]!, variant: m[2] ? 'static' : 'default', seed: Number(m[3]) };
}

const TIERS: Tier[] = ['mobile', 'desktop'];
const um = (m: number) => Math.round(m * 1_000_000);

interface Plan {
  options: GateOptions;
  expected: Expected;
  asset: { spec: AssetSpec } | { raw: Uint8Array };
}

const grey = (rng: Rng): [number, number, number] => [0.3 + rng.float() * 0.6, 0.3 + rng.float() * 0.6, 0.3 + rng.float() * 0.6];
const mat = (rng: Rng, extra: Partial<MaterialSpec> = {}): MaterialSpec => ({ color: grey(rng), ...extra });
const oneNode = (g: G.Geometry, translation?: [number, number, number], scale?: [number, number, number]): NodeSpec => ({
  parts: [{ geometry: g, material: 0 }],
  ...(translation ? { translation } : {}),
  ...(scale ? { scale } : {}),
});

type Kind = 'sphere' | 'cylinder' | 'capsule' | 'cone' | 'vase' | 'torus' | 'rock' | 'box';
const KINDS: Kind[] = ['sphere', 'cylinder', 'capsule', 'cone', 'vase', 'torus', 'rock', 'box'];

/** A closed, outward-facing shape of unit-ish size with roughly `target` triangles. */
function closedShape(rng: Rng, kind: Kind, target: number): G.Geometry {
  const { rings, segs } = G.sphereResolution(Math.max(target, 24));
  switch (kind) {
    case 'sphere':
      return G.sphere(0.5, rings, segs);
    case 'rock':
      return G.roughen(G.sphere(0.5, rings, segs), rng, 0.18);
    case 'cylinder': {
      const side = Math.max(1, Math.round(Math.sqrt(target / 4)));
      return G.cylinder(0.5, 1, side, Math.max(3, Math.round(target / (2 * (side + 1)))));
    }
    case 'capsule': {
      const cap = Math.max(2, Math.round(Math.sqrt(target / 8)));
      return G.capsule(0.35, 0.6, cap, Math.max(4, 2 * cap));
    }
    case 'cone': {
      const side = Math.max(1, Math.round(Math.sqrt(target / 6)));
      return G.cone(0.5, 1, side, Math.max(3, Math.round(target / (2 * side))));
    }
    case 'vase': {
      const r = Math.max(4, Math.round(Math.sqrt(target / 4)));
      return G.vase(0.45, 1, r, Math.max(4, 2 * r));
    }
    case 'torus': {
      const t = Math.max(3, Math.round(Math.sqrt(target / 4)));
      return G.torus(0.4, 0.15, 2 * t, t);
    }
    case 'box':
      return G.box(1, 1, 1);
  }
}

/** Scales a geometry so its axis-aligned dimensions are exactly `dims` (metres), centred at the origin. */
function fitDims(g: G.Geometry, dims: [number, number, number]): G.Geometry {
  const b = G.bounds(g);
  const s: [number, number, number] = [0, 1, 2].map((k) => dims[k]! / (b.max[k]! - b.min[k]!)) as [number, number, number];
  const c = [0, 1, 2].map((k) => ((b.max[k]! + b.min[k]!) / 2) * s[k]!);
  return G.transform(g, s, [-c[0]!, -c[1]!, -c[2]!]);
}

function randomDims(rng: Rng, lo = 0.2, hi = 2.4): [number, number, number] {
  return [rng.dyadic(lo, hi), rng.dyadic(lo, hi), rng.dyadic(lo, hi)];
}

function maybeTexture(rng: Rng, p = 0.5): Partial<MaterialSpec> {
  if (rng.float() > p) return {};
  const size = rng.pick([128, 256, 512, 1024]);
  const extra = rng.float() < 0.3 ? [{ width: size, height: size, rgb: [128, 128, 255] as [number, number, number] }] : [];
  return { baseTexture: { width: size, height: size, rgb: [rng.int(0, 255), rng.int(0, 255), rng.int(0, 255)] }, extraTextures: extra };
}

function controlPlan(rng: Rng, seed: number): Plan {
  const tier = TIERS[seed % 2]!;
  const cls: AssetClass = seed % 13 === 5 ? 'hero' : seed % 11 === 7 ? 'background' : 'prop';
  const budget = TRUTH.triangles[tier][cls];
  const target = Math.max(24, Math.floor(budget * rng.pick([0.02, 0.1, 0.3, 0.6])));
  const kind = rng.pick(KINDS);
  const body: Body = seed % 5 === 3 ? 'static' : 'dynamic';
  const dims = cls === 'background' ? randomDims(rng, 0.5, 4) : randomDims(rng);
  const nodes: NodeSpec[] = [];
  let materials: MaterialSpec[];
  let declaredBase: [number, number, number];
  if (seed % 9 === 4 && cls !== 'background') {
    // a multi-part prop: a top and four legs, each far above the floating-island threshold
    const top = G.box(1.6, 0.05, 0.9);
    const legs = [[-0.7, -0.4], [0.7, -0.4], [-0.7, 0.4], [0.7, 0.4]].map(([x, z]) => G.transform(G.box(0.06, 0.7, 0.06), [1, 1, 1], [x!, -0.375, z!]));
    nodes.push({ parts: [{ geometry: G.merge([top, ...legs]), material: 0 }] });
    materials = [mat(rng)];
    declaredBase = [1.6, 0.75, 0.9];
  } else {
    const g = fitDims(closedShape(rng, kind, target), dims);
    nodes.push(oneNode(g, [0, dims[1] / 2, 0]));
    materials = [mat(rng, maybeTexture(rng))];
    declaredBase = dims;
  }
  const options: GateOptions = { tier, class: cls, body };
  if (seed % 3 === 0) {
    const k = rng.pick([0.5, 1, 1.5, 2]);
    options.box_um = declaredBase.map((d) => um(d * k * (0.95 + rng.float() * 0.1))) as [number, number, number];
  }
  return { options, expected: { verdict: 'PASS', codes: [], allowed: [] }, asset: { spec: { materials, nodes } } };
}

function smallBase(rng: Rng, target = 400): G.Geometry {
  return fitDims(closedShape(rng, rng.pick(['sphere', 'cylinder', 'capsule', 'rock'] as Kind[]), target), randomDims(rng, 0.3, 1.5));
}

async function gltfInvalidPlan(rng: Rng, seed: number): Promise<Plan> {
  const base = await buildGlb({ materials: [mat(rng)], nodes: [oneNode(smallBase(rng, 200))] });
  let out: Uint8Array;
  switch (seed % 5) {
    case 0:
      out = base.subarray(0, Math.floor(base.length * (0.3 + rng.float() * 0.6)));
      break;
    case 1:
      out = Uint8Array.from(base);
      out.set(Buffer.from('XLTF'), 0);
      break;
    case 2: {
      out = Uint8Array.from(base);
      new DataView(out.buffer).setUint32(12, base.length + 4096 + rng.int(0, 4096), true);
      break;
    }
    case 3:
      out = editGlbJson(base, (j) => {
        const acc = j.accessors as { bufferView: number }[];
        acc[rng.int(0, acc.length - 1)]!.bufferView = 900 + rng.int(0, 99);
      });
      break;
    default:
      out = editGlbJson(base, (j) => {
        delete j.asset;
      });
  }
  return { options: { tier: 'mobile', class: 'prop', body: 'dynamic' }, expected: { verdict: 'FAIL', codes: ['GLTF_INVALID'], allowed: [] }, asset: { raw: out } };
}

function textureBudgetPlan(rng: Rng, seed: number): Plan {
  const memoryOnly = seed >= 7;
  const tier: Tier = memoryOnly ? 'desktop' : TIERS[seed % 2]!;
  const base = smallBase(rng, 300);
  let materials: MaterialSpec[];
  if (memoryOnly) {
    // 12 distinct 4096x4096 images: each within the dimension limit, together far over the memory budget
    materials = [0, 1, 2].map((m) => {
      const t = (i: number) => ({ width: 4096, height: 4096, rgb: [m * 40 + i * 9 + seed, 50 + i * 20, 90 + m * 30] as [number, number, number] });
      return { color: grey(rng), baseTexture: t(0), extraTextures: [t(1), t(2), t(3)] };
    });
  } else {
    const dims: Record<Tier, [number, number][]> = {
      mobile: [[4096, 4096], [6144, 6144], [8192, 8192], [12288, 12288], [4096, 1024], [2048, 4096], [8192, 2048]],
      desktop: [[8192, 8192], [12288, 12288], [16384, 4096], [8192, 1024], [5120, 5120], [4097, 64], [6144, 6144]],
    };
    const [w, h] = dims[tier][seed % 7]!;
    materials = [{ color: grey(rng), baseTexture: { width: w, height: h, rgb: [rng.int(0, 255), rng.int(0, 255), rng.int(0, 255)] } }];
  }
  // extra materials are carried by clones of the base shape placed beside it
  const parts = materials.map((_, i) => ({ geometry: i === 0 ? base : G.compact(base), material: i }));
  const nodes: NodeSpec[] = [{ parts: [parts[0]!] }];
  for (let i = 1; i < parts.length; i++) nodes.push({ parts: [parts[i]!], translation: [2 * i, 0, 0] });
  return { options: { tier, class: 'prop', body: 'dynamic' }, expected: { verdict: 'FAIL', codes: ['TEXTURE_BUDGET'], allowed: [] }, asset: { spec: { materials, nodes } } };
}

/** Two boxes sharing exactly one edge (four triangles meet on it). */
function nonManifoldPlan(rng: Rng, seed: number, variant: 'default' | 'static'): Plan {
  const wa = rng.dyadic(0.25, 1.5), ha = rng.dyadic(0.25, 1.5), wb = rng.dyadic(0.25, 1.5), hb = rng.dyadic(0.25, 1.5), d = rng.dyadic(0.25, 1.5);
  const sx = rng.pick([-1, 1]), sy = rng.pick([-1, 1]);
  const a = G.box(wa, ha, d);
  const b = G.transform(G.box(wb, hb, d), [1, 1, 1], [sx * (wa + wb) / 2, sy * (ha + hb) / 2, 0]);
  const body: Body = variant === 'static' ? 'static' : 'dynamic';
  const tier = TIERS[seed % 2]!;
  return {
    options: { tier, class: 'prop', body },
    expected: { verdict: variant === 'static' ? 'PASS' : 'FAIL', codes: ['NONMANIFOLD_EDGE'], allowed: [] },
    asset: { spec: { materials: [mat(rng)], nodes: [oneNode(G.merge([a, b]))] } },
  };
}

function openBoundaryPlan(rng: Rng, seed: number, variant: 'default' | 'static'): Plan {
  const kinds: Kind[] = ['box', 'cylinder', 'sphere', 'capsule'];
  const kind = kinds[seed % 4]!;
  let g = closedShape(rng, kind, rng.int(200, 1200));
  const tris = G.triCount(g);
  if (kind === 'box') {
    const face = rng.int(0, 5);
    G.dropTriangles(g, face * 2, 2);
  } else if (kind === 'cylinder' && seed % 8 === 1) {
    // remove a whole cap: the lathe emits triangles ring by ring, so the first `segs` are the bottom cap
    G.dropTriangles(g, 0, rng.int(6, 12));
  } else {
    const n = rng.int(2, Math.max(2, Math.floor(tris * 0.05)));
    G.dropTriangles(g, rng.int(0, tris - n - 1), n);
  }
  g = fitDims(g, randomDims(rng, 0.3, 1.8));
  const body: Body = variant === 'static' ? 'static' : 'dynamic';
  return {
    options: { tier: TIERS[seed % 2]!, class: 'prop', body },
    expected: { verdict: variant === 'static' ? 'PASS' : 'FAIL', codes: ['OPEN_BOUNDARY'], allowed: [] },
    asset: { spec: { materials: [mat(rng)], nodes: [oneNode(g)] } },
  };
}

function floatingIslandsPlan(rng: Rng, seed: number): Plan {
  const kind = rng.pick(['sphere', 'box', 'cylinder', 'rock'] as Kind[]);
  const main = fitDims(closedShape(rng, kind, rng.int(300, 1500)), randomDims(rng, 0.5, 1.5));
  const share = rng.int(5, 80) / 10_000;
  const shardShape = seed % 2 === 0 ? G.box(1, 1, 1) : G.tetrahedron(1);
  const target = (G.surfaceArea(main) * share) / (1 - share);
  const k = Math.sqrt(target / G.surfaceArea(shardShape));
  const b = G.bounds(main);
  const reach = Math.max(b.max[0]! - b.min[0]!, b.max[1]! - b.min[1]!, b.max[2]! - b.min[2]!);
  const shard = G.transform(shardShape, [k, k, k], [reach * 1.2, reach * 0.1, 0]);
  const separate = seed % 3 === 0;
  const spec: AssetSpec = separate
    ? { materials: [mat(rng)], nodes: [{ parts: [{ geometry: main, material: 0 }, { geometry: shard, material: 0 }] }] }
    : { materials: [mat(rng)], nodes: [oneNode(G.merge([main, shard]))] };
  return { options: { tier: TIERS[seed % 2]!, class: 'prop', body: 'dynamic' }, expected: { verdict: 'FAIL', codes: ['FLOATING_ISLANDS'], allowed: [] }, asset: { spec } };
}

function bboxPlan(rng: Rng, seed: number): Plan {
  const declared = randomDims(rng, 0.4, 2.4);
  const dims: [number, number, number] = [...declared];
  const axis = seed % 3;
  const f = rng.pick([1.7, 2.2, 0.45, 0.55, 3, 0.35]);
  dims[axis] = Math.max(0.05, declared[axis]! * f);
  if (seed % 2 === 0) {
    // a tall lamp delivered for a wide table box
    const other = (axis + 1) % 3;
    dims[other] = declared[other]! * rng.pick([0.4, 0.5, 1.9]);
  }
  const g = fitDims(closedShape(rng, rng.pick(['cylinder', 'box', 'capsule', 'sphere'] as Kind[]), 300), dims);
  return {
    options: { tier: TIERS[seed % 2]!, class: 'prop', body: 'dynamic', box_um: declared.map(um) as [number, number, number] },
    expected: { verdict: 'FAIL', codes: ['BBOX_CONFORMANCE'], allowed: [] },
    asset: { spec: { materials: [mat(rng)], nodes: [oneNode(g, [0, dims[1] / 2, 0])] } },
  };
}

function hullPlan(rng: Rng, seed: number): Plan {
  const { rings, segs } = G.sphereResolution(rng.int(66_000, 180_000));
  const g = fitDims(G.roughen(G.sphere(0.5, rings, segs), rng, 0.15), randomDims(rng, 0.5, 1.5));
  return {
    options: { tier: TIERS[seed % 2]!, class: 'prop', body: 'dynamic' },
    expected: { verdict: 'FAIL', codes: ['HULL_COMPLEXITY', 'TRIANGLE_BUDGET'], allowed: [] },
    asset: { spec: { materials: [mat(rng)], nodes: [oneNode(g)] } },
  };
}

function trianglePlan(rng: Rng, seed: number): Plan {
  const combos: [Tier, AssetClass][] = [['mobile', 'prop'], ['mobile', 'background'], ['mobile', 'hero'], ['desktop', 'prop'], ['desktop', 'background']];
  const [tier, cls] = combos[seed % combos.length]!;
  const budget = TRUTH.triangles[tier][cls];
  const target = Math.min(55_000, Math.floor(budget * (1.1 + rng.float() * 2.2)));
  const { rings, segs } = G.sphereResolution(Math.max(target, budget + Math.ceil(3 * Math.sqrt(budget)) + 50));
  const g = fitDims(seed % 2 === 0 ? G.roughen(G.sphere(0.5, rings, segs), rng, 0.12) : G.sphere(0.5, rings, segs), randomDims(rng, 0.4, 1.6));
  if (G.triCount(g) <= budget) throw new Error('triangle fixture does not exceed its budget');
  return {
    options: { tier, class: cls, body: 'dynamic' },
    expected: { verdict: 'FAIL', codes: ['TRIANGLE_BUDGET'], allowed: [] },
    asset: { spec: { materials: [mat(rng)], nodes: [oneNode(g)] } },
  };
}

function banded(rng: Rng, bands: number, materialCount: number): AssetSpec {
  const rings = bands + 1;
  const g = fitDims(G.sphere(0.5, rings, Math.max(8, Math.min(24, 4 * Math.ceil(80 / bands)))), randomDims(rng, 0.4, 1.4));
  const parts = G.splitConsecutive(g, bands).map((geometry, i) => ({ geometry, material: i % materialCount }));
  return { materials: Array.from({ length: materialCount }, () => mat(rng)), nodes: [{ parts }] };
}

function primitivePlan(rng: Rng, seed: number): Plan {
  const combos: [Tier, AssetClass][] = [['mobile', 'prop'], ['desktop', 'prop'], ['mobile', 'hero'], ['mobile', 'background'], ['desktop', 'background']];
  const [tier, cls] = combos[seed % combos.length]!;
  const limit = TRUTH.primitives[tier][cls];
  const bands = rng.int(limit + 4, Math.min(limit * 2 + 6, 48));
  return { options: { tier, class: cls, body: 'dynamic' }, expected: { verdict: 'FAIL', codes: ['PRIMITIVE_BUDGET'], allowed: [] }, asset: { spec: banded(rng, bands, 1) } };
}

function materialPlan(rng: Rng, seed: number): Plan {
  const combos: [Tier, AssetClass][] = [['mobile', 'prop'], ['desktop', 'prop'], ['mobile', 'hero'], ['mobile', 'background'], ['desktop', 'background']];
  const [tier, cls] = combos[seed % combos.length]!;
  const mlimit = TRUTH.materials[tier][cls];
  const plimit = TRUTH.primitives[tier][cls];
  const count = rng.int(mlimit + 1, plimit);
  return { options: { tier, class: cls, body: 'dynamic' }, expected: { verdict: 'FAIL', codes: ['MATERIAL_BUDGET'], allowed: [] }, asset: { spec: banded(rng, count, count) } };
}

function nonFinitePlan(rng: Rng, seed: number): Plan {
  const g = smallBase(rng, 300);
  const n = rng.int(1, 5);
  const bad = [NaN, Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const v = rng.int(0, G.vertCount(g) - 1);
    g.pos[v * 3 + rng.int(0, 2)] = bad[rng.int(0, 2)]!;
  }
  return {
    options: { tier: TIERS[seed % 2]!, class: 'prop', body: 'dynamic' },
    expected: { verdict: 'FAIL', codes: ['NONFINITE_POSITION'], allowed: ['GLTF_INVALID'] },
    asset: { spec: { materials: [mat(rng)], nodes: [oneNode(g)] } },
  };
}

function degeneratePlan(rng: Rng, seed: number): Plan {
  const g = fitDims(closedShape(rng, rng.pick(['sphere', 'cylinder', 'capsule', 'torus'] as Kind[]), 400), randomDims(rng, 0.4, 1.6));
  const k = rng.int(1, 20);
  for (let i = 0; i < k; i++) {
    const n = G.vertCount(g);
    if (i % 3 === 0) {
      const a = rng.int(0, n - 1);
      g.idx.push(a, a, rng.int(0, n - 1));
    } else if (i % 3 === 1) {
      const x = (rng.float() - 0.5) * 0.05;
      g.pos.push(x - 0.02, 0, 0, x, 0, 0, x + 0.02, 0, 0);
      g.uv.push(0, 0, 0, 0, 0, 0);
      g.idx.push(n, n + 1, n + 2);
    } else {
      g.pos.push(0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01);
      g.uv.push(0, 0, 0, 0, 0, 0);
      g.idx.push(n, n + 1, n + 2);
    }
  }
  return {
    options: { tier: TIERS[seed % 2]!, class: 'prop', body: 'dynamic' },
    expected: { verdict: 'FAIL', codes: ['DEGENERATE_TRIANGLE'], allowed: [] },
    asset: { spec: { materials: [mat(rng)], nodes: [oneNode(g)] } },
  };
}

function windingPlan(rng: Rng, seed: number): Plan {
  const kind = (['sphere', 'box', 'torus', 'cylinder'] as Kind[])[seed % 4]!;
  const g = fitDims(closedShape(rng, kind, rng.int(150, 1000)), randomDims(rng, 0.4, 1.6));
  const tris = G.triCount(g);
  const k = Math.max(1, Math.round(tris * (0.01 + rng.float() * 0.29)));
  const order = rng.shuffle(Array.from({ length: tris }, (_, i) => i)).slice(0, kind === 'box' ? Math.min(k, 3) : k);
  G.flipTriangles(g, order);
  return {
    options: { tier: TIERS[seed % 2]!, class: 'prop', body: 'dynamic' },
    expected: { verdict: 'FAIL', codes: ['WINDING_INCONSISTENT'], allowed: [] },
    asset: { spec: { materials: [mat(rng)], nodes: [oneNode(g)] } },
  };
}

/** Builds one fixture. Everything derives from the id: no ambient randomness, no clock. */
export async function buildFixture(id: string): Promise<Fixture> {
  const { klass, variant, seed } = parseId(id);
  const rng = makeRng(id);
  let plan: Plan;
  switch (klass) {
    case 'CONTROL': plan = controlPlan(rng, seed); break;
    case 'GLTF_INVALID': plan = await gltfInvalidPlan(rng, seed); break;
    case 'TEXTURE_BUDGET': plan = textureBudgetPlan(rng, seed); break;
    case 'NONMANIFOLD_EDGE': plan = nonManifoldPlan(rng, seed, variant); break;
    case 'OPEN_BOUNDARY': plan = openBoundaryPlan(rng, seed, variant); break;
    case 'FLOATING_ISLANDS': plan = floatingIslandsPlan(rng, seed); break;
    case 'BBOX_CONFORMANCE': plan = bboxPlan(rng, seed); break;
    case 'HULL_COMPLEXITY': plan = hullPlan(rng, seed); break;
    case 'TRIANGLE_BUDGET': plan = trianglePlan(rng, seed); break;
    case 'PRIMITIVE_BUDGET': plan = primitivePlan(rng, seed); break;
    case 'MATERIAL_BUDGET': plan = materialPlan(rng, seed); break;
    case 'NONFINITE_POSITION': plan = nonFinitePlan(rng, seed); break;
    case 'DEGENERATE_TRIANGLE': plan = degeneratePlan(rng, seed); break;
    case 'WINDING_INCONSISTENT': plan = windingPlan(rng, seed); break;
    default: throw new Error(`unknown fixture class ${klass}`);
  }
  const bytes = 'raw' in plan.asset ? plan.asset.raw : await buildGlb(plan.asset.spec);
  return { id, klass, variant, seed, control: klass === 'CONTROL', options: plan.options, expected: plan.expected, bytes };
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
