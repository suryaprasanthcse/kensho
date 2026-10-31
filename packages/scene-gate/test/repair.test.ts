import { describe, expect, it } from 'vitest';
import { evaluateValue } from '../src/check.ts';
import { applyRepair, type JsonPatch, type RepairResult } from '../src/repair.ts';
import type { Scene } from '../src/schema.ts';
import { EXAMPLE_SCENE, cleanScene } from './fixtures.ts';

const chest = { id: 'chest_1', kind: 'static', box_mm: [600, 600, 600], pos_mm: [8000, 300, 3000] };
const addChest: JsonPatch[number] = { op: 'add', path: '/entities/-', value: chest };
const nineCoins: JsonPatch = Array.from({ length: 9 }, (_, i) => ({
  op: 'add' as const,
  path: '/entities/-',
  value: { id: `coin_x${i}`, kind: 'pickup', tags: ['coin'], box_mm: [300, 300, 60], pos_mm: [-2000 - 400 * i, 600, 3000] },
}));

const example = (): unknown => structuredClone(EXAMPLE_SCENE);
const refusal = (r: RepairResult): { reason: string; detail: string } => {
  expect(r.status).toBe('refused');
  return r as { reason: string; detail: string };
};

describe('accepted repairs', () => {
  it('accepts a patch that removes one error and adds none', () => {
    const r = applyRepair(example(), [addChest]);
    expect(r.status).toBe('accepted');
    if (r.status !== 'accepted') return;
    expect(r.before.map((d) => d.code)).toEqual(['UNRESOLVED_REF', 'OBJECTIVE_COUNT']);
    expect(r.after.map((d) => d.code)).toEqual(['OBJECTIVE_COUNT']);
    expect(r.scene.entities.at(-1)?.id).toBe('chest_1');
  });

  it('accepts a patch that fixes everything', () => {
    const r = applyRepair(example(), [addChest, ...nineCoins]);
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') expect(r.after).toEqual([]);
  });

  it('accepts adding the missing collectible for a collect objective', () => {
    const scene = { ...cleanScene(), objectives: [{ id: 'o1', type: 'collect' as const, tag: 'coin', count: 3 }], entities: cleanScene().entities.slice(0, 5) };
    // Two coins exist and three are needed; the scene also keeps one unrelated error, so this is a partial fix.
    expect(applyRepair(scene, [{ op: 'add', path: '/entities/-', value: { id: 'coin_9', kind: 'pickup', tags: ['coin'], box_mm: [300, 300, 60], pos_mm: [-3000, 600, 0] } }]).status).toBe('accepted');
  });

  it('never modifies the scene it was given', () => {
    const input = example();
    const snapshot = structuredClone(input);
    applyRepair(input, [addChest]);
    applyRepair(input, [{ op: 'remove', path: '/objectives/0' }]);
    expect(input).toEqual(snapshot);
  });

  it('returns a new scene object that is itself schema-valid and checked', () => {
    const input = example();
    const r = applyRepair(input, [addChest]);
    if (r.status !== 'accepted') throw new Error('expected accepted');
    expect(r.scene).not.toBe(input);
    expect(evaluateValue(r.scene).diagnostics).toEqual(r.after);
  });
});

/** The clean scene with a misspelt unlock target and a misspelt reach target: two errors a retarget can fix. */
const brokenTargets = (): Scene => ({
  ...cleanScene(),
  objectives: [
    { id: 'o1', type: 'collect', tag: 'coin', count: 3 },
    { id: 'o2', type: 'unlock', target: 'door_redd' },
    { id: 'o3', type: 'reach', target: 'goal_markr' },
  ],
});

