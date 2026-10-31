import { diag, pointerFrom, type Diagnostic } from '../diagnostic.ts';
import { EVENT_KIND, indexById, kindMatches, parseEvent, type ExpectedKind } from '../geometry.ts';
import type { Scene } from '../schema.ts';

/**
 * UNRESOLVED_REF: a reference names an id that no entity has, or an entity of the wrong kind. Evidence is always
 * `{id, expected_kind, actual_kind}`, with `actual_kind` "missing" when no entity has the id.
 * - rule events (`on` and `emit`): `collect:` needs a pickup or key, `open:` a door, `enter:` any entity;
 * - a door's `requires` needs a key, and each of its `guards` any entity;
 * - a `reach` objective's target is any entity, an `unlock` objective's target a door.
 */
export function checkUnresolvedRef(scene: Scene): Diagnostic[] {
  const byId = indexById(scene);
  const out: Diagnostic[] = [];

  const verify = (pointer: string, id: string, expected: ExpectedKind, what: string): void => {
    const at = byId.get(id);
    const actual = at === undefined ? 'missing' : scene.entities[at]!.kind;
    if (actual !== 'missing' && kindMatches(expected, actual)) return;
    const problem = actual === 'missing' ? `names missing id "${id}"` : `names "${id}", a ${actual}, where ${expected === 'any' ? 'an entity' : `a ${expected.replace('|', ' or ')}`} is needed`;
    out.push(diag('UNRESOLVED_REF', pointer, `${what} ${problem}`, { id, expected_kind: expected, actual_kind: actual }));
  };

  scene.rules.forEach((rule, i) => {
    for (const field of ['on', 'emit'] as const) {
      const ev = parseEvent(rule[field]);
      if (ev && ev.kind !== 'signal') verify(pointerFrom('rules', i, field), ev.name, EVENT_KIND[ev.kind], `rule ${rule.id} ${field}`);
    }
  });

  scene.entities.forEach((e, i) => {
    if (e.kind !== 'door') return;
    verify(pointerFrom('entities', i, 'requires'), e.requires, 'key', `door ${e.id} requires`);
    (e.guards ?? []).forEach((g, j) => verify(pointerFrom('entities', i, 'guards', j), g, 'any', `door ${e.id} guards`));
  });

  scene.objectives.forEach((o, i) => {
    if (o.type === 'reach') verify(pointerFrom('objectives', i, 'target'), o.target, 'any', `objective ${o.id} targets`);
    if (o.type === 'unlock') verify(pointerFrom('objectives', i, 'target'), o.target, 'door', `objective ${o.id} targets`);
  });

  return out;
}
