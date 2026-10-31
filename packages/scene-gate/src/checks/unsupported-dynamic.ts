import { diag, pointerFrom, type Diagnostic } from '../diagnostic.ts';
import { boxOf, isSolid, overlapOn } from '../geometry.ts';
import type { Scene } from '../schema.ts';
import { HALF, OVERLAP_TOLERANCE_MM, SUPPORT_TOLERANCE_MM } from '../thresholds.ts';

/**
 * UNSUPPORTED_DYNAMIC: a dynamic box's bottom is more than 20 mm above the highest support under its footprint.
 * Supports are the ground (y = 0) and the tops of other solids whose footprint overlaps by more than 5 mm in x and z
 * and whose top is not above the box's bottom by more than the 5 mm overlap tolerance (a solid that reaches higher
 * is overlapping the box, not supporting it).
 */
export function checkUnsupportedDynamic(scene: Scene): Diagnostic[] {
  const out: Diagnostic[] = [];
  scene.entities.forEach((e, i) => {
    if (e.kind !== 'dynamic') return;
    const box = boxOf(e);
    const bottom = box[1];
    let support = 0;
    let supportId = 'ground';
    scene.entities.forEach((s, j) => {
      if (j === i || !isSolid(s)) return;
      const sb = boxOf(s);
      if (overlapOn(box, sb, 0) <= HALF * OVERLAP_TOLERANCE_MM || overlapOn(box, sb, 2) <= HALF * OVERLAP_TOLERANCE_MM) return;
      const top = sb[4];
      if (top <= bottom + HALF * OVERLAP_TOLERANCE_MM && top > support) {
        support = top;
        supportId = s.id;
      }
    });
    const gap = bottom - support;
    if (gap > HALF * SUPPORT_TOLERANCE_MM) {
      out.push(
        diag('UNSUPPORTED_DYNAMIC', pointerFrom('entities', i, 'pos_mm'), `${e.id} floats above its support (${supportId})`, {
          id: e.id,
          support: supportId,
          gap_half_mm: gap,
        }),
      );
    }
  });
  return out;
}