describe('retargeting an objective', () => {
  const retarget = (index: number, target: string): JsonPatch[number] => ({ op: 'replace', path: `/objectives/${index}/target`, value: target });
  /** o2 (unlock) points at a crate, the wrong kind. o3 (reach) is valid. */
  const wrongKind = (): Scene => ({
    ...cleanScene(),
    objectives: [
      { id: 'o1', type: 'collect', tag: 'coin', count: 3 },
      { id: 'o2', type: 'unlock', target: 'crate_1' },
      { id: 'o3', type: 'reach', target: 'goal_marker' },
    ],
  });

  it('is accepted when the old unlock target was missing and the new one is a door', () => {
    const r = applyRepair(brokenTargets(), [retarget(1, 'door_red')]);
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') expect(r.after.map((d) => d.pointer)).toEqual(['/objectives/2/target']);
  });

  it('is accepted when the old target was the wrong kind', () => {
    const r = applyRepair(wrongKind(), [retarget(1, 'door_red')]);
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') expect(r.after).toEqual([]);
  });

  it('is accepted for a missing reach target, to any existing entity', () => {
    for (const id of ['goal_marker', 'crate_1', 'coin_1', 'key_red', 'door_red']) {
      expect(applyRepair(brokenTargets(), [retarget(2, id)]).status, id).toBe('accepted');
    }
  });

  it('is accepted when both flagged targets are fixed at once, leaving the scene passing', () => {
    const r = applyRepair(brokenTargets(), [retarget(1, 'door_red'), retarget(2, 'goal_marker')]);
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') expect(r.after).toEqual([]);
  });

  it('is refused for a valid target, even when the new target is fine and the patch fixes something else', () => {
    // o2 is broken and o3 is valid. Fixing o2 does not excuse moving o3 to a different entity.
    const r = refusal(applyRepair(wrongKind(), [retarget(1, 'door_red'), retarget(2, 'crate_1')]));
    expect(r.reason).toBe('objective_weakened');
    expect(r.detail).toContain('retargeted from "goal_marker", which was a valid target');
  });

  it('is refused for a valid target on its own, before the shrink rule is even asked', () => {
    const r = refusal(applyRepair(wrongKind(), [retarget(2, 'coin_1')]));
    expect(r.reason).toBe('objective_weakened');
    expect(r.detail).toContain('valid target');
  });

  it('is refused for a valid unlock target, in a scene whose only other error is elsewhere', () => {
    const scene = { ...cleanScene(), objectives: [{ id: 'o1', type: 'collect' as const, tag: 'coin', count: 4 }, { id: 'o2', type: 'unlock' as const, target: 'door_red' }] };
    const door2 = { id: 'door_2', kind: 'door', requires: 'key_red', box_mm: [1200, 2200, 150], pos_mm: [-6000, 1100, 3000] };
    const r = refusal(applyRepair(scene, [{ op: 'add', path: '/entities/-', value: door2 }, retarget(1, 'door_2')]));
    expect(r.reason).toBe('objective_weakened');
    expect(r.detail).toContain('valid target');
  });

  it('judges whether a target was valid on the scene as given, not on the patched one', () => {
    // goal_marker is valid before the patch. The patch breaks it and moves o3 on to another entity: still a retarget of a valid target.
    const r = refusal(applyRepair(wrongKind(), [retarget(1, 'door_red'), { op: 'remove', path: '/entities/8' }, retarget(2, 'coin_1')]));
    expect(r.reason).toBe('objective_weakened');
    expect(r.detail).toContain('valid target');
  });

  it('is refused when the new target does not exist', () => {
    const r = refusal(applyRepair(brokenTargets(), [retarget(1, 'door_green')]));
    expect(r.reason).toBe('objective_weakened');
    expect(r.detail).toContain('does not exist');
  });

  it('is refused when an unlock target is not a door', () => {
    const r = refusal(applyRepair(brokenTargets(), [retarget(1, 'crate_1')]));
    expect(r.reason).toBe('objective_weakened');
    expect(r.detail).toContain('a dynamic, where a door is needed');
  });

  it('is judged on the patched scene, so a patch may add the entity it retargets to', () => {
    const r = applyRepair(brokenTargets(), [
      { op: 'add', path: '/entities/-', value: { id: 'exit_marker', kind: 'static', box_mm: [600, 100, 600], pos_mm: [-8000, 50, 8000] } },
      retarget(2, 'exit_marker'),
    ]);
    expect(r.status).toBe('accepted');
  });

  it('does not need a retarget when the patch adds the entity the broken target names', () => {
    const goal = { id: 'goal_markr', kind: 'static', box_mm: [600, 100, 600], pos_mm: [-8000, 50, 8000] };
    expect(applyRepair(brokenTargets(), [{ op: 'add', path: '/entities/-', value: goal }]).status).toBe('accepted');
  });

  it('still refuses to change an objective type, tag or count whatever its target', () => {
    expect(refusal(applyRepair(brokenTargets(), [{ op: 'replace', path: '/objectives/1', value: { id: 'o2', type: 'reach', target: 'door_red' } }])).reason).toBe('objective_weakened');
    expect(refusal(applyRepair(example(), [addChest, { op: 'replace', path: '/objectives/0/tag', value: 'crate' }])).reason).toBe('objective_weakened');
    expect(refusal(applyRepair(example(), [addChest, { op: 'replace', path: '/objectives/0/count', value: 1 }])).reason).toBe('objective_weakened');
  });
});

