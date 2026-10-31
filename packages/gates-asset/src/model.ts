import { Document, NodeIO, type Accessor, type Mesh, type Node, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { THRESHOLDS } from './budgets.ts';

export interface Instance {
  node: Node;
  mesh: Mesh;
  meshIndex: number;
  /** Column-major world matrix. */
  world: number[];
}

export interface MeshModel {
  index: number;
  /** Welded vertex ids, three per triangle, over all primitives. Triangles touching non-finite vertices are skipped. */
  tris: Int32Array;
  /** For each kept triangle, its position in its primitive's own triangle sequence (skipped triangles still count). */
  triOrdinal: Int32Array;
  /** First triangle of each primitive, so a triangle can be traced to its primitive. */
  primStart: number[];
  /** Welded vertex positions in mesh-local space (xyz). */
  pos: Float64Array;
  vertexCount: number;
}

export interface AssetModel {
  doc: Document;
  meshes: Mesh[];
  instances: Instance[];
}

/** A reader and writer for the extensions this gate understands. Meshopt can be read, not written. */
export async function makeIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
}

export async function parseGlb(bytes: Uint8Array): Promise<Document> {
  return (await makeIO()).readBinary(bytes);
}

export function buildAssetModel(doc: Document): AssetModel {
  const root = doc.getRoot();
  const meshes = root.listMeshes();
  const meshIndex = new Map(meshes.map((m, i) => [m, i]));
  const seen = new Set<Node>();
  const nodes: Node[] = [];
  const visit = (n: Node) => {
    if (!seen.has(n)) {
      seen.add(n);
      nodes.push(n);
    }
  };
  const scenes = root.listScenes();
  if (scenes.length) for (const s of scenes) s.traverse(visit);
  else root.listNodes().forEach(visit);
  const instances: Instance[] = [];
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (mesh) instances.push({ node, mesh, meshIndex: meshIndex.get(mesh)!, world: node.getWorldMatrix() as number[] });
  }
  return { doc, meshes, instances };
}

/** Number of triangles a primitive draws, from its mode and index (or vertex) count. */
export function rawTriangleCount(prim: Primitive): number {
  const idx = prim.getIndices();
  const posAcc = prim.getAttribute('POSITION');
  const count = idx ? idx.getCount() : (posAcc?.getCount() ?? 0);
  switch (prim.getMode()) {
    case 4:
      return Math.floor(count / 3);
    case 5:
    case 6:
      return Math.max(0, count - 2);
    default:
      return 0;
  }
}

export function readPositions(acc: Accessor): ArrayLike<number> {
  if (acc.getType() !== 'VEC3') throw new Error('POSITION accessor is not VEC3');
  const arr = acc.getArray();
  if (arr instanceof Float32Array || arr instanceof Float64Array) return arr;
  const out = new Float64Array(acc.getCount() * 3);
  const tmp: number[] = [0, 0, 0];
  for (let i = 0; i < acc.getCount(); i++) {
    acc.getElement(i, tmp);
    out[i * 3] = tmp[0]!;
    out[i * 3 + 1] = tmp[1]!;
    out[i * 3 + 2] = tmp[2]!;
  }
  return out;
}

function* triangleIndices(prim: Primitive): Generator<[number, number, number]> {
  const idx = prim.getIndices();
  const posAcc = prim.getAttribute('POSITION');
  const arr = idx ? idx.getArray()! : null;
  const count = idx ? idx.getCount() : (posAcc?.getCount() ?? 0);
  const at = (i: number) => (arr ? (arr[i] as number) : i);
  switch (prim.getMode()) {
    case 4:
      for (let i = 0; i + 2 < count; i += 3) yield [at(i), at(i + 1), at(i + 2)];
      break;
    case 5:
      for (let i = 0; i + 2 < count; i++) yield i % 2 === 0 ? [at(i), at(i + 1), at(i + 2)] : [at(i + 1), at(i), at(i + 2)];
      break;
    case 6:
      for (let i = 1; i + 1 < count; i++) yield [at(0), at(i), at(i + 1)];
      break;
    default:
      break;
  }
}

