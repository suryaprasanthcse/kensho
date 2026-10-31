import { HALF } from './thresholds.ts';
import type { Entity, EntityKind, Scene } from './schema.ts';

/**
 * Axis-aligned box in half-millimetres: `[minx, miny, minz, maxx, maxy, maxz]`. `pos_mm` is the centre and `box_mm`
 * the full size, so `2 * pos ± size` is always an integer even for odd sizes.
 */
export type Box2 = readonly [number, number, number, number, number, number];

export const SOLID_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>(['static', 'dynamic', 'door']);
export const COLLECTIBLE_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>(['pickup', 'key']);

export const isSolid = (e: Entity): boolean => SOLID_KINDS.has(e.kind);
export const isCollectible = (e: Entity): boolean => COLLECTIBLE_KINDS.has(e.kind);

export const boxOf = (e: Pick<Entity, 'pos_mm' | 'box_mm'>): Box2 => {
  const [px, py, pz] = e.pos_mm;
  const [sx, sy, sz] = e.box_mm;
  return [HALF * px - sx, HALF * py - sy, HALF * pz - sz, HALF * px + sx, HALF * py + sy, HALF * pz + sz];
};

/** The player box: 2r by height by 2r with the feet at `spawn.pos_mm`. */
export const playerBox = (scene: Scene): Box2 => {
  const [x, y, z] = scene.spawn.pos_mm;
  const { radius_mm: r, height_mm: h } = scene.controller;
  return [HALF * x - HALF * r, HALF * y, HALF * z - HALF * r, HALF * x + HALF * r, HALF * y + HALF * h, HALF * z + HALF * r];
};

export const boundsBox = (scene: Scene): Box2 => {
  const [a, b, c, d, e, f] = scene.bounds_mm;
  return [HALF * a, HALF * b, HALF * c, HALF * d, HALF * e, HALF * f];
};

/** Signed overlap of two boxes along one axis (0 = x, 1 = y, 2 = z), in half-millimetres. Negative is a gap. */
export const overlapOn = (a: Box2, b: Box2, axis: 0 | 1 | 2): number =>
  Math.min(a[axis + 3]!, b[axis + 3]!) - Math.max(a[axis]!, b[axis]!);

export const overlap3 = (a: Box2, b: Box2): [number, number, number] => [overlapOn(a, b, 0), overlapOn(a, b, 1), overlapOn(a, b, 2)];

/** True when the boxes overlap by strictly more than `tolHalfMm` on all three axes. */
export const overlapsBeyond = (a: Box2, b: Box2, tolHalfMm: number): boolean => overlap3(a, b).every((o) => o > tolHalfMm);

/** First index of each id. Duplicates are DUPLICATE_ID's business; the other checks resolve to the first one. */
export const indexById = (scene: Scene): Map<string, number> => {
  const m = new Map<string, number>();
  scene.entities.forEach((e, i) => {
    if (!m.has(e.id)) m.set(e.id, i);
  });
  return m;
};

/** `kind:name` events. The schema guarantees the shape; this returns null for anything else. */
export const parseEvent = (s: string): { kind: 'collect' | 'enter' | 'open' | 'signal'; name: string } | null => {
  const i = s.indexOf(':');
  if (i < 0) return null;
  const kind = s.slice(0, i);
  if (kind !== 'collect' && kind !== 'enter' && kind !== 'open' && kind !== 'signal') return null;
  return { kind, name: s.slice(i + 1) };
};
