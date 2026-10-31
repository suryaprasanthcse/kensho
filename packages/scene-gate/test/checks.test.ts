import { describe, expect, it } from 'vitest';
import { CHECKS, checkScene } from '../src/check.ts';
import { checkDuplicateId } from '../src/checks/duplicate-id.ts';
import { checkObjectiveCount } from '../src/checks/objective-count.ts';
import { checkOutOfBounds } from '../src/checks/out-of-bounds.ts';
import { checkProgressionCycle } from '../src/checks/progression-cycle.ts';
import { checkRuleCycle } from '../src/checks/rule-cycle.ts';
import { checkSpatialOverlap } from '../src/checks/spatial-overlap.ts';
import { checkSpawnObstructed } from '../src/checks/spawn-obstructed.ts';
import { checkUnreachableHeight } from '../src/checks/unreachable-height.ts';
import { checkUnresolvedRef } from '../src/checks/unresolved-ref.ts';
import { checkUnsupportedDynamic } from '../src/checks/unsupported-dynamic.ts';
import type { Diagnostic } from '../src/diagnostic.ts';
import type { Scene } from '../src/schema.ts';
import { E, box, brief, cleanScene, edited, emptyScene } from './fixtures.ts';

type Door = Extract<Scene['entities'][number], { kind: 'door' }>;
const door = (s: Scene, i: number): Door => s.entities[i] as Door;
const all = (s: Scene): Diagnostic[] => checkScene(s, { unreachableHeight: true });
const codes = (s: Scene): string[] => [...new Set(all(s).map((d) => d.code))];

describe('the clean control', () => {
  it('passes every check, including the optional one', () => {
    expect(all(cleanScene())).toEqual([]);
  });

  it('is exercised by every check module', () => {
    for (const entry of CHECKS) expect(entry.run(cleanScene()), entry.code).toEqual([]);
  });
});

describe('DUPLICATE_ID', () => {
  it('flags the later entity that reuses an id', () => {
    const s = edited((s) => void (s.entities[E.coin2]!.id = 'coin_1'));
    expect(brief(checkDuplicateId(s))).toEqual(['DUPLICATE_ID /entities/4/id']);
    expect(codes(s)).toEqual(['DUPLICATE_ID']);
  });

  it('shares one namespace across entities, rules and objectives', () => {
    const s = edited((s) => {
      s.rules[1]!.id = 'crate_1';
      s.objectives[2]!.id = 'r1';
    });
    expect(brief(checkDuplicateId(s))).toEqual(['DUPLICATE_ID /rules/1/id', 'DUPLICATE_ID /objectives/2/id']);
  });

  it('reports each later holder when an id is used three times', () => {
    const s = edited((s) => {
      s.entities[E.coin2]!.id = 'coin_1';
      s.entities[E.coin3]!.id = 'coin_1';
    });
    expect(brief(checkDuplicateId(s))).toEqual(['DUPLICATE_ID /entities/4/id', 'DUPLICATE_ID /entities/5/id']);
  });
});

describe('UNRESOLVED_REF', () => {
  it('flags a rule event that names a missing id, on either side', () => {
    const s = edited((s) => {
      s.rules[0]!.on = 'collect:ghost';
      s.rules[2]!.emit = 'open:phantom';
    });
    expect(brief(checkUnresolvedRef(s))).toEqual(['UNRESOLVED_REF /rules/0/on', 'UNRESOLVED_REF /rules/2/emit']);
    expect(codes(s)).toEqual(['UNRESOLVED_REF']);
  });

  it('does not resolve signal names against entities', () => {
    const s = edited((s) => void (s.rules[0]!.emit = 'signal:nobody_home'));
    expect(checkUnresolvedRef(s)).toEqual([]);
  });

  it('flags a door whose key is missing', () => {
    const s = edited((s) => void (door(s, E.door).requires = 'key_ghost'));
    const [d] = checkUnresolvedRef(s);
    expect(brief([d!])).toEqual(['UNRESOLVED_REF /entities/7/requires']);
    expect(d!.evidence).toMatchObject({ reason: 'missing' });
  });

  it('flags a door whose requires names something that is not a key', () => {
    const s = edited((s) => void (door(s, E.door).requires = 'crate_1'));
    const [d] = checkUnresolvedRef(s);
    expect(brief([d!])).toEqual(['UNRESOLVED_REF /entities/7/requires']);
    expect(d!.evidence).toMatchObject({ reason: 'not_a_key' });
  });

  it('flags each missing guard by its index', () => {
    const s = edited((s) => void (door(s, E.door).guards = ['coin_3', 'chest_1', 'chest_2']));
    expect(brief(checkUnresolvedRef(s))).toEqual(['UNRESOLVED_REF /entities/7/guards/1', 'UNRESOLVED_REF /entities/7/guards/2']);
  });

  it('flags a reach or unlock target that is missing', () => {
    const s = edited((s) => {
      s.objectives[1] = { id: 'o2', type: 'unlock', target: 'door_green' };
      s.objectives[2] = { id: 'o3', type: 'reach', target: 'flag' };
    });
    expect(brief(checkUnresolvedRef(s))).toEqual(['UNRESOLVED_REF /objectives/1/target', 'UNRESOLVED_REF /objectives/2/target']);
  });
});

