import { diag, pointerFrom, type Diagnostic } from '../diagnostic.ts';
import { indexById, parseEvent } from '../geometry.ts';
import type { Scene } from '../schema.ts';

/**
 * UNRESOLVED_REF: a rule event, a door's requires/guards, or an objective target names an id no entity has.
 * `requires` must also name a key, because the format defines it as "a key id".
 */
export function checkUnresolvedRef(scene: Scene): Diagnostic[] {
  const byId = indexById(scene);
  const out: Diagnostic[] = [];

  scene.rules.forEach((rule, i) => {
    for (const field of ['on', 'emit'] as const) {
      const ev = parseEvent(rule[field]);
      if (ev && ev.kind !== 'signal' && !byId.has(ev.name)) {
        out.push(
          diag('UNRESOLVED_REF', pointerFrom('rules', i, field), `rule ${rule.id} ${field} names missing id "${ev.name}"`, {
            ref: ev.name,
            event: rule[field],
            reason: 'missing',
          }),
        );
      }
    }
  });

  scene.entities.forEach((e, i) => {
    if (e.kind !== 'door') return;
    const k = byId.get(e.requires);
    if (k === undefined) {
      out.push(
        diag('UNRESOLVED_REF', pointerFrom('entities', i, 'requires'), `door ${e.id} requires missing id "${e.requires}"`, {
          ref: e.requires,
          reason: 'missing',
        }),
      );
    } else if (scene.entities[k]!.kind !== 'key') {
      out.push(
        diag('UNRESOLVED_REF', pointerFrom('entities', i, 'requires'), `door ${e.id} requires "${e.requires}", which is not a key`, {
          ref: e.requires,
          reason: 'not_a_key',
        }),
      );
    }
    (e.guards ?? []).forEach((g, j) => {
      if (!byId.has(g)) {
        out.push(
          diag('UNRESOLVED_REF', pointerFrom('entities', i, 'guards', j), `door ${e.id} guards missing id "${g}"`, {
            ref: g,
            reason: 'missing',
          }),
        );
      }
    });
  });

  scene.objectives.forEach((o, i) => {
    if (o.type === 'collect') return;
    if (!byId.has(o.target)) {
      out.push(
        diag('UNRESOLVED_REF', pointerFrom('objectives', i, 'target'), `objective ${o.id} targets missing id "${o.target}"`, {
          ref: o.target,
          reason: 'missing',
        }),
      );
    }
  });

  return out;
}
