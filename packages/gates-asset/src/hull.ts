/** A 3D convex hull (quickhull with conflict lists) over a flat xyz array. */

export interface Hull {
  /** Indices into the input points, one per hull vertex, ascending. */
  vertices: number[];
  /** Triangles as index triples into the input points, outward-facing. */
  faces: [number, number, number][];
  volume: number;
}

interface Face {
  v: [number, number, number];
  nx: number;
  ny: number;
  nz: number;
  d: number;
  adj: [number, number, number];
  out: number[];
  alive: boolean;
  mark: number;
}

/** Returns null when the points are (nearly) collinear or coplanar. */
export function convexHull(P: ArrayLike<number>): Hull | null {
  const n = P.length / 3;
  if (n < 4) return null;
  // scale-aware tolerance
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3]!, y = P[i * 3 + 1]!, z = P[i * 3 + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!(extent > 0)) return null;
  const eps = extent * 1e-7;

  // initial simplex from axis extremes
  const ext: number[] = [];
  const argBy = (axis: number, sign: number) => {
    let best = 0, bv = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = sign * P[i * 3 + axis]!;
      if (v > bv) { bv = v; best = i; }
    }
    return best;
  };
  for (let a = 0; a < 3; a++) ext.push(argBy(a, -1), argBy(a, 1));
  let i0 = ext[0]!, i1 = ext[1]!, bestD = -1;
  for (const a of ext) for (const b of ext) {
    const dd = dist2(P, a, b);
    if (dd > bestD) { bestD = dd; i0 = a; i1 = b; }
  }
  if (bestD <= eps * eps) return null;
  let i2 = -1, bd2 = -1;
  for (let i = 0; i < n; i++) {
    const d = distToLine2(P, i, i0, i1);
    if (d > bd2) { bd2 = d; i2 = i; }
  }
  if (i2 < 0 || Math.sqrt(bd2) <= eps) return null;
  const nrm = cross3(sub(P, i1, i0), sub(P, i2, i0));
  const nl = Math.hypot(nrm[0], nrm[1], nrm[2]);
  let i3 = -1, bd3 = -1;
  for (let i = 0; i < n; i++) {
    const d = Math.abs((dot3(nrm, sub(P, i, i0))) / nl);
    if (d > bd3) { bd3 = d; i3 = i; }
  }
  if (i3 < 0 || bd3 <= eps) return null;

  const faces: Face[] = [];
  const centre = [0, 1, 2].map((k) => (P[i0 * 3 + k]! + P[i1 * 3 + k]! + P[i2 * 3 + k]! + P[i3 * 3 + k]!) / 4) as [number, number, number];
  const addFace = (a: number, b: number, c: number): Face => {
    const nrm2 = cross3(sub(P, b, a), sub(P, c, a));
    const l = Math.hypot(nrm2[0], nrm2[1], nrm2[2]) || 1;
    const f: Face = { v: [a, b, c], nx: nrm2[0] / l, ny: nrm2[1] / l, nz: nrm2[2] / l, d: 0, adj: [-1, -1, -1], out: [], alive: true, mark: 0 };
    f.d = f.nx * P[a * 3]! + f.ny * P[a * 3 + 1]! + f.nz * P[a * 3 + 2]!;
    faces.push(f);
    return f;
  };
  const oriented = (a: number, b: number, c: number) => {
    const f = addFace(a, b, c);
    if (f.nx * centre[0] + f.ny * centre[1] + f.nz * centre[2] - f.d > 0) {
      faces.pop();
      return addFace(a, c, b);
    }
    return f;
  };
  oriented(i0, i1, i2);
  oriented(i0, i1, i3);
  oriented(i0, i2, i3);
  oriented(i1, i2, i3);
  // link the simplex by matching reversed directed edges
  for (let f = 0; f < 4; f++) for (let e = 0; e < 3; e++) {
    const u = faces[f]!.v[e]!, v = faces[f]!.v[(e + 1) % 3]!;
    for (let g = 0; g < 4; g++) {
      if (g === f) continue;
      for (let h = 0; h < 3; h++) {
        if (faces[g]!.v[h] === v && faces[g]!.v[(h + 1) % 3] === u) faces[f]!.adj[e] = g;
      }
    }
  }

  const signedDist = (f: Face, q: number) => f.nx * P[q * 3]! + f.ny * P[q * 3 + 1]! + f.nz * P[q * 3 + 2]! - f.d;
  const simplex = new Set([i0, i1, i2, i3]);
  for (let q = 0; q < n; q++) {
    if (simplex.has(q)) continue;
    for (let f = 0; f < 4; f++) {
      if (signedDist(faces[f]!, q) > eps) { faces[f]!.out.push(q); break; }
    }
  }

  const stack: number[] = [0, 1, 2, 3];
  let stamp = 0;
  while (stack.length) {
    const fi = stack.pop()!;
    const f = faces[fi]!;
    if (!f.alive || f.out.length === 0) continue;
    let p = -1, pd = -Infinity;
    for (const q of f.out) {
      const dd = signedDist(f, q);
      if (dd > pd) { pd = dd; p = q; }
    }
    stamp++;
    const visible: number[] = [fi];
    f.mark = stamp;
    for (let s = 0; s < visible.length; s++) {
      const g = faces[visible[s]!]!;
      for (let e = 0; e < 3; e++) {
        const hi = g.adj[e]!;
        const h = faces[hi]!;
        if (h.mark !== stamp && signedDist(h, p) > eps) {
          h.mark = stamp;
          visible.push(hi);
        }
      }
    }
    // horizon: directed edges of visible faces whose neighbour is not visible
    const created: number[] = [];
    const byStart = new Map<number, number>();
    for (const gi of visible) {
      const g = faces[gi]!;
      for (let e = 0; e < 3; e++) {
        const hi = g.adj[e]!;
        const h = faces[hi]!;
        if (h.mark === stamp) continue;
        const u = g.v[e]!, v = g.v[(e + 1) % 3]!;
        const nf = addFace(u, v, p);
        const ni = faces.length - 1;
        nf.adj[0] = hi;
        for (let k = 0; k < 3; k++) if (h.v[k] === v && h.v[(k + 1) % 3] === u) h.adj[k] = ni;
        created.push(ni);
        byStart.set(u, ni);
      }
    }
    for (const ni of created) {
      const nf = faces[ni]!;
      const next = byStart.get(nf.v[1]!);
      if (next === undefined) return null; // non-closed horizon: numerically degenerate
      nf.adj[1] = next;
      faces[next]!.adj[2] = ni;
    }
    for (const gi of visible) {
      const g = faces[gi]!;
      for (const q of g.out) {
        if (q === p) continue;
        for (const ni of created) {
          if (signedDist(faces[ni]!, q) > eps) { faces[ni]!.out.push(q); break; }
        }
      }
      g.alive = false;
      g.out = [];
    }
    for (const ni of created) if (faces[ni]!.out.length) stack.push(ni);
  }

  const vset = new Set<number>();
  const fl: [number, number, number][] = [];
  let volume = 0;
  const o = i0;
  for (const f of faces) {
    if (!f.alive) continue;
    fl.push([f.v[0], f.v[1], f.v[2]]);
    for (const v of f.v) vset.add(v);
    const a = sub(P, f.v[0], o), b = sub(P, f.v[1], o), c = sub(P, f.v[2], o);
    volume += dot3(a, cross3(b, c)) / 6;
  }
  return { vertices: [...vset].sort((a, b) => a - b), faces: fl, volume: Math.abs(volume) };
}

