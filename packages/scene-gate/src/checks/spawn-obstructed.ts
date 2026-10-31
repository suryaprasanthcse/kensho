import { diag, pointerFrom, type Diagnostic } from '../diagnostic.ts';
import { boxOf, isSolid, overlap3, playerBox } from '../geometry.ts';
import type { Scene } from '../schema.ts';
import { HALF, OVERLAP_TOLERANCE_MM } from '../thresholds.ts';

/** SPAWN_OBSTRUCTED: the player box (2r x height x 2r, feet at spawn) overlaps a solid by more than 5 mm on every axis. */
export function checkSpawnObstructed(scene: Scene): Diagnostic[] {
  const player = playerBox(scene);
  const out: Diagnostic[] = [];
  for (const e of scene.entities) {
    if (!isSolid(e)) continue;
    const o = overlap3(player, boxOf(e));
    if (o.every((v) => v > HALF * OVERLAP_TOLERANCE_MM)) {
      out.push(diag('SPAWN_OBSTRUCTED', pointerFrom('spawn', 'pos_mm'), `the player box at spawn overlaps ${e.id}`, { with: e.id, overlap_half_mm: o }));
    }
  }
  return out;
}