describe('refused repairs', () => {
  it('refuses a patch that removes an objective, even though it would clear an error', () => {
    const r = refusal(applyRepair(example(), [addChest, { op: 'remove', path: '/objectives/0' }]));
    expect(r.reason).toBe('objective_removed');
  });

  it('refuses to lower a collect count', () => {
    const r = refusal(applyRepair(example(), [addChest, { op: 'replace', path: '/objectives/0/count', value: 1 }]));
    expect(r.reason).toBe('objective_weakened');
    expect(r.detail).toContain('lowered its count from 10 to 1');
  });

  it('refuses to dodge a count by changing the objective tag or type', () => {
    expect(refusal(applyRepair(example(), [{ op: 'replace', path: '/objectives/0/tag', value: 'crate' }])).reason).toBe('objective_weakened');
    expect(refusal(applyRepair(brokenTargets(), [{ op: 'replace', path: '/objectives/1', value: { id: 'o2', type: 'reach', target: 'door_red' } }])).reason).toBe('objective_weakened');
    expect(refusal(applyRepair(brokenTargets(), [{ op: 'replace', path: '/objectives/2', value: { id: 'o3', type: 'unlock', target: 'door_red' } }])).reason).toBe('objective_weakened');
    expect(refusal(applyRepair(example(), [addChest, { op: 'replace', path: '/objectives/0', value: { id: 'o1', type: 'reach', target: 'chest_1' } }])).reason).toBe('objective_weakened');
  });

  it('refuses a patch that empties the objectives list', () => {
    expect(refusal(applyRepair(example(), [addChest, { op: 'replace', path: '/objectives', value: [] }])).reason).toBe('objective_removed');
  });

  it('refuses a patch that does not change the error codes', () => {
    const r = refusal(applyRepair(example(), []));
    expect(r.reason).toBe('not_shrinking');
    const unrelated = { op: 'add' as const, path: '/entities/-', value: { id: 'wall_far', kind: 'static', box_mm: [500, 500, 500], pos_mm: [-9000, 250, 9000] } };
    expect(refusal(applyRepair(example(), [unrelated])).reason).toBe('not_shrinking');
  });

  it('refuses a patch that fixes one error but introduces a code the scene did not have', () => {
    const overlapping = { ...chest, id: 'chest_2', pos_mm: [8100, 300, 3000] };
    const r = refusal(applyRepair(example(), [addChest, { op: 'add', path: '/entities/-', value: overlapping }]));
    expect(r.reason).toBe('new_code');
    expect(r.detail).toContain('SPATIAL_OVERLAP');
  });

  it('refuses a patch that trades one error for another instance of an existing code', () => {
    // OBJECTIVE_COUNT goes away, but the door now guards a second missing id: UNRESOLVED_REF occurs twice.
    const r = refusal(applyRepair(example(), [...nineCoins, { op: 'add', path: '/entities/3/guards/-', value: 'chest_2' }]));
    expect(r.reason).toBe('not_shrinking');
    expect(r.detail).toContain('UNRESOLVED_REF');
  });

  it('refuses a malformed patch', () => {
    for (const bad of [{}, null, 'replace', [{ op: 'bogus', path: '/a' }], [{ op: 'add' }], [{ op: 'add', path: 'no-slash', value: 1 }]]) {
      expect(refusal(applyRepair(example(), bad)).reason, JSON.stringify(bad)).toBe('invalid_patch');
    }
  });

  it('refuses a patch that cannot be applied', () => {
    expect(refusal(applyRepair(example(), [{ op: 'replace', path: '/entities/99/id', value: 'x' }])).reason).toBe('patch_failed');
    expect(refusal(applyRepair(example(), [{ op: 'test', path: '/scene', value: 'other' }])).reason).toBe('patch_failed');
    expect(refusal(applyRepair(example(), [{ op: 'add', path: '/__proto__/polluted', value: 1 }])).reason).toBe('patch_failed');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a patch that leaves the scene schema-invalid', () => {
    expect(refusal(applyRepair(example(), [addChest, { op: 'replace', path: '/entities/0/box_mm', value: [1.5, 1, 1] }])).reason).toBe('schema_invalid_after_patch');
    expect(refusal(applyRepair(example(), [addChest, { op: 'add', path: '/entities/0/colour', value: 'red' }])).reason).toBe('schema_invalid_after_patch');
  });

  it('refuses to repair a scene that was never schema-valid', () => {
    expect(refusal(applyRepair({ scene: 'scene-gate/1' }, [addChest])).reason).toBe('original_schema_invalid');
    expect(refusal(applyRepair(null, [])).reason).toBe('original_schema_invalid');
  });

  it('refuses a patch to a scene that has nothing to repair', () => {
    const r = refusal(applyRepair(cleanScene(), [{ op: 'add', path: '/entities/-', value: chest }]));
    expect(r.reason).toBe('not_shrinking');
  });
});
