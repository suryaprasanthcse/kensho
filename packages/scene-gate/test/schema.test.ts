import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCHEMA_PROFILES, sceneJsonSchema, type SchemaProfile } from '../src/json-schema.ts';
import { SceneSchema } from '../src/schema.ts';
import { renderSchemaFile, schemaPath } from '../src/write-schema.ts';
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

type Node = Record<string, any>;

/** Every schema keyword used anywhere in the export (property names are not keywords). */
function keywords(node: unknown, found = new Set<string>()): Set<string> {
  if (typeof node !== 'object' || node === null) return found;
  if (Array.isArray(node)) {
    node.forEach((n) => keywords(n, found));
    return found;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties') Object.values(value as Node).forEach((v) => keywords(v, found));
    else if (key === 'enum' || key === 'required' || key === 'const') found.add(key);
    else {
      found.add(key);
      if (key === 'items' || key === 'additionalProperties' || key === 'anyOf') keywords(value, found);
    }
  }
  return found;
}

/** Every schema node, so each array node can be inspected. */
function nodes(node: unknown, found: Node[] = []): Node[] {
  if (typeof node !== 'object' || node === null) return found;
  if (Array.isArray(node)) {
    node.forEach((n) => nodes(n, found));
    return found;
  }
  const n = node as Node;
  found.push(n);
  Object.values(n.properties ?? {}).forEach((v) => nodes(v, found));
  nodes(n.items, found);
  nodes(n.anyOf, found);
  return found;
}

describe('the JSON Schema exports', () => {
  const schemas = Object.fromEntries(SCHEMA_PROFILES.map((p) => [p, sceneJsonSchema(p) as Node])) as Record<SchemaProfile, Node>;

  it.each(SCHEMA_PROFILES)('%s: is one closed object with integers throughout', (profile) => {
    const schema = schemas[profile];
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['scene', 'bounds_mm', 'controller', 'spawn', 'entities', 'rules', 'objectives']);
    expect(JSON.stringify(schema)).not.toContain('"type":"number"');
  });

  it.each(SCHEMA_PROFILES)('%s: has no prefixItems and no oneOf', (profile) => {
    const used = keywords(schemas[profile]);
    expect(used.has('prefixItems')).toBe(false);
    expect(used.has('oneOf')).toBe(false);
    expect(used.has('anyOf')).toBe(true);
  });

  it('full: writes every fixed-length array as items plus equal minItems and maxItems', () => {
    const arrays = nodes(schemas.full).filter((n) => n.type === 'array');
    const fixed = arrays.filter((n) => n.minItems !== undefined);
    expect(fixed.length).toBeGreaterThan(0);
    for (const a of fixed) {
      expect(a.items).toBeTypeOf('object');
      expect(a.minItems).toBe(a.maxItems);
    }
    expect(schemas.full.properties.bounds_mm).toMatchObject({ type: 'array', minItems: 6, maxItems: 6, items: { type: 'integer' } });
    expect(schemas.full.properties.spawn.properties.pos_mm).toMatchObject({ minItems: 3, maxItems: 3 });
  });

  it('full: keeps the unions discriminated by a constant', () => {
    const kinds = schemas.full.properties.entities.items.anyOf.map((v: Node) => v.properties.kind.const);
    expect(kinds).toEqual(['static', 'dynamic', 'door', 'pickup', 'key']);
    const types = schemas.full.properties.objectives.items.anyOf.map((v: Node) => v.properties.type.const);
    expect(types).toEqual(['collect', 'reach', 'unlock']);
  });

  // https://platform.claude.com/docs/en/build-with-claude/structured-outputs, read 2026-11-01: supported are basic types,
  // enum, const, anyOf, $ref, default, required, additionalProperties false, string formats, minItems of 0 or 1, and
  // simple regex patterns. Numerical constraints, string length constraints and array constraints beyond minItems 0/1
  // return a 400. oneOf, prefixItems, maxItems, $schema, $id and title are not documented, so they are kept out.
  it('claude: uses only keywords the Claude docs list as supported', () => {
    const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'enum', 'const', 'pattern', 'description']);
    expect([...keywords(schemas.claude)].filter((k) => !allowed.has(k))).toEqual([]);
    for (const n of nodes(schemas.claude)) expect(n.minItems ?? 0).toBeLessThanOrEqual(1);
  });

  it('claude: states the removed constraints in the description so the model still sees them', () => {
    expect(schemas.claude.properties.bounds_mm.description).toContain('exactly 6 items');
    expect(schemas.claude.properties.bounds_mm.items.description).toBe('(-1000000 to 1000000)');
    expect(schemas.claude.properties.entities.description).toContain('at most 500 items');
  });

  // https://googleapis.github.io/kotlin-genai/google-genai-kotlin/com.google.genai.kotlin.types/-generate-content-config/response-json-schema.html,
  // read 2026-11-01: only $id, $defs, $ref, $anchor, type, format, title, description, enum, items, prefixItems, minItems,
  // maxItems, minimum, maximum, anyOf, oneOf, properties, additionalProperties and required are supported.
  it('gemini: uses only keywords the Gemini docs list as supported', () => {
    const allowed = new Set(['$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required']);
    expect([...keywords(schemas.gemini)].filter((k) => !allowed.has(k))).toEqual([]);
  });

  it('gemini: keeps the caps on fixed-length tuples but not on long lists, which make the grammar too big', () => {
    for (const n of nodes(schemas.gemini).filter((x) => x.type === 'array')) expect(n.maxItems ?? 0).toBeLessThanOrEqual(6);
    expect(schemas.gemini.properties.entities.maxItems).toBeUndefined();
    expect(schemas.gemini.properties.entities.description).toContain('at most 500 items');
    expect(schemas.full.properties.entities.maxItems).toBe(500);
  });

  it('gemini: keeps fixed-length arrays and integer ranges, and turns const into a one-value enum', () => {
    expect(schemas.gemini.properties.bounds_mm).toMatchObject({ minItems: 6, maxItems: 6 });
    expect(schemas.gemini.properties.bounds_mm.items).toMatchObject({ type: 'integer', minimum: -1000000, maximum: 1000000 });
    expect(schemas.gemini.properties.scene).toEqual({ type: 'string', enum: ['scene-gate/1'] });
    expect(schemas.gemini.properties.rules.items.properties.on.description).toContain('matches ^(collect|enter|open|signal):');
  });

  it.each(SCHEMA_PROFILES)('%s: matches the committed file byte for byte', (profile) => {
    expect(readFileSync(schemaPath(profile), 'utf8')).toBe(renderSchemaFile(profile));
  });
});
