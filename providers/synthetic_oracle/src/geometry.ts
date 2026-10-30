import type { Rng } from './prng.ts';

/** Flat arrays so large meshes stay cheap. Triangles are CCW seen from outside. */
export interface Geometry {
  pos: number[];
  uv: number[];
  idx: number[];
}

export const triCount = (g: Geometry): number => g.idx.length / 3;
export const vertCount = (g: Geometry): number => g.pos.length / 3;

const empty = (): Geometry => ({ pos: [], uv: [], idx: [] });

/** Signed volume by the divergence theorem. Positive when triangles face outward on a closed surface. */
export function signedVolume(g: Geometry): number {
  let v = 0;
  for (let t = 0; t < g.idx.length; t += 3) {
    const a = g.idx[t]! * 3;
    const b = g.idx[t + 1]! * 3;
    const c = g.idx[t + 2]! * 3;
    const ax = g.pos[a]!, ay = g.pos[a + 1]!, az = g.pos[a + 2]!;
    const bx = g.pos[b]!, by = g.pos[b + 1]!, bz = g.pos[b + 2]!;
    const cx = g.pos[c]!, cy = g.pos[c + 1]!, cz = g.pos[c + 2]!;
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

export function surfaceArea(g: Geometry): number {
  let s = 0;
  for (let t = 0; t < g.idx.length; t += 3) {
    const a = g.idx[t]! * 3, b = g.idx[t + 1]! * 3, c = g.idx[t + 2]! * 3;
    const ux = g.pos[b]! - g.pos[a]!, uy = g.pos[b + 1]! - g.pos[a + 1]!, uz = g.pos[b + 2]! - g.pos[a + 2]!;
    const vx = g.pos[c]! - g.pos[a]!, vy = g.pos[c + 1]! - g.pos[a + 1]!, vz = g.pos[c + 2]! - g.pos[a + 2]!;
    s += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return s;
}

export function bounds(g: Geometry): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = g.pos[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return { min, max };
}

export function flipAll(g: Geometry): Geometry {
  for (let t = 0; t < g.idx.length; t += 3) {
    const tmp = g.idx[t + 1]!;
    g.idx[t + 1] = g.idx[t + 2]!;
    g.idx[t + 2] = tmp;
  }
  return g;
}

/** Makes a closed surface face outward. */
export const orientOutward = (g: Geometry): Geometry => (signedVolume(g) < 0 ? flipAll(g) : g);

export function flipTriangles(g: Geometry, triangles: Iterable<number>): Geometry {
  for (const t of triangles) {
    const o = t * 3;
    const tmp = g.idx[o + 1]!;
    g.idx[o + 1] = g.idx[o + 2]!;
    g.idx[o + 2] = tmp;
  }
  return g;
}

/** Removes `count` consecutive triangles starting at `from`. */
export function dropTriangles(g: Geometry, from: number, count: number): Geometry {
  g.idx.splice(from * 3, count * 3);
  return g;
}

export function box(w: number, h: number, d: number): Geometry {
  const x = w / 2, y = h / 2, z = d / 2;
  const g = empty();
  const face = (corners: [number, number, number][], nx: number, ny: number, nz: number) => {
    const base = vertCount(g);
    const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
    corners.forEach((c, i) => {
      g.pos.push(c[0], c[1], c[2]);
      g.uv.push(uvs[i]![0]!, uvs[i]![1]!);
    });
    // choose the winding whose normal agrees with the outward direction
    const [p0, p1, p2] = corners as unknown as [number[], number[], number[]];
    const e1 = [p1![0]! - p0![0]!, p1![1]! - p0![1]!, p1![2]! - p0![2]!];
    const e2 = [p2![0]! - p0![0]!, p2![1]! - p0![1]!, p2![2]! - p0![2]!];
    const cx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    const cy = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    const cz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    if (cx * nx + cy * ny + cz * nz >= 0) g.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else g.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  face([[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]], 1, 0, 0);
  face([[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]], -1, 0, 0);
  face([[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]], 0, 1, 0);
  face([[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]], 0, -1, 0);
  face([[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]], 0, 0, 1);
  face([[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]], 0, 0, -1);
  return g;
}

/**
 * Solid of revolution about Y. `profile` is [radius, y] from bottom to top; a radius of 0 is a pole.
 * Each ring has `segs + 1` vertices (the seam is duplicated), so a weld is needed to see it as closed.
 */
export function lathe(profile: [number, number][], segs: number): Geometry {
  const g = empty();
  const n = profile.length;
  for (let k = 0; k < n; k++) {
    const [r, y] = profile[k]!;
    for (let j = 0; j <= segs; j++) {
      const th = (2 * Math.PI * j) / segs;
      const c = j === segs ? 1 : Math.cos(th);
      const s = j === segs ? 0 : Math.sin(th);
      g.pos.push(r * c, y, r * s);
      g.uv.push(j / segs, k / (n - 1));
    }
  }
  const at = (k: number, j: number) => k * (segs + 1) + j;
  for (let k = 0; k < n - 1; k++) {
    const aPole = profile[k]![0] === 0;
    const bPole = profile[k + 1]![0] === 0;
    for (let j = 0; j < segs; j++) {
      const A0 = at(k, j), A1 = at(k, j + 1), B0 = at(k + 1, j), B1 = at(k + 1, j + 1);
      if (!aPole) g.idx.push(A0, B0, A1);
      if (!bPole) g.idx.push(A1, B0, B1);
    }
  }
  return orientOutward(g);
}

const polish = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);

export function sphereProfile(radius: number, rings: number): [number, number][] {
  const p: [number, number][] = [];
  for (let k = 0; k <= rings; k++) {
    const phi = (Math.PI * k) / rings;
    const r = k === 0 || k === rings ? 0 : radius * Math.sin(phi);
    p.push([r, polish(-radius * Math.cos(phi))]);
  }
  return p;
}

export const sphere = (radius: number, rings: number, segs: number): Geometry => lathe(sphereProfile(radius, rings), segs);

export function cylinder(radius: number, height: number, sideRings: number, segs: number): Geometry {
  const p: [number, number][] = [[0, -height / 2], [radius, -height / 2]];
  for (let k = 1; k < sideRings; k++) p.push([radius, -height / 2 + (height * k) / sideRings]);
  p.push([radius, height / 2], [0, height / 2]);
  return lathe(p, segs);
}

export function capsule(radius: number, bodyHeight: number, capRings: number, segs: number): Geometry {
  const p: [number, number][] = [];
  for (let k = 0; k <= capRings; k++) {
    const phi = (Math.PI / 2) * (k / capRings);
    p.push([k === 0 ? 0 : radius * Math.sin(phi), -bodyHeight / 2 - radius * Math.cos(phi)]);
  }
  for (let k = capRings; k >= 0; k--) {
    const phi = (Math.PI / 2) * (k / capRings);
    p.push([k === 0 ? 0 : radius * Math.sin(phi), bodyHeight / 2 + radius * Math.cos(phi)]);
  }
  return lathe(p, segs);
}

export function cone(radius: number, height: number, sideRings: number, segs: number): Geometry {
  const p: [number, number][] = [[0, -height / 2], [radius, -height / 2]];
  for (let k = 1; k < sideRings; k++) p.push([radius * (1 - k / sideRings), -height / 2 + (height * k) / sideRings]);
  p.push([0, height / 2]);
  return lathe(p, segs);
}

export function vase(radius: number, height: number, rings: number, segs: number): Geometry {
  const p: [number, number][] = [[0, -height / 2]];
  for (let k = 1; k < rings; k++) {
    const t = k / rings;
    const r = radius * (0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.7) * (t > 0.82 ? 0.55 + (1 - t) * 2.5 : 1);
    p.push([Math.max(r, radius * 0.1), -height / 2 + height * t]);
  }
  p.push([0, height / 2]);
  return lathe(p, segs);
}

export function torus(major: number, minor: number, segs: number, tubeSegs: number): Geometry {
  const g = empty();
  for (let i = 0; i <= segs; i++) {
    for (let j = 0; j <= tubeSegs; j++) {
      const u = i === segs ? 0 : (2 * Math.PI * i) / segs;
      const v = j === tubeSegs ? 0 : (2 * Math.PI * j) / tubeSegs;
      g.pos.push((major + minor * Math.cos(v)) * Math.cos(u), minor * Math.sin(v), (major + minor * Math.cos(v)) * Math.sin(u));
      g.uv.push(i / segs, j / tubeSegs);
    }
  }
  const at = (i: number, j: number) => i * (tubeSegs + 1) + j;
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < tubeSegs; j++) {
      g.idx.push(at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  return orientOutward(g);
}

/** Smooth radial displacement as a function of direction, so seam and pole vertices stay coincident. */
export function roughen(g: Geometry, rng: Rng, amplitude: number): Geometry {
  const terms = Array.from({ length: 4 }, () => ({
    kx: rng.float() * 6 - 3, ky: rng.float() * 6 - 3, kz: rng.float() * 6 - 3,
    ph: rng.float() * 6.28, a: 0.5 + rng.float(),
  }));
  const norm = terms.reduce((s, t) => s + t.a, 0);
  for (let i = 0; i < g.pos.length; i += 3) {
    const x = g.pos[i]!, y = g.pos[i + 1]!, z = g.pos[i + 2]!;
    const len = Math.hypot(x, y, z) || 1;
    const dx = x / len, dy = y / len, dz = z / len;
    let n = 0;
    for (const t of terms) n += t.a * Math.sin(t.kx * dx + t.ky * dy + t.kz * dz + t.ph);
    const f = 1 + (amplitude * n) / norm;
    g.pos[i] = x * f;
    g.pos[i + 1] = y * f;
    g.pos[i + 2] = z * f;
  }
  return g;
}

export function transform(g: Geometry, scale: [number, number, number], translate: [number, number, number]): Geometry {
  for (let i = 0; i < g.pos.length; i += 3) {
    g.pos[i] = g.pos[i]! * scale[0] + translate[0];
    g.pos[i + 1] = g.pos[i + 1]! * scale[1] + translate[1];
    g.pos[i + 2] = g.pos[i + 2]! * scale[2] + translate[2];
  }
  return g;
}

export function merge(parts: Geometry[]): Geometry {
  const out = empty();
  for (const p of parts) {
    const base = vertCount(out);
    out.pos.push(...p.pos);
    out.uv.push(...p.uv);
    for (const i of p.idx) out.idx.push(i + base);
  }
  return out;
}

export function tetrahedron(size: number): Geometry {
  const s = size;
  const g: Geometry = {
    pos: [s, s, s, -s, -s, s, -s, s, -s, s, -s, -s],
    uv: [0, 0, 1, 0, 1, 1, 0, 1],
    idx: [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2],
  };
  return orientOutward(g);
}

/** Resolution of a lathe sphere for roughly `target` triangles: tris = 4 * (rings - 1)^2 when segs = 2 * rings. */
export function sphereResolution(target: number): { rings: number; segs: number } {
  const rings = Math.max(3, Math.round(Math.sqrt(target / 4)) + 1);
  return { rings, segs: 2 * (rings - 1) };
}

/** A copy that keeps only the vertices its triangles use. */
export function compact(g: Geometry): Geometry {
  const map = new Map<number, number>();
  const out: Geometry = { pos: [], uv: [], idx: [] };
  for (const i of g.idx) {
    let m = map.get(i);
    if (m === undefined) {
      m = out.pos.length / 3;
      map.set(i, m);
      out.pos.push(g.pos[i * 3]!, g.pos[i * 3 + 1]!, g.pos[i * 3 + 2]!);
      out.uv.push(g.uv[i * 2]!, g.uv[i * 2 + 1]!);
    }
    out.idx.push(m);
  }
  return out;
}

/** Splits triangles into `bands` consecutive groups (a lathe's triangles are ordered ring by ring). */
export function splitConsecutive(g: Geometry, bands: number): Geometry[] {
  const total = triCount(g);
  const out: Geometry[] = [];
  for (let b = 0; b < bands; b++) {
    const from = Math.floor((total * b) / bands);
    const to = Math.floor((total * (b + 1)) / bands);
    out.push(compact({ pos: g.pos, uv: g.uv, idx: g.idx.slice(from * 3, to * 3) }));
  }
  return out;
}