describe('OBJECTIVE_COUNT', () => {
  it('flags a collect objective that needs more tagged entities than exist', () => {
    const s = edited((s) => void (s.objectives[0] = { id: 'o1', type: 'collect', tag: 'coin', count: 4 }));
    const [d] = checkObjectiveCount(s);
    expect(brief([d!])).toEqual(['OBJECTIVE_COUNT /objectives/0/count']);
    expect(d!.evidence).toEqual({ tag: 'coin', needed: 4, available: 3 });
    expect(codes(s)).toEqual(['OBJECTIVE_COUNT']);
  });

  it('accepts a count equal to what exists', () => {
    expect(checkObjectiveCount(cleanScene())).toEqual([]);
  });

  it('flags a tag that no entity carries', () => {
    const s = edited((s) => void (s.objectives[0] = { id: 'o1', type: 'collect', tag: 'gem', count: 1 }));
    expect(brief(checkObjectiveCount(s))).toEqual(['OBJECTIVE_COUNT /objectives/0/count']);
  });

  it('counts only collectible entities, so a tagged static does not help', () => {
    const s = edited((s) => {
      s.entities.push({ id: 'coin_statue', kind: 'static', tags: ['coin'], box_mm: [300, 300, 300], pos_mm: [-8000, 150, 0] });
      s.objectives[0] = { id: 'o1', type: 'collect', tag: 'coin', count: 4 };
    });
    expect(brief(checkObjectiveCount(s))).toEqual(['OBJECTIVE_COUNT /objectives/0/count']);
  });
});

describe('RULE_CYCLE', () => {
  it('flags the rule that closes a cycle', () => {
    const s = edited((s) => {
      s.rules = [
        { id: 'a', on: 'signal:x', emit: 'signal:y' },
        { id: 'b', on: 'signal:y', emit: 'signal:x' },
      ];
    });
    expect(brief(checkRuleCycle(s))).toEqual(['RULE_CYCLE /rules/1']);
    expect(codes(s)).toEqual(['RULE_CYCLE']);
  });

  it('flags a rule that triggers itself', () => {
    const s = edited((s) => void (s.rules = [{ id: 'a', on: 'signal:x', emit: 'signal:x' }]));
    expect(brief(checkRuleCycle(s))).toEqual(['RULE_CYCLE /rules/0']);
  });

  it('follows a cycle through a longer chain', () => {
    const s = edited((s) => {
      s.rules = [
        { id: 'a', on: 'signal:1', emit: 'signal:2' },
        { id: 'b', on: 'signal:2', emit: 'signal:3' },
        { id: 'c', on: 'signal:3', emit: 'signal:4' },
        { id: 'd', on: 'signal:4', emit: 'signal:2' },
      ];
    });
    const [d] = checkRuleCycle(s);
    expect(brief([d!])).toEqual(['RULE_CYCLE /rules/3']);
    expect(d!.evidence).toEqual({ rule: 'd', cycle: ['signal:2', 'signal:3', 'signal:4', 'signal:2'] });
  });

  it('accepts a diamond, where two paths meet without looping', () => {
    const s = edited((s) => {
      s.rules = [
        { id: 'a', on: 'signal:a', emit: 'signal:b' },
        { id: 'b', on: 'signal:a', emit: 'signal:c' },
        { id: 'c', on: 'signal:b', emit: 'signal:d' },
        { id: 'd', on: 'signal:c', emit: 'signal:d' },
      ];
    });
    expect(checkRuleCycle(s)).toEqual([]);
  });
});