export function buildMeshModel(mesh: Mesh, index: number): MeshModel {
  const ids = new Map<string, number>();
  const pos: number[] = [];
  const tris: number[] = [];
  const ords: number[] = [];
  const primStart: number[] = [];
  const grid = 1_000_000 / THRESHOLDS.weldUm;
  for (const prim of mesh.listPrimitives()) {
    primStart.push(tris.length / 3);
    const posAcc = prim.getAttribute('POSITION');
    if (!posAcc) continue;
    const P = readPositions(posAcc);
    const n = posAcc.getCount();
    const map = new Int32Array(n).fill(-1);
    const weldOf = (v: number): number => {
      const cached = map[v]!;
      if (cached !== -1) return cached;
      const x = P[v * 3]!, y = P[v * 3 + 1]!, z = P[v * 3 + 2]!;
      let id: number;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) id = -2;
      else {
        const key = `${Math.round(x * grid)},${Math.round(y * grid)},${Math.round(z * grid)}`;
        const found = ids.get(key);
        if (found === undefined) {
          id = pos.length / 3;
          ids.set(key, id);
          pos.push(x, y, z);
        } else id = found;
      }
      map[v] = id;
      return id;
    };
    let ordinal = -1;
    for (const [a, b, c] of triangleIndices(prim)) {
      ordinal++;
      if (a >= n || b >= n || c >= n) continue;
      const wa = weldOf(a), wb = weldOf(b), wc = weldOf(c);
      if (wa < 0 || wb < 0 || wc < 0) continue;
      tris.push(wa, wb, wc);
      ords.push(ordinal);
    }
  }
  return { index, tris: Int32Array.from(tris), triOrdinal: Int32Array.from(ords), primStart, pos: Float64Array.from(pos), vertexCount: pos.length / 3 };
}

/**
 * The one definition of a degenerate triangle: two welded corners coincide, or its area is at or below the
 * threshold. The gate and the autofix both use it, so the fix removes exactly what the check counted.
 */
export function triangleIsDegenerate(m: MeshModel, t: number): boolean {
  const a = m.tris[t * 3]!, b = m.tris[t * 3 + 1]!, c = m.tris[t * 3 + 2]!;
  if (a === b || b === c || a === c) return true;
  return triangleAreaM2(m, t) * 1e12 <= THRESHOLDS.degenerateAreaUm2;
}

export function triangleAreaM2(m: MeshModel, t: number): number {
  const a = m.tris[t * 3]!, b = m.tris[t * 3 + 1]!, c = m.tris[t * 3 + 2]!;
  const ux = m.pos[b * 3]! - m.pos[a * 3]!, uy = m.pos[b * 3 + 1]! - m.pos[a * 3 + 1]!, uz = m.pos[b * 3 + 2]! - m.pos[a * 3 + 2]!;
  const vx = m.pos[c * 3]! - m.pos[a * 3]!, vy = m.pos[c * 3 + 1]! - m.pos[a * 3 + 1]!, vz = m.pos[c * 3 + 2]! - m.pos[a * 3 + 2]!;
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

export function primitiveOfTriangle(m: MeshModel, t: number): number {
  let p = 0;
  for (let i = 0; i < m.primStart.length; i++) if (m.primStart[i]! <= t) p = i;
  return p;
}

export const det3 = (w: number[]): number =>
  w[0]! * (w[5]! * w[10]! - w[9]! * w[6]!) - w[4]! * (w[1]! * w[10]! - w[9]! * w[2]!) + w[8]! * (w[1]! * w[6]! - w[5]! * w[2]!);

export function transformPoint(w: number[], x: number, y: number, z: number): [number, number, number] {
  return [
    w[0]! * x + w[4]! * y + w[8]! * z + w[12]!,
    w[1]! * x + w[5]! * y + w[9]! * z + w[13]!,
    w[2]! * x + w[6]! * y + w[10]! * z + w[14]!,
  ];
}
