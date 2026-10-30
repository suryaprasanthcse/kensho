import { z } from 'zod';

/** Integer micrometres, microradians, ppm or similar. Floats are rejected at parse time. */
const int = z.int();
const id = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const vec3 = z.tuple([int, int, int]);

export const AssetClass = z.enum(['hero', 'prop', 'background']);
export const BodyKind = z.enum(['dynamic', 'static']);
export const DistanceClass = z.enum(['touching', 'close', 'medium', 'far']);

/** Relations, not coordinates. */
export const Place = z.union([
  z.strictObject({ on: id }),
  z.strictObject({ in: id }),
  z.strictObject({ against: id }),
  z.strictObject({ near: z.tuple([id, DistanceClass]) }),
]);

export const Entity = z.strictObject({
  id,
  archetype: z.string().min(1).max(64),
  box_um: vec3.optional(),
  place: Place.optional(),
  body: BodyKind.optional(),
  asset: z.strictObject({ class: AssetClass, prompt: z.string().min(1).max(512) }).optional(),
});

export const Objective = z.strictObject({
  id,
  type: z.enum(['interact', 'collect', 'reach']),
  target: id,
  required: z.boolean(),
});

export const World = z.strictObject({
  bounds_um: z.tuple([int, int, int, int, int, int]),
  gravity_um_s2: int,
});

export const Controller = z.strictObject({
  height_um: int.positive(),
  radius_um: int.positive(),
  run_um_s: int.positive(),
  jump_um_s: int.positive(),
});

export const Ir = z.strictObject({
  kensho: z.literal('ir/1'),
  world: World,
  controller: Controller,
  entities: z.array(Entity),
  objectives: z.array(Objective),
});

export type IrDocument = z.infer<typeof Ir>;

/** JSON Schema for the IR, for constraining structured output. */
export const irJsonSchema = (): unknown => z.toJSONSchema(Ir);
