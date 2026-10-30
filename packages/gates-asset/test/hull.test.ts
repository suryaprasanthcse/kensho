import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { capHull, convexHull, fibonacciDirections } from '../src/hull.ts';

const cube = (): number[] => {
  const p: number[] = [];
  for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) p.push(x, y, z);
  return p;
};

describe('convex hull', () => {
  it('finds the 8 vertices and unit volume of a cube, ignoring interior points', () => {
    const pts = [...cube(), 0.5, 0.5, 0.5, 0.2, 0.7, 0.1];
    const h = convexHull(pts)!;
    expect(h.vertices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(h.volume).toBeCloseTo(1, 9);
  });

  it('returns null for coplanar and collinear input', () => {
    expect(convexHull([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0.5, 0.5, 0])).toBeNull();
    expect(convexHull([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3])).toBeNull();
  });

  it('property: every input point lies inside or on every face of the hull', () => {
    const pointArb = fc.array(fc.tuple(fc.integer({ min: -50, max: 50 }), fc.integer({ min: -50, max: 50 }), fc.integer({ min: -50, max: 50 })), { minLength: 8, maxLength: 60 });
    fc.assert(
      fc.property(pointArb, (pts) => {
        const flat = pts.flat();
        const h = convexHull(flat);
        if (!h) return;
        for (const [a, b, c] of h.faces) {
          const A = flat.slice(a * 3, a * 3 + 3), B = flat.slice(b * 3, b * 3 + 3), C = flat.slice(c * 3, c * 3 + 3);
          const n = [(B[1]! - A[1]!) * (C[2]! - A[2]!) - (B[2]! - A[2]!) * (C[1]! - A[1]!), (B[2]! - A[2]!) * (C[0]! - A[0]!) - (B[0]! - A[0]!) * (C[2]! - A[2]!), (B[0]! - A[0]!) * (C[1]! - A[1]!) - (B[1]! - A[1]!) * (C[0]! - A[0]!)];
          const len = Math.hypot(n[0]!, n[1]!, n[2]!);
          for (let i = 0; i < pts.length; i++) {
            const d = ((flat[i * 3]! - A[0]!) * n[0]! + (flat[i * 3 + 1]! - A[1]!) * n[1]! + (flat[i * 3 + 2]! - A[2]!) * n[2]!) / len;
            expect(d).toBeLessThanOrEqual(1e-6);
          }
        }
        expect(h.volume).toBeGreaterThan(0);
      }),
      { numRuns: 80 },
    );
  });

  it('caps the vertex count and returns a subset of the original vertices', () => {
    const pts: number[] = [];
    const n = 400;
    for (let k = 0; k < n; k++) {
      const y = 1 - (2 * (k + 0.5)) / n, r = Math.sqrt(1 - y * y), phi = k * 2.399963;
      pts.push(Math.cos(phi) * r, y, Math.sin(phi) * r);
    }
    const full = convexHull(pts)!;
    expect(full.vertices.length).toBeGreaterThan(64);
    const capped = capHull(pts, full, 64)!;
    expect(capped.hull.vertices.length).toBeLessThanOrEqual(64);
    for (const v of capped.hull.vertices) expect(full.vertices).toContain(v);
    expect(capped.hull.volume).toBeLessThanOrEqual(full.volume);
    expect(capped.hull.volume / full.volume).toBeGreaterThan(0.8);
  });

  it('spreads directions deterministically over the sphere', () => {
    const d = fibonacciDirections(16);
    expect(d).toEqual(fibonacciDirections(16));
    for (const [x, y, z] of d) expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
  });
});
