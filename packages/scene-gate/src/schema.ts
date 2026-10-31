import { z } from 'zod';

/** Coordinates and sizes are integer millimetres, capped at 1 km so every squared distance stays an exact integer. */
export const MM_LIMIT = 1_000_000;

const Mm = z.number().int().min(-MM_LIMIT).max(MM_LIMIT);
const Size = z.number().int().min(1).max(MM_LIMIT);

const Vec3 = z.tuple([Mm, Mm, Mm]);
const Size3 = z.tuple([Size, Size, Size]);
const Bounds = z.tuple([Mm, Mm, Mm, Mm, Mm, Mm]);

const NAME = /^[A-Za-z0-9_.-]+$/;
const EVENT = /^(collect|enter|open|signal):[A-Za-z0-9_.-]+$/;

const Id = z.string().min(1).max(64).regex(NAME);
const Tags = z.array(Id).max(16);
const Event = z.string().regex(EVENT);

const solid = <K extends 'static' | 'dynamic'>(kind: K) =>
  z.strictObject({ id: Id, kind: z.literal(kind), box_mm: Size3, pos_mm: Vec3, tags: Tags.optional() });

const Static = solid('static');
const Dynamic = solid('dynamic');

const Door = z.strictObject({
  id: Id,
  kind: z.literal('door'),
  /** The id of the key that opens this door. */
  requires: Id,
  /** Ids of the entities behind this door. */
  guards: z.array(Id).max(64).optional(),
  box_mm: Size3,
  pos_mm: Vec3,
  tags: Tags.optional(),
});

const collectible = <K extends 'pickup' | 'key'>(kind: K) =>
  z.strictObject({ id: Id, kind: z.literal(kind), box_mm: Size3, pos_mm: Vec3, tags: Tags.optional() });

const Pickup = collectible('pickup');
const Key = collectible('key');

export const EntitySchema = z.discriminatedUnion('kind', [Static, Dynamic, Door, Pickup, Key]);

export const RuleSchema = z.strictObject({ id: Id, on: Event, emit: Event });

export const ObjectiveSchema = z.discriminatedUnion('type', [
  z.strictObject({ id: Id, type: z.literal('collect'), tag: Id, count: z.number().int().min(1).max(1000) }),
  z.strictObject({ id: Id, type: z.literal('reach'), target: Id }),
  z.strictObject({ id: Id, type: z.literal('unlock'), target: Id }),
]);

export const SceneSchema = z.strictObject({
  scene: z.literal('scene-gate/1'),
  /** `[minx, miny, minz, maxx, maxy, maxz]`. */
  bounds_mm: Bounds,
  controller: z.strictObject({
    height_mm: Size,
    radius_mm: Size,
    jump_height_mm: z.number().int().min(0).max(MM_LIMIT),
  }),
  /** `pos_mm` is the feet position of the player. */
  spawn: z.strictObject({ pos_mm: Vec3 }),
  entities: z.array(EntitySchema).max(500),
  rules: z.array(RuleSchema).max(200),
  objectives: z.array(ObjectiveSchema).max(50),
});

export type Scene = z.infer<typeof SceneSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type EntityKind = Entity['kind'];
export type Rule = z.infer<typeof RuleSchema>;
export type Objective = z.infer<typeof ObjectiveSchema>;

/** The JSON Schema (draft 2020-12) that structured-output requests are given. */
export const sceneJsonSchema = (): Record<string, unknown> => ({
  $id: 'https://kensho.invalid/scene-gate-1.json',
  title: 'scene-gate/1',
  ...(z.toJSONSchema(SceneSchema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>),
});
