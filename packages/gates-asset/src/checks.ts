import type { Document } from '@gltf-transform/core';
import validator from 'gltf-validator';
import { ImageUtils } from '@gltf-transform/core';
import { makeDiagnostic, isJsonPointer, pointerFrom, type Diagnostic, type Severity } from '@kensho/diagnostics';
import type { Json } from '@kensho/ir';
import { BUDGETS, THRESHOLDS, type Budgets } from './budgets.ts';
import { capHull, convexHull } from './hull.ts';
import {
  buildAssetModel,
  buildMeshModel,
  det3,
  parseGlb,
  primitiveOfTriangle,
  rawTriangleCount,
  readPositions,
  transformPoint,
  type AssetModel,
  type MeshModel,
} from './model.ts';
import type { AssetGateOptions, CheckId, CheckOutput } from './types.ts';

export const VALIDATOR_VERSION: string = validator.version();

interface MeshTopology {
  nonDegenerate: Int32Array;
  degenerate: number;
  firstDegenerateTri: number;
  boundary: number;
  nonManifold: number;
  inconsistent: number;
  /** Surface area of each connected component, in square metres, in mesh-local space. */
  componentAreas: number[];
}

export interface Ctx {
  bytes: Uint8Array;
  options: AssetGateOptions;
  budgets: Budgets;
  validatorErrors: number;
  doc: Document | null;
  model: AssetModel | null;
  nonFinite: boolean;
  hullTooComplex: boolean;
  totalTriangles: number;
  meshModels: Map<number, MeshModel>;
  topo: Map<number, MeshTopology>;
}

export function makeCtx(bytes: Uint8Array, options: AssetGateOptions): Ctx {
  return {
    bytes,
    options,
    budgets: BUDGETS[options.tier],
    validatorErrors: 0,
    doc: null,
    model: null,
    nonFinite: false,
    hullTooComplex: false,
    totalTriangles: 0,
    meshModels: new Map(),
    topo: new Map(),
  };
}

const ran = (diagnostics: Diagnostic[] = [], measures: { [k: string]: Json } = {}): CheckOutput => ({ record: { status: 'ran' }, diagnostics, measures });
const notChecked = (reason: string, measures: { [k: string]: Json } = {}): CheckOutput => ({ record: { status: 'not_checked', reason }, diagnostics: [], measures });
export const abstained = (reason: string): CheckOutput => ({ record: { status: 'abstained', reason }, diagnostics: [], measures: {} });

const cleanPointer = (p: string | undefined): string => (p && isJsonPointer(p) ? p : '');
const sceneOrRoot = (doc: Document | null): string => (doc && doc.getRoot().listScenes().length ? '/scenes/0' : '');

function meshOf(ctx: Ctx, index: number): MeshModel {
  let m = ctx.meshModels.get(index);
  if (!m) {
    m = buildMeshModel(ctx.model!.meshes[index]!, index);
    ctx.meshModels.set(index, m);
  }
  return m;
}

