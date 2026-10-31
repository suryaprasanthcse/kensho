import { diag, pointerFrom, type Diagnostic } from '../diagnostic.ts';
import { boundsBox, boxOf, playerBox, type Box2 } from '../geometry.ts';
import type { Scene } from '../schema.ts';

const AXES = ['x', 'y', 'z'] as const;

const escapes = (box: Box2, bounds: Box2): string[] =>
  AXES.filter((_, a) => box[a]! < bounds[a]! || box[a + 3]! > bounds[a + 3]!);

/** OUT_OF_BOUNDS: any entity box, or the player box at spawn, extends outside bounds_mm. Touching the bounds is inside. */
export function checkOutOfBounds(scene: Scene): Diagnostic[] {
  const bounds = boundsBox(scene);
  const out: Diagnostic[] = [];
  scene.entities.forEach((e, i) => {
    const axes = escapes(boxOf(e), bounds);
    if (axes.length) {
      out.push(diag('OUT_OF_BOUNDS', pointerFrom('entities', i, 'pos_mm'), `${e.id} extends outside bounds_mm on ${axes.join(', ')}`, { id: e.id, axes }));
    }
  });
  const axes = escapes(playerBox(scene), bounds);
  if (axes.length) {
    out.push(diag('OUT_OF_BOUNDS', pointerFrom('spawn', 'pos_mm'), `the player box at spawn extends outside bounds_mm on ${axes.join(', ')}`, { id: 'spawn', axes }));
  }
  return out;
}
