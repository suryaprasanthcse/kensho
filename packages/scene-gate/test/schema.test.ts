import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCHEMA_PATH, renderSchemaFile } from '../src/write-schema.ts';
import { SceneSchema, sceneJsonSchema } from '../src/schema.ts';
import { EXAMPLE_SCENE, cleanScene } from './fixtures.ts';

const parses = (value: unknown): boolean => SceneSchema.safeParse(value).success;
const clone = (): Record<string, any> => structuredClone(cleanScene()) as unknown as Record<string, any>;

describe('the scene schema', () => {
  it('accepts the clean scene and the task example', () => {
    expect(parses(cleanScene())).toBe(true);
    expect(parses(EXAMPLE_SCENE)).toBe(true);
  });

  it('rejects anything that is not an integer number of millimetres', () => {
    const s = clone();
    s.entities[1].pos_mm = [3000.5, 400, 2000];
    expect(parses(s)).toBe(false);
    const t = clone();
    t.controller.radius_mm = '300';
    expect(parses(t)).toBe(false);
  });

  it('rejects coordinates beyond 1 km, so squared distances stay exact', () => {
    const s = clone();
    s.entities[1].pos_mm = [1_000_001, 400, 2000];
    expect(parses(s)).toBe(false);
    s.entities[1].pos_mm = [1_000_000, 400, 2000];
    expect(parses(s)).toBe(true);
  });

  it('rejects unknown keys, a wrong version and missing sections', () => {
    const extra = clone();
    extra.entities[0].colour = 'red';
    expect(parses(extra)).toBe(false);
    const version = clone();
    version.scene = 'scene-gate/2';
    expect(parses(version)).toBe(false);
    const missing = clone();
    delete missing.objectives;
    expect(parses(missing)).toBe(false);
  });

  it('requires a door to name its key and nothing else to carry door fields', () => {
    const door = clone();
    delete door.entities[7].requires;
    expect(parses(door)).toBe(false);
    const crate = clone();
    crate.entities[1].requires = 'key_red';
    expect(parses(crate)).toBe(false);
  });

  it('rejects empty and zero-sized boxes, bad events, unknown kinds and zero counts', () => {
    const size = clone();
    size.entities[1].box_mm = [800, 0, 800];
    expect(parses(size)).toBe(false);
    const event = clone();
    event.rules[0].on = 'collect:';
    expect(parses(event)).toBe(false);
    const verb = clone();
    verb.rules[0].on = 'touch:coin_1';
    expect(parses(verb)).toBe(false);
    const kind = clone();
    kind.entities[1].kind = 'enemy';
    expect(parses(kind)).toBe(false);
    const count = clone();
    count.objectives[0].count = 0;
    expect(parses(count)).toBe(false);
  });

  it('rejects ids with spaces or slashes', () => {
    const s = clone();
    s.entities[1].id = 'crate 1';
    expect(parses(s)).toBe(false);
    s.entities[1].id = 'crate/1';
    expect(parses(s)).toBe(false);
  });
});

describe('the JSON Schema export', () => {
  const schema = sceneJsonSchema() as any;

  it('describes the same closed object, with integers throughout', () => {
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.scene.const).toBe('scene-gate/1');
    expect(schema.required).toEqual(['scene', 'bounds_mm', 'controller', 'spawn', 'entities', 'rules', 'objectives']);
    expect(JSON.stringify(schema)).not.toContain('"type":"number"');
  });

  it('matches the committed schema/scene-gate-1.json byte for byte', () => {
    expect(readFileSync(SCHEMA_PATH, 'utf8')).toBe(renderSchemaFile());
  });
});
