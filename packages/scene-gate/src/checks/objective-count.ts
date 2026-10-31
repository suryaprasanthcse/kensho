import { diag, pointerFrom, type Diagnostic } from '../diagnostic.ts';
import { isCollectible } from '../geometry.ts';
import type { Scene } from '../schema.ts';

/** OBJECTIVE_COUNT: a collect objective needs more collectible (pickup or key) entities with its tag than exist. */
export function checkObjectiveCount(scene: Scene): Diagnostic[] {
  const out: Diagnostic[] = [];
  scene.objectives.forEach((o, i) => {
    if (o.type !== 'collect') return;
    const available = scene.entities.filter((e) => isCollectible(e) && (e.tags ?? []).includes(o.tag)).length;
    if (o.count > available) {
      out.push(
        diag(
          'OBJECTIVE_COUNT',
          pointerFrom('objectives', i, 'count'),
          `objective ${o.id} needs ${o.count} "${o.tag}" entities but the scene has ${available}`,
          { tag: o.tag, needed: o.count, available },
        ),
      );
    }
  });
  return out;
}