describe('PROGRESSION_CYCLE', () => {
  it('flags a key behind its own door', () => {
    const s = edited((s) => void (door(s, E.door).guards = ['key_red']));
    const [d] = checkProgressionCycle(s);
    expect(brief([d!])).toEqual(['PROGRESSION_CYCLE /entities/7/requires']);
    expect(d!.evidence).toMatchObject({ door: 'door_red', key: 'key_red' });
    expect(codes(s)).toEqual(['PROGRESSION_CYCLE']);
  });

  it('flags a cycle through two doors, once, at the lowest-index door', () => {
    const s = edited((s) => {
      s.entities.push(
        { id: 'key_blue', kind: 'key', box_mm: [200, 100, 50], pos_mm: [-6000, 50, -3000] },
        { id: 'door_blue', kind: 'door', requires: 'key_blue', guards: ['key_red'], box_mm: [1200, 2200, 150], pos_mm: [-6000, 1100, 3000] },
      );
      // key_red is behind door_blue, which needs key_blue; key_blue is behind door_red, which needs key_red.
      door(s, E.door).guards = ['coin_3', 'key_blue'];
    });
    const found = checkProgressionCycle(s);
    expect(brief(found)).toEqual(['PROGRESSION_CYCLE /entities/7/requires']);
    expect(found[0]!.evidence.members).toEqual(['key_red', 'door_red', 'key_blue', 'door_blue']);
  });

  it('flags two doors that sit behind each other, which no key can break', () => {
    const s = edited((s) => {
      s.entities.push({ id: 'door_b', kind: 'door', requires: 'key_red', guards: ['door_red'], box_mm: [1200, 2200, 150], pos_mm: [-6000, 1100, 3000] });
      door(s, E.door).guards = ['door_b'];
    });
    expect(brief(checkProgressionCycle(s))).toEqual(['PROGRESSION_CYCLE /entities/7/requires']);
  });

  it('accepts a chain where each key is behind an earlier door', () => {
    const s = edited((s) => {
      s.entities.push(
        { id: 'key_blue', kind: 'key', box_mm: [200, 100, 50], pos_mm: [6000, 50, 4000] },
        { id: 'door_blue', kind: 'door', requires: 'key_blue', guards: ['goal_marker'], box_mm: [1200, 2200, 150], pos_mm: [-6000, 1100, 3000] },
      );
      door(s, E.door).guards = ['coin_3', 'key_blue'];
    });
    expect(checkProgressionCycle(s)).toEqual([]);
  });

  it('ignores references that do not resolve', () => {
    const s = edited((s) => void (door(s, E.door).guards = ['nothing']));
    expect(checkProgressionCycle(s)).toEqual([]);
  });
});

describe('SPATIAL_OVERLAP', () => {
  const pair = (bx: number, size: number = 1000): Scene => ({
    ...emptyScene(),
    entities: [box('a', 'static', [0, 500, 0], [size, 1000, 1000]), box('b', 'static', [bx, 500, 0], [size, 1000, 1000])],
  });

  it('flags the later entity of two overlapping solids', () => {
    const s = edited((s) => void s.entities.push(box('wall_extra', 'static', [100, 1500, -8000], [10000, 3000, 200])));
    const [d] = checkSpatialOverlap(s);
    expect(brief([d!])).toEqual(['SPATIAL_OVERLAP /entities/9/pos_mm']);
    expect(d!.evidence).toMatchObject({ a: 'wall_n', b: 'wall_extra' });
    expect(codes(s)).toEqual(['SPATIAL_OVERLAP']);
  });

  it('allows exactly 5 mm of overlap and flags 6 mm', () => {
    expect(checkSpatialOverlap(pair(995))).toEqual([]);
    expect(brief(checkSpatialOverlap(pair(994)))).toEqual(['SPATIAL_OVERLAP /entities/1/pos_mm']);
  });

  it('keeps the same tolerance for odd sizes, where the edges fall on half-millimetres', () => {
    expect(checkSpatialOverlap(pair(996, 1001))).toEqual([]);
    expect(brief(checkSpatialOverlap(pair(995, 1001)))).toEqual(['SPATIAL_OVERLAP /entities/1/pos_mm']);
  });

  it('does not flag boxes that only touch', () => {
    expect(checkSpatialOverlap(pair(1000))).toEqual([]);
  });

  it('requires an overlap on every axis', () => {
    const s: Scene = { ...emptyScene(), entities: [box('a', 'static', [0, 500, 0], [1000, 1000, 1000]), box('b', 'static', [500, 500, 3000], [1000, 1000, 1000])] };
    expect(checkSpatialOverlap(s)).toEqual([]);
  });

  it('lets a door overlap a static but not a dynamic or another door', () => {
    const d = (id: string, x: number): Scene['entities'][number] => ({ id, kind: 'door', requires: 'k', box_mm: [1000, 1000, 1000], pos_mm: [x, 500, 0] });
    const base = emptyScene();
    expect(checkSpatialOverlap({ ...base, entities: [box('wall', 'static', [0, 500, 0], [1000, 1000, 1000]), d('d', 100)] })).toEqual([]);
    expect(checkSpatialOverlap({ ...base, entities: [d('d', 100), box('wall', 'static', [0, 500, 0], [1000, 1000, 1000])] })).toEqual([]);
    expect(brief(checkSpatialOverlap({ ...base, entities: [box('c', 'dynamic', [0, 500, 0], [1000, 1000, 1000]), d('d', 100)] }))).toEqual(['SPATIAL_OVERLAP /entities/1/pos_mm']);
    expect(brief(checkSpatialOverlap({ ...base, entities: [d('d1', 0), d('d2', 100)] }))).toEqual(['SPATIAL_OVERLAP /entities/1/pos_mm']);
  });

  it('ignores pickups and keys, which are not solid', () => {
    const s: Scene = {
      ...emptyScene(),
      entities: [box('a', 'static', [0, 500, 0], [1000, 1000, 1000]), { id: 'p', kind: 'pickup', box_mm: [500, 500, 500], pos_mm: [0, 500, 0] }],
    };
    expect(checkSpatialOverlap(s)).toEqual([]);
  });
});