function topologyOf(ctx: Ctx, index: number): MeshTopology {
  const cached = ctx.topo.get(index);
  if (cached) return cached;
  const m = meshOf(ctx, index);
  const total = m.tris.length / 3;
  const keep: number[] = [];
  let degenerate = 0;
  let firstDegenerateTri = -1;
  const areaOf: number[] = [];
  for (let t = 0; t < total; t++) {
    const a = m.tris[t * 3]!, b = m.tris[t * 3 + 1]!, c = m.tris[t * 3 + 2]!;
    let area2um = 0;
    if (a !== b && b !== c && a !== c) {
      const ux = m.pos[b * 3]! - m.pos[a * 3]!, uy = m.pos[b * 3 + 1]! - m.pos[a * 3 + 1]!, uz = m.pos[b * 3 + 2]! - m.pos[a * 3 + 2]!;
      const vx = m.pos[c * 3]! - m.pos[a * 3]!, vy = m.pos[c * 3 + 1]! - m.pos[a * 3 + 1]!, vz = m.pos[c * 3 + 2]! - m.pos[a * 3 + 2]!;
      const areaM2 = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      area2um = areaM2 * 1e12;
      if (area2um > THRESHOLDS.degenerateAreaUm2) {
        keep.push(a, b, c);
        areaOf.push(areaM2);
        continue;
      }
    }
    degenerate++;
    if (firstDegenerateTri < 0) firstDegenerateTri = t;
  }
  const nonDegenerate = Int32Array.from(keep);
  const T = nonDegenerate.length / 3;
  const V = m.vertexCount;

  // edges: one packed number per directed edge, sorted, then grouped
  const packed = new Float64Array(T * 3);
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < 3; e++) {
      const a = nonDegenerate[t * 3 + e]!, b = nonDegenerate[t * 3 + ((e + 1) % 3)]!;
      const lo = a < b ? a : b, hi = a < b ? b : a;
      packed[t * 3 + e] = (lo * V + hi) * 2 + (a < b ? 0 : 1);
    }
  }
  packed.sort();
  let boundary = 0, nonManifold = 0, inconsistent = 0;
  for (let i = 0; i < packed.length; ) {
    const key = Math.floor(packed[i]! / 2);
    let j = i, ones = 0;
    while (j < packed.length && Math.floor(packed[j]! / 2) === key) {
      if (packed[j]! % 2 === 1) ones++;
      j++;
    }
    const count = j - i;
    if (count === 1) boundary++;
    else if (count === 2) {
      if (ones !== 1) inconsistent++;
    } else nonManifold++;
    i = j;
  }

  // connected components over welded vertices
  const parent = new Int32Array(V);
  for (let i = 0; i < V; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (let t = 0; t < T; t++) {
    const ra = find(nonDegenerate[t * 3]!), rb = find(nonDegenerate[t * 3 + 1]!), rc = find(nonDegenerate[t * 3 + 2]!);
    if (ra !== rb) parent[rb] = ra;
    const r = find(ra);
    if (rc !== r) parent[find(rc)] = r;
  }
  const compArea = new Map<number, number>();
  for (let t = 0; t < T; t++) {
    const r = find(nonDegenerate[t * 3]!);
    compArea.set(r, (compArea.get(r) ?? 0) + areaOf[t]!);
  }
  const topo: MeshTopology = { nonDegenerate, degenerate, firstDegenerateTri, boundary, nonManifold, inconsistent, componentAreas: [...compArea.values()].sort((x, y) => x - y) };
  ctx.topo.set(index, topo);
  return topo;
}

const SPHERE_FILL_PPM = Math.round((Math.PI / 6) * 1_000_000);

const meshIndices = (ctx: Ctx): number[] => [...new Set(ctx.model!.instances.map((i) => i.meshIndex))].sort((a, b) => a - b);

const diagSeverity = (body: AssetGateOptions['body']): Severity => (body === 'dynamic' ? 'error' : 'warning');

type CheckFn = (ctx: Ctx) => Promise<CheckOutput> | CheckOutput;

