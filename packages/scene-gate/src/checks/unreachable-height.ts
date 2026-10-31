import { diag, pointerFrom, type Diagnostic } from '../diagnostic.ts';
import { boxOf, indexById, isCollectible, isSolid } from '../geometry.ts';
import type { Scene } from '../schema.ts';
import { HALF, STEP_RADIUS_MM } from '../thresholds.ts';

/**
 * UNREACHABLE_HEIGHT (optional): a needed item sits more than jump_height_mm above the ground and above every solid
 * top within 1.5 m horizontally. Needed items are collectibles whose tag a collect objective asks for, reach targets,
 * unlock targets, and keys that some door requires. Height is the item's bottom face; a step is a solid top that is not
 * above the item's top; distance runs from the item's centre to the step's footprint.
 */
export function checkUnreachableHeight(scene: Scene): Diagnostic[] {
  const byId = indexById(scene);
  const needed = new Set<number>();
  const wantedTags = new Set(scene.objectives.flatMap((o) => (o.type === 'collect' ? [o.tag] : [])));
  scene.entities.forEach((e, i) => {
    if (isCollectible(e) && (e.tags ?? []).some((t) => wantedTags.has(t))) needed.add(i);
    if (e.kind === 'door') {
      const k = byId.get(e.requires);
      if (k !== undefined) needed.add(k);
    }
  });
  for (const o of scene.objectives) {
    if (o.type === 'collect') continue;
    const t = byId.get(o.target);
    if (t !== undefined) needed.add(t);
  }

  const radius = HALF * STEP_RADIUS_MM;
  const jump = HALF * scene.controller.jump_height_mm;
  const out: Diagnostic[] = [];
  for (const i of [...needed].sort((a, b) => a - b)) {
    const e = scene.entities[i]!;
    const box = boxOf(e);
    const cx = HALF * e.pos_mm[0];
    const cz = HALF * e.pos_mm[2];
    let step = 0;
    let stepId = 'ground';
    scene.entities.forEach((s, j) => {
      if (j === i || !isSolid(s)) return;
      const sb = boxOf(s);
      if (sb[4] > box[4]) return;
      const dx = Math.max(0, sb[0] - cx, cx - sb[3]);
      const dz = Math.max(0, sb[2] - cz, cz - sb[5]);
      if (dx * dx + dz * dz <= radius * radius && sb[4] > step) {
        step = sb[4];
        stepId = s.id;
      }
    });
    const rise = Math.max(0, box[1] - step);
    if (rise > jump) {
      out.push(
        diag('UNREACHABLE_HEIGHT', pointerFrom('entities', i, 'pos_mm'), `${e.id} is out of jump reach from the highest step (${stepId})`, {
          id: e.id,
          step: stepId,
          rise_half_mm: rise,
          jump_half_mm: jump,
        }),
      );
    }
  }
  return out;
}