describe('SPAWN_OBSTRUCTED', () => {
  const wallAt = (minX: number): Scene => ({
    ...emptyScene(),
    spawn: { pos_mm: [0, 0, 0] },
    entities: [box('wall', 'static', [minX + 500, 1500, 0], [1000, 3000, 1000])],
  });

  it('flags a solid standing on the spawn point', () => {
    const s = edited((s) => void s.entities.push(box('block', 'static', [0, 900, 0], [1000, 1800, 1000])));
    const [d] = checkSpawnObstructed(s);
    expect(brief([d!])).toEqual(['SPAWN_OBSTRUCTED /spawn/pos_mm']);
    expect(d!.evidence).toMatchObject({ with: 'block' });
    expect(codes(s)).toEqual(['SPAWN_OBSTRUCTED']);
  });

  it('allows 5 mm of overlap with the player box and flags 6 mm', () => {
    expect(checkSpawnObstructed(wallAt(295))).toEqual([]);
    expect(brief(checkSpawnObstructed(wallAt(294)))).toEqual(['SPAWN_OBSTRUCTED /spawn/pos_mm']);
  });

  it('sizes the player box from the controller, so a taller player hits a low ceiling', () => {
    const ceiling = (heightMm: number): Scene => ({
      ...emptyScene(),
      spawn: { pos_mm: [0, 0, 0] },
      controller: { height_mm: heightMm, radius_mm: 300, jump_height_mm: 1200 },
      entities: [box('ceiling', 'static', [0, 1700, 0], [2000, 200, 2000])],
    });
    expect(checkSpawnObstructed(ceiling(1600))).toEqual([]);
    expect(brief(checkSpawnObstructed(ceiling(1800)))).toEqual(['SPAWN_OBSTRUCTED /spawn/pos_mm']);
  });

  it('treats a door as a solid but a pickup as passable', () => {
    const s: Scene = { ...emptyScene(), spawn: { pos_mm: [0, 0, 0] }, entities: [{ id: 'd', kind: 'door', requires: 'k', box_mm: [1000, 2000, 1000], pos_mm: [0, 1000, 0] }] };
    expect(brief(checkSpawnObstructed(s))).toEqual(['SPAWN_OBSTRUCTED /spawn/pos_mm']);
    const p: Scene = { ...emptyScene(), spawn: { pos_mm: [0, 0, 0] }, entities: [{ id: 'p', kind: 'pickup', box_mm: [1000, 2000, 1000], pos_mm: [0, 1000, 0] }] };
    expect(checkSpawnObstructed(p)).toEqual([]);
  });
});

