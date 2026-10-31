import { diag, pointerFrom, type Diagnostic } from '../diagnostic.ts';
import { boxOf, isSolid, overlap3, type Box2 } from '../geometry.ts';
import type { Scene } from '../schema.ts';
import { HALF, OVERLAP_TOLERANCE_MM } from '../thresholds.ts';

/**
 * SPATIAL_OVERLAP: two solids overlap by more than 5 mm on every axis. A door may overlap statics. The later entity's
 * pos_mm is reported. The implicit ground is not an entity, so it is not part of this check.
 */
export function checkSpatialOverlap(scene: Scene): Diagnostic[] {
  const out: Diagnostic[] = [];
  const solids: { i: number; box: Box2 }[] = [];
  scene.entities.forEach((e, i) => {
    if (isSolid(e)) solids.push({ i, box: boxOf(e) });
  });
  for (let a = 0; a < solids.length; a++) {
    for (let b = a + 1; b < solids.length; b++) {
      const ea = scene.entities[solids[a]!.i]!;
      const eb = scene.entities[solids[b]!.i]!;
      if ((ea.kind === 'door' && eb.kind === 'static') || (ea.kind === 'static' && eb.kind === 'door')) continue;
      const o = overlap3(solids[a]!.box, solids[b]!.box);
      if (o.every((v) => v > HALF * OVERLAP_TOLERANCE_MM)) {
        out.push(
          diag('SPATIAL_OVERLAP', pointerFrom('entities', solids[b]!.i, 'pos_mm'), `${eb.id} overlaps ${ea.id}`, {
            a: ea.id,
            b: eb.id,
            overlap_half_mm: o,
          }),
        );
      }
    }
  }
  return out;
}