type V3 = [number, number, number];
const sub = (P: ArrayLike<number>, a: number, b: number): V3 => [P[a * 3]! - P[b * 3]!, P[a * 3 + 1]! - P[b * 3 + 1]!, P[a * 3 + 2]! - P[b * 3 + 2]!];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist2 = (P: ArrayLike<number>, a: number, b: number) => {
  const d = sub(P, a, b);
  return d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
};
function distToLine2(P: ArrayLike<number>, p: number, a: number, b: number): number {
  const ab = sub(P, b, a), ap = sub(P, p, a);
  const c = cross3(ab, ap);
  const l2 = dot3(ab, ab);
  return l2 === 0 ? 0 : dot3(c, c) / l2;
}

/** Deterministic unit directions spread over the sphere (Fibonacci lattice). */
export function fibonacciDirections(count: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let k = 0; k < count; k++) {
    const y = 1 - (2 * (k + 0.5)) / count;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = k * golden;
    out.push([Math.cos(phi) * r, y, Math.sin(phi) * r]);
  }
  return out;
}

/**
 * Reduces a hull to at most `cap` vertices: the support vertex in each of `cap` directions, re-hulled.
 * Returns the points actually used and the new hull; null if no valid reduced hull exists.
 */
export function capHull(P: ArrayLike<number>, hull: Hull, cap: number): { hull: Hull; points: number[] } | null {
  if (hull.vertices.length <= cap) return { hull, points: hull.vertices };
  let dirsCount = cap;
  while (dirsCount >= 8) {
    const chosen = new Set<number>();
    for (const [dx, dy, dz] of fibonacciDirections(dirsCount)) {
      let best = -1, bv = -Infinity;
      for (const v of hull.vertices) {
        const s = P[v * 3]! * dx + P[v * 3 + 1]! * dy + P[v * 3 + 2]! * dz;
        if (s > bv) { bv = s; best = v; }
      }
      chosen.add(best);
    }
    const idx = [...chosen].sort((a, b) => a - b);
    const sub3 = new Float64Array(idx.length * 3);
    idx.forEach((v, i) => {
      sub3[i * 3] = P[v * 3]!;
      sub3[i * 3 + 1] = P[v * 3 + 1]!;
      sub3[i * 3 + 2] = P[v * 3 + 2]!;
    });
    const h = convexHull(sub3);
    if (h && h.vertices.length <= cap) {
      return { hull: { vertices: h.vertices.map((i) => idx[i]!), faces: h.faces.map((f) => f.map((i) => idx[i]!) as [number, number, number]), volume: h.volume }, points: h.vertices.map((i) => idx[i]!) };
    }
    dirsCount = Math.floor(dirsCount * 0.85);
  }
  return null;
}