describe('UNSUPPORTED_DYNAMIC', () => {
  const crateAt = (y: number): Scene => ({ ...emptyScene(), entities: [box('crate', 'dynamic', [0, y, 0], [800, 800, 800])] });

  it('flags a crate floating above the ground', () => {
    const s = edited((s) => void (s.entities[E.crate2]!.pos_mm = [3000, 2000, 2000]));
    const found = checkUnsupportedDynamic(s);
    expect(brief(found)).toEqual(['UNSUPPORTED_DYNAMIC /entities/2/pos_mm']);
    expect(found[0]!.evidence).toMatchObject({ id: 'crate_2', support: 'crate_1', gap_half_mm: 1600 });
    expect(codes(s)).toEqual(['UNSUPPORTED_DYNAMIC']);
  });

  it('allows a 20 mm gap and flags 21 mm', () => {
    expect(checkUnsupportedDynamic(crateAt(420))).toEqual([]);
    expect(brief(checkUnsupportedDynamic(crateAt(421)))).toEqual(['UNSUPPORTED_DYNAMIC /entities/0/pos_mm']);
  });

  it('accepts a crate resting on a solid top, and one stacked on another crate', () => {
    const s: Scene = {
      ...emptyScene(),
      entities: [box('plinth', 'static', [0, 500, 0], [2000, 1000, 2000]), box('crate', 'dynamic', [0, 1400, 0], [800, 800, 800]), box('top', 'dynamic', [0, 2200, 0], [800, 800, 800])],
    };
    expect(checkUnsupportedDynamic(s)).toEqual([]);
  });

  it('flags only the lower crate when a stack floats', () => {
    const s: Scene = { ...emptyScene(), entities: [box('low', 'dynamic', [0, 2000, 0], [800, 800, 800]), box('high', 'dynamic', [0, 2800, 0], [800, 800, 800])] };
    expect(brief(checkUnsupportedDynamic(s))).toEqual(['UNSUPPORTED_DYNAMIC /entities/0/pos_mm']);
  });

  it('does not count a solid that only touches the footprint edge as support', () => {
    // The plinth ends at x = 400 and the crate starts at x = 395: 5 mm of footprint overlap is not "under" it.
    const s: Scene = { ...emptyScene(), entities: [box('plinth', 'static', [-600, 500, 0], [2000, 1000, 2000]), box('crate', 'dynamic', [800, 1400, 0], [800, 800, 800])] };
    expect(brief(checkUnsupportedDynamic(s))).toEqual(['UNSUPPORTED_DYNAMIC /entities/1/pos_mm']);
  });

  it('does not take a solid that sits above the crate bottom for a support', () => {
    // A beam passing through the crate is an overlap, not a floor: the crate still hangs 600 mm above the ground.
    const s: Scene = { ...emptyScene(), entities: [box('crate', 'dynamic', [0, 1000, 0], [800, 800, 800]), box('beam', 'static', [0, 900, 0], [3000, 200, 3000])] };
    expect(brief(checkUnsupportedDynamic(s))).toEqual(['UNSUPPORTED_DYNAMIC /entities/0/pos_mm']);
  });

  it('only looks at dynamic boxes', () => {
    const s: Scene = { ...emptyScene(), entities: [box('floating_wall', 'static', [0, 3000, 0], [800, 800, 800])] };
    expect(checkUnsupportedDynamic(s)).toEqual([]);
  });
});

describe('OUT_OF_BOUNDS', () => {
  const crateAtX = (x: number): Scene => ({ ...emptyScene(), entities: [box('crate', 'dynamic', [x, 400, 0], [800, 800, 800])] });

  it('flags a box that sticks out of the bounds', () => {
    const s = edited((s) => void (s.entities[E.coin2]!.pos_mm = [20100, 600, 1500]));
    const [d] = checkOutOfBounds(s);
    expect(brief([d!])).toEqual(['OUT_OF_BOUNDS /entities/4/pos_mm']);
    expect(d!.evidence).toEqual({ id: 'coin_2', axes: ['x'] });
    expect(codes(s)).toEqual(['OUT_OF_BOUNDS']);
  });

  it('counts touching the bounds as inside and 1 mm beyond as outside', () => {
    expect(checkOutOfBounds(crateAtX(19600))).toEqual([]);
    expect(brief(checkOutOfBounds(crateAtX(19601)))).toEqual(['OUT_OF_BOUNDS /entities/0/pos_mm']);
  });

  it('flags pickups as well as solids, and reports every escaping axis', () => {
    const s: Scene = { ...emptyScene(), entities: [{ id: 'p', kind: 'pickup', box_mm: [300, 300, 300], pos_mm: [0, -200, 20100] }] };
    const [d] = checkOutOfBounds(s);
    expect(d!.evidence).toEqual({ id: 'p', axes: ['y', 'z'] });
  });

  it('flags a spawn whose player box leaves the bounds', () => {
    const s = edited((s) => void (s.spawn.pos_mm = [19800, 0, 0]));
    expect(brief(checkOutOfBounds(s))).toEqual(['OUT_OF_BOUNDS /spawn/pos_mm']);
    const ok = edited((s) => void (s.spawn.pos_mm = [19700, 0, 0]));
    expect(checkOutOfBounds(ok)).toEqual([]);
  });

  it('flags a player box that pokes through the ceiling', () => {
    const s = edited((s) => void (s.bounds_mm = [-20000, 0, -20000, 20000, 1500, 20000]));
    expect(brief(checkOutOfBounds(s))).toContain('OUT_OF_BOUNDS /spawn/pos_mm');
  });
});

