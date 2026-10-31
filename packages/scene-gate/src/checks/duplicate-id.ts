import { diag, pointerFrom, type Diagnostic } from '../diagnostic.ts';
import type { Scene } from '../schema.ts';

/** DUPLICATE_ID: entities, rules and objectives share one id namespace; the later holder of an id is reported. */
export function checkDuplicateId(scene: Scene): Diagnostic[] {
  const firstSeen = new Map<string, string>();
  const out: Diagnostic[] = [];
  const visit = (id: string, pointer: string): void => {
    const first = firstSeen.get(id);
    if (first === undefined) firstSeen.set(id, pointer);
    else out.push(diag('DUPLICATE_ID', pointer, `id "${id}" is already used at ${first}`, { id, first }));
  };
  scene.entities.forEach((e, i) => visit(e.id, pointerFrom('entities', i, 'id')));
  scene.rules.forEach((r, i) => visit(r.id, pointerFrom('rules', i, 'id')));
  scene.objectives.forEach((o, i) => visit(o.id, pointerFrom('objectives', i, 'id')));
  return out;
}
