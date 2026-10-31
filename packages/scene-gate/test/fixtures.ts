import type { Diagnostic } from '../src/diagnostic.ts';
import type { Scene } from '../src/schema.ts';

/** Entity indexes in cleanScene(), so tests can name pointers without counting. */
export const E = { wall: 0, crate1: 1, crate2: 2, coin1: 3, coin2: 4, coin3: 5, key: 6, door: 7, goal: 8 } as const;

/**
 * A scene that passes every check, including UNREACHABLE_HEIGHT. Every failing fixture is this scene with one edit,
 * which is what keeps each fixture's expected diagnostics exact.
 */
export function cleanScene(): Scene {
  return {
    scene: 'scene-gate/1',
    bounds_mm: [-20000, 0, -20000, 20000, 10000, 20000],
    controller: { height_mm: 1800, radius_mm: 300, jump_height_mm: 1200 },
    spawn: { pos_mm: [0, 0, 0] },
    entities: [
      { id: 'wall_n', kind: 'static', box_mm: [10000, 3000, 200], pos_mm: [0, 1500, -8000] },
      { id: 'crate_1', kind: 'dynamic', box_mm: [800, 800, 800], pos_mm: [3000, 400, 2000] },
      { id: 'crate_2', kind: 'dynamic', box_mm: [800, 800, 800], pos_mm: [3000, 1200, 2000] },
      { id: 'coin_1', kind: 'pickup', tags: ['coin'], box_mm: [300, 300, 60], pos_mm: [-2000, 600, 1000] },
      { id: 'coin_2', kind: 'pickup', tags: ['coin'], box_mm: [300, 300, 60], pos_mm: [-2500, 600, 1500] },
      { id: 'coin_3', kind: 'pickup', tags: ['coin'], box_mm: [300, 300, 60], pos_mm: [6000, 600, 4500] },
      { id: 'key_red', kind: 'key', box_mm: [200, 100, 50], pos_mm: [-4000, 50, -3000] },
      { id: 'door_red', kind: 'door', requires: 'key_red', guards: ['coin_3'], box_mm: [1200, 2200, 150], pos_mm: [6000, 1100, 3000] },
      { id: 'goal_marker', kind: 'static', box_mm: [600, 100, 600], pos_mm: [8000, 50, 8000] },
    ],
    rules: [
      { id: 'r1', on: 'collect:coin_1', emit: 'signal:score_up' },
      { id: 'r2', on: 'signal:score_up', emit: 'signal:combo' },
      { id: 'r3', on: 'enter:goal_marker', emit: 'signal:done' },
    ],
    objectives: [
      { id: 'o1', type: 'collect', tag: 'coin', count: 3 },
      { id: 'o2', type: 'unlock', target: 'door_red' },
      { id: 'o3', type: 'reach', target: 'goal_marker' },
    ],
  };
}

/** cleanScene() with one edit applied. */
export function edited(edit: (scene: Scene) => void): Scene {
  const scene = cleanScene();
  edit(scene);
  return scene;
}

/** A bare scene with no entities, rules or objectives, for tests that need to place a few boxes exactly. */
export function emptyScene(): Scene {
  return { ...cleanScene(), entities: [], rules: [], objectives: [], spawn: { pos_mm: [0, 0, -15000] } };
}

export const box = (id: string, kind: 'static' | 'dynamic', pos: [number, number, number], size: [number, number, number]): Scene['entities'][number] => ({
  id,
  kind,
  pos_mm: pos,
  box_mm: size,
});

export const brief = (list: readonly Diagnostic[]): string[] => list.map((d) => `${d.code} ${d.pointer}`);

/** The example from the task: schema-valid and unplayable, as the JSON a model would write. */
export const EXAMPLE_SCENE = {
  scene: 'scene-gate/1',
  bounds_mm: [-20000, 0, -20000, 20000, 10000, 20000],
  controller: { height_mm: 1800, radius_mm: 300, jump_height_mm: 1200 },
  spawn: { pos_mm: [0, 0, 0] },
  entities: [
    { id: 'crate_1', kind: 'dynamic', box_mm: [800, 800, 800], pos_mm: [3000, 400, 2000] },
    { id: 'coin_1', kind: 'pickup', tags: ['coin'], box_mm: [300, 300, 60], pos_mm: [-2000, 600, 1000] },
    { id: 'key_red', kind: 'key', box_mm: [200, 100, 50], pos_mm: [-4000, 50, -3000] },
    { id: 'door_red', kind: 'door', requires: 'key_red', guards: ['chest_1'], box_mm: [1200, 2200, 150], pos_mm: [6000, 1100, 3000] },
  ],
  rules: [{ id: 'r1', on: 'collect:coin_1', emit: 'signal:score_up' }],
  objectives: [{ id: 'o1', type: 'collect', tag: 'coin', count: 10 }],
} as const;