describe('UNREACHABLE_HEIGHT (optional)', () => {
  const withCoinBottom = (bottom: number, extra: Scene['entities'] = []): Scene => ({
    ...emptyScene(),
    spawn: { pos_mm: [0, 0, 0] },
    entities: [{ id: 'coin', kind: 'pickup', tags: ['coin'], box_mm: [300, 300, 300], pos_mm: [0, bottom + 150, 5000] }, ...extra],
    objectives: [{ id: 'o1', type: 'collect', tag: 'coin', count: 1 }],
  });
  const step = (z: number, top: number): Scene['entities'][number] => box('step', 'static', [0, top / 2, z], [1000, top, 1000]);

  it('flags a needed pickup beyond jump height with nothing to climb', () => {
    const s = withCoinBottom(2000);
    const [d] = checkUnreachableHeight(s);
    expect(brief([d!])).toEqual(['UNREACHABLE_HEIGHT /entities/0/pos_mm']);
    expect(d!.evidence).toMatchObject({ id: 'coin', step: 'ground' });
  });

  it('allows exactly the jump height and flags 1 mm more', () => {
    expect(checkUnreachableHeight(withCoinBottom(1200))).toEqual([]);
    expect(brief(checkUnreachableHeight(withCoinBottom(1201)))).toEqual(['UNREACHABLE_HEIGHT /entities/0/pos_mm']);
  });

  it('counts a solid top within 1.5 m as a step, and one farther away as no help', () => {
    // The step's footprint spans z 3500..4500 around the coin at z 5000 (centre distance to its edge is 500).
    expect(checkUnreachableHeight(withCoinBottom(2000, [step(4000, 1000)]))).toEqual([]);
    // Footprint edge at z = 2500 is 2500 mm from the coin: out of range.
    expect(brief(checkUnreachableHeight(withCoinBottom(2000, [step(2000, 1000)])))).toEqual(['UNREACHABLE_HEIGHT /entities/0/pos_mm']);
  });

  it('is the flag, not the function, that keeps it off by default', () => {
    const s = withCoinBottom(2000);
    expect(checkScene(s)).toEqual([]);
    expect(brief(checkScene(s, { unreachableHeight: true }))).toEqual(['UNREACHABLE_HEIGHT /entities/0/pos_mm']);
  });

  it('applies to reach targets, unlock targets and the keys doors need, but not to unneeded pickups', () => {
    const items: Scene['entities'] = [
      { id: 'idle', kind: 'pickup', box_mm: [300, 300, 300], pos_mm: [0, 5150, 5000] },
      { id: 'key', kind: 'key', box_mm: [300, 300, 300], pos_mm: [2000, 5150, 5000] },
      { id: 'door', kind: 'door', requires: 'key', box_mm: [1000, 2000, 100], pos_mm: [4000, 1000, 5000] },
      { id: 'flag', kind: 'pickup', box_mm: [300, 300, 300], pos_mm: [-2000, 5150, 5000] },
    ];
    const s: Scene = { ...emptyScene(), entities: items, objectives: [{ id: 'o1', type: 'reach', target: 'flag' }] };
    expect(brief(checkUnreachableHeight(s))).toEqual(['UNREACHABLE_HEIGHT /entities/1/pos_mm', 'UNREACHABLE_HEIGHT /entities/3/pos_mm']);
  });
});