export const CHECKS: Record<CheckId, CheckFn> = {
  async validator(ctx) {
    let report;
    try {
      report = await validator.validateBytes(ctx.bytes, { uri: 'asset.glb', maxIssues: 500 });
    } catch (e) {
      // the validator rejects with this text when the bytes are neither a GLB nor glTF JSON: a definite verdict on the input
      if (typeof e === 'string' && e.startsWith('Invalid data')) {
        ctx.validatorErrors = 1;
        return ran([makeDiagnostic('GLTF_INVALID', { pointer: '', message: e, evidence: { validator_code: 'FORMAT_UNDETECTED', occurrences: 1 } })], { validator_errors: 1, validator_warnings: 0 });
      }
      throw e;
    }
    const errors = report.issues.messages.filter((m) => m.severity === 0);
    ctx.validatorErrors = report.issues.numErrors;
    const byCode = new Map<string, typeof errors>();
    for (const e of errors) byCode.set(e.code, [...(byCode.get(e.code) ?? []), e]);
    const diagnostics: Diagnostic[] = [];
    for (const [code, list] of [...byCode].sort((a, b) => a[0].localeCompare(b[0], 'en'))) {
      const first = list[0]!;
      diagnostics.push(
        makeDiagnostic('GLTF_INVALID', {
          pointer: cleanPointer(first.pointer),
          message: `${code}: ${first.message}`,
          evidence: { validator_code: code, occurrences: list.length },
        }),
      );
    }
    if (report.issues.numErrors > 0 && diagnostics.length === 0) {
      diagnostics.push(makeDiagnostic('GLTF_INVALID', { pointer: '', message: 'validator reported errors', evidence: { errors: report.issues.numErrors } }));
    }
    return ran(diagnostics, { validator_errors: report.issues.numErrors, validator_warnings: report.issues.numWarnings });
  },

  async parse(ctx) {
    try {
      ctx.doc = await parseGlb(ctx.bytes);
      ctx.model = buildAssetModel(ctx.doc);
      return ran([], { meshes: ctx.model.meshes.length, instances: ctx.model.instances.length });
    } catch (e) {
      const why = `parse failed: ${(e as Error).message}`;
      // a definite validator failure already explains an unreadable file; otherwise we simply could not look
      return ctx.validatorErrors > 0 ? notChecked(why) : abstained(why);
    }
  },

  triangles(ctx) {
    let total = 0;
    for (const inst of ctx.model!.instances) for (const p of inst.mesh.listPrimitives()) total += rawTriangleCount(p);
    ctx.totalTriangles = total;
    const budget = ctx.budgets.triangles[ctx.options.assetClass];
    const diagnostics =
      total > budget
        ? [makeDiagnostic('TRIANGLE_BUDGET', { pointer: '/meshes', message: `${total} triangles exceed the ${ctx.options.tier} ${ctx.options.assetClass} budget of ${budget}`, evidence: { triangles: total, budget } })]
        : [];
    return ran(diagnostics, { triangles: total });
  },

  primitives(ctx) {
    let total = 0;
    for (const inst of ctx.model!.instances) total += inst.mesh.listPrimitives().length;
    const budget = ctx.budgets.primitives[ctx.options.assetClass];
    const diagnostics =
      total > budget
        ? [makeDiagnostic('PRIMITIVE_BUDGET', { pointer: '/meshes', message: `${total} primitives exceed the ${ctx.options.tier} ${ctx.options.assetClass} budget of ${budget}`, evidence: { primitives: total, budget } })]
        : [];
    return ran(diagnostics, { primitives: total });
  },

  materials(ctx) {
    const used = new Set<unknown>();
    for (const inst of ctx.model!.instances) for (const p of inst.mesh.listPrimitives()) used.add(p.getMaterial() ?? 'default');
    const total = used.size;
    const budget = ctx.budgets.materials[ctx.options.assetClass];
    const diagnostics =
      total > budget
        ? [makeDiagnostic('MATERIAL_BUDGET', { pointer: '/materials', message: `${total} materials exceed the ${ctx.options.tier} ${ctx.options.assetClass} budget of ${budget}`, evidence: { materials: total, budget } })]
        : [];
    return ran(diagnostics, { materials: total });
  },

  textures(ctx) {
    const textures = ctx.doc!.getRoot().listTextures();
    const diagnostics: Diagnostic[] = [];
    let images = 0, maxDim = 0, bytes = 0;
    let unknown: string | null = null;
    textures.forEach((tex, i) => {
      if (!tex.listParents().some((p) => p.propertyType !== 'Root')) return; // referenced by nothing
      const data = tex.getImage();
      const size = data ? ImageUtils.getSize(data, tex.getMimeType()) : null;
      if (!size) {
        unknown ??= `texture ${i} has unreadable or external image data (${tex.getMimeType() || 'unknown type'})`;
        return;
      }
      const [w, h] = size as [number, number];
      images++;
      maxDim = Math.max(maxDim, w, h);
      bytes += Math.ceil((w * h * 16) / 3);
      if (Math.max(w, h) > ctx.budgets.maxTextureDim) {
        diagnostics.push(
          makeDiagnostic('TEXTURE_BUDGET', {
            pointer: pointerFrom('images', i),
            message: `texture ${w}x${h} exceeds the ${ctx.options.tier} maximum dimension of ${ctx.budgets.maxTextureDim}`,
            evidence: { width: w, height: h, max_dimension: ctx.budgets.maxTextureDim },
          }),
        );
      }
    });
    if (bytes > ctx.budgets.textureBytes) {
      diagnostics.push(
        makeDiagnostic('TEXTURE_BUDGET', {
          pointer: '/images',
          message: `estimated ${bytes} GPU texture bytes exceed the ${ctx.options.tier} budget of ${ctx.budgets.textureBytes}`,
          evidence: { gpu_bytes: bytes, budget_bytes: ctx.budgets.textureBytes, images },
        }),
      );
    }
    const measures = { images, texture_max_dim: maxDim, texture_gpu_bytes: bytes };
    if (unknown) return { record: { status: 'abstained', reason: unknown }, diagnostics, measures };
    return ran(diagnostics, measures);
  },

  finite(ctx) {
    let bad = 0;
    let first: string | null = null;
    ctx.model!.meshes.forEach((mesh, mi) => {
      mesh.listPrimitives().forEach((prim, pi) => {
        const acc = prim.getAttribute('POSITION');
        if (!acc) return;
        const P = readPositions(acc);
        for (let v = 0; v < acc.getCount(); v++) {
          if (!Number.isFinite(P[v * 3]!) || !Number.isFinite(P[v * 3 + 1]!) || !Number.isFinite(P[v * 3 + 2]!)) {
            bad++;
            first ??= pointerFrom('meshes', mi, 'primitives', pi);
          }
        }
      });
    });
    ctx.nonFinite = bad > 0;
    const diagnostics = bad
      ? [makeDiagnostic('NONFINITE_POSITION', { pointer: first!, message: `${bad} vertex position(s) are not finite`, evidence: { vertices: bad } })]
      : [];
    return ran(diagnostics, { nonfinite_vertices: bad });
  },

  degenerate(ctx) {
    if (ctx.nonFinite) return notChecked('non-finite positions');
    let total = 0, firstMesh = -1, firstPrim = 0;
    for (const mi of meshIndices(ctx)) {
      const t = topologyOf(ctx, mi);
      if (t.degenerate && firstMesh < 0) {
        firstMesh = mi;
        firstPrim = primitiveOfTriangle(meshOf(ctx, mi), t.firstDegenerateTri);
      }
      total += t.degenerate;
    }
    const diagnostics = total
      ? [makeDiagnostic('DEGENERATE_TRIANGLE', { pointer: pointerFrom('meshes', firstMesh, 'primitives', firstPrim), message: `${total} degenerate triangle(s)`, evidence: { triangles: total } })]
      : [];
    return ran(diagnostics, { degenerate_triangles: total });
  },

  winding(ctx) {
    if (ctx.nonFinite) return notChecked('non-finite positions');
    let total = 0, firstMesh = -1;
    for (const mi of meshIndices(ctx)) {
      const t = topologyOf(ctx, mi);
      if (t.inconsistent && firstMesh < 0) firstMesh = mi;
      total += t.inconsistent;
    }
    const diagnostics = total
      ? [makeDiagnostic('WINDING_INCONSISTENT', { pointer: pointerFrom('meshes', firstMesh), message: `${total} edge(s) join triangles of opposite winding`, evidence: { edges: total } })]
      : [];
    return ran(diagnostics, { inconsistent_edges: total });
  },

  boundary(ctx) {
    if (ctx.nonFinite) return notChecked('non-finite positions');
    let total = 0, firstMesh = -1;
    for (const mi of meshIndices(ctx)) {
      const t = topologyOf(ctx, mi);
      if (t.boundary && firstMesh < 0) firstMesh = mi;
      total += t.boundary;
    }
    const diagnostics = total
      ? [makeDiagnostic('OPEN_BOUNDARY', { pointer: pointerFrom('meshes', firstMesh), message: `${total} boundary edge(s) after weld: the surface is not closed`, severity: diagSeverity(ctx.options.body), evidence: { edges: total } })]
      : [];
    return ran(diagnostics, { boundary_edges: total });
  },

  nonmanifold(ctx) {
    if (ctx.nonFinite) return notChecked('non-finite positions');
    let total = 0, firstMesh = -1;
    for (const mi of meshIndices(ctx)) {
      const t = topologyOf(ctx, mi);
      if (t.nonManifold && firstMesh < 0) firstMesh = mi;
      total += t.nonManifold;
    }
    const diagnostics = total
      ? [makeDiagnostic('NONMANIFOLD_EDGE', { pointer: pointerFrom('meshes', firstMesh), message: `${total} edge(s) shared by three or more triangles after weld`, severity: diagSeverity(ctx.options.body), evidence: { edges: total } })]
      : [];
    return ran(diagnostics, { nonmanifold_edges: total });
  },

  islands(ctx) {
    if (ctx.nonFinite) return notChecked('non-finite positions');
    const areas: number[] = [];
    for (const inst of ctx.model!.instances) {
      const s = Math.cbrt(Math.abs(det3(inst.world)));
      for (const a of topologyOf(ctx, inst.meshIndex).componentAreas) areas.push(a * s * s);
    }
    areas.sort((x, y) => x - y); // a fixed order, so the sum does not depend on node order
    const total = areas.reduce((x, y) => x + y, 0);
    if (!(total > 0)) return ran([], { islands: areas.length, floating_islands: 0 });
    let floating = 0, smallest = Infinity;
    for (const a of areas) {
      const share = (a / total) * 1_000_000;
      if (share < smallest) smallest = share;
      if (share < THRESHOLDS.islandSharePpm) floating++;
    }
    const smallestPpm = Math.round(smallest);
    const diagnostics = floating
      ? [makeDiagnostic('FLOATING_ISLANDS', { pointer: '/meshes', message: `${floating} detached component(s) hold under ${THRESHOLDS.islandSharePpm / 10_000}% of the surface area each`, evidence: { floating, islands: areas.length, smallest_share_ppm: smallestPpm, threshold_ppm: THRESHOLDS.islandSharePpm } })]
      : [];
    return ran(diagnostics, { islands: areas.length, floating_islands: floating, smallest_island_share_ppm: smallestPpm });
  },

  bbox(ctx) {
    if (ctx.nonFinite) return notChecked('non-finite positions');
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const inst of ctx.model!.instances) {
      const m = meshOf(ctx, inst.meshIndex);
      for (let v = 0; v < m.vertexCount; v++) {
        const p = transformPoint(inst.world, m.pos[v * 3]!, m.pos[v * 3 + 1]!, m.pos[v * 3 + 2]!);
        for (let k = 0; k < 3; k++) {
          if (p[k]! < min[k]!) min[k] = p[k]!;
          if (p[k]! > max[k]!) max[k] = p[k]!;
        }
      }
    }
    if (!Number.isFinite(min[0]!)) return notChecked('no geometry');
    const dims = [0, 1, 2].map((k) => Math.round((max[k]! - min[k]!) * 1_000_000) + 0) as [number, number, number];
    const measures = { bbox_um: dims };
    const box = ctx.options.boxUm;
    if (!box) return notChecked('no declared box (--box-um)', measures);
    const ratios = dims.map((d, k) => d / box[k]!);
    const hi = Math.max(...ratios), lo = Math.min(...ratios);
    const dev = lo <= 0 ? 1e12 : Math.min(1e12, Math.round((hi / lo - 1) * 1_000_000));
    const diagnostics =
      dev > THRESHOLDS.boxAspectPpm
        ? [makeDiagnostic('BBOX_CONFORMANCE', { pointer: sceneOrRoot(ctx.doc), message: `asset aspect deviates ${dev} ppm from the declared box; the limit is ${THRESHOLDS.boxAspectPpm} ppm`, evidence: { asset_um: dims, box_um: box, deviation_ppm: dev, tolerance_ppm: THRESHOLDS.boxAspectPpm } })]
        : [];
    return ran(diagnostics, { ...measures, box_aspect_deviation_ppm: dev });
  },

  hull_complexity(ctx) {
    const cap = THRESHOLDS.hullSourceTriangles;
    ctx.hullTooComplex = ctx.totalTriangles > cap;
    const diagnostics = ctx.hullTooComplex
      ? [makeDiagnostic('HULL_COMPLEXITY', { pointer: '/meshes', message: `${ctx.totalTriangles} triangles are too many to derive a collider from; simplify to at most ${cap} first`, evidence: { triangles: ctx.totalTriangles, cap } })]
      : [];
    return ran(diagnostics);
  },

  collider(ctx) {
    if (ctx.nonFinite) return notChecked('non-finite positions');
    if (ctx.hullTooComplex) return notChecked('source too complex (HULL_COMPLEXITY)', { collider: { kind: 'none' } });
    const pts: number[][] = [];
    for (const inst of ctx.model!.instances) {
      const m = meshOf(ctx, inst.meshIndex);
      const used = new Uint8Array(m.vertexCount);
      for (let i = 0; i < m.tris.length; i++) used[m.tris[i]!] = 1;
      for (let v = 0; v < m.vertexCount; v++) if (used[v]) pts.push(transformPoint(inst.world, m.pos[v * 3]!, m.pos[v * 3 + 1]!, m.pos[v * 3 + 2]!));
    }
    if (pts.length === 0) return notChecked('no geometry', { collider: { kind: 'none' } });
    // a canonical order, so the result does not depend on node order
    pts.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!);
    const P = new Float64Array(pts.length * 3);
    pts.forEach((p, i) => P.set(p, i * 3));
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, p[k]!); hi[k] = Math.max(hi[k]!, p[k]!); }
    const ext = [0, 1, 2].map((k) => hi[k]! - lo[k]!);
    const aabbVolume = ext[0]! * ext[1]! * ext[2]!;
    const umOf = (v: number) => Math.round(v * 1_000_000) + 0;
    const boxCollider = (why: string): CheckOutput =>
      ran([], { collider: { kind: 'box', reason: why, source_vertices: pts.length, extents_um: ext.map(umOf) } });
    const hull = convexHull(P);
    if (!hull || !(aabbVolume > 0)) return boxCollider('flat or degenerate source');

    const volPpm = Math.round((hull.volume / aabbVolume) * 1_000_000);
    const centre = [0, 1, 2].map((k) => (lo[k]! + hi[k]!) / 2);
    const radii = hull.vertices.map((v) => Math.hypot(P[v * 3]! - centre[0]!, P[v * 3 + 1]! - centre[1]!, P[v * 3 + 2]! - centre[2]!));
    const meanR = radii.reduce((x, y) => x + y, 0) / radii.length;
    const spread = Math.round(((Math.max(...radii) - Math.min(...radii)) / meanR) * 1_000_000);
    const base = { source_vertices: pts.length, hull_vertices_full: hull.vertices.length, bbox_fill_ppm: volPpm };
    // equal radii alone also describe a cube; a sphere must additionally fill pi/6 of its bounding box
    if (spread <= THRESHOLDS.sphereFitPpm && Math.abs(volPpm - SPHERE_FILL_PPM) <= THRESHOLDS.sphereFillTolPpm) return ran([], { collider: { kind: 'sphere', ...base, radius_um: umOf(meanR) } });
    if (volPpm >= THRESHOLDS.boxFitPpm) return ran([], { collider: { kind: 'box', ...base, extents_um: ext.map(umOf) } });
    const capped = capHull(P, hull, ctx.budgets.hullVertices);
    if (!capped) return boxCollider('hull could not be reduced to the vertex budget');
    return ran([], {
      collider: {
        kind: 'convex_hull',
        ...base,
        hull_vertices: capped.hull.vertices.length,
        hull_vertex_budget: ctx.budgets.hullVertices,
        volume_kept_ppm: Math.round((capped.hull.volume / hull.volume) * 1_000_000),
      },
    });
  },
};

export const CHECK_NEEDS_GEOMETRY: ReadonlySet<CheckId> = new Set(['degenerate', 'winding', 'boundary', 'nonmanifold', 'islands', 'bbox', 'collider']);
