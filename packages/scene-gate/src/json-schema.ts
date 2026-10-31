import { z } from 'zod';
import { SceneSchema } from './schema.ts';

/**
 * JSON Schema exports of the scene schema.
 *
 * `full` is the reference: draft 2020-12, fixed-length arrays as `items` + `minItems`/`maxItems`, unions as `anyOf`.
 * Structured-output endpoints accept only a subset of JSON Schema, and the two subsets differ, so each provider gets
 * a profile with the keywords it rejects removed. A removed constraint is written into the node's description, as the
 * Anthropic SDKs do, and is still enforced afterwards by the zod schema (a violation is `schema_invalid`).
 *
 * Sources, read 2026-11-01:
 * - Claude: https://platform.claude.com/docs/en/build-with-claude/structured-outputs ("Supported features",
 *   "Not supported"): numerical constraints, string length constraints, array constraints beyond `minItems` 0 or 1
 *   are rejected with a 400; `const`, `enum`, `anyOf`, `pattern` (simple regex), `required` and
 *   `additionalProperties: false` are supported. `oneOf`, `prefixItems`, `maxItems`, `$schema`, `$id` and `title` are
 *   not documented, so the Claude profile does not use them.
 * - Gemini: the `responseJsonSchema` description (https://googleapis.github.io/kotlin-genai/google-genai-kotlin/com.google.genai.kotlin.types/-generate-content-config/response-json-schema.html)
 *   lists the only supported properties: $id, $defs, $ref, $anchor, type, format, title, description, enum, items,
 *   prefixItems, minItems, maxItems, minimum, maximum, anyOf, oneOf, properties, additionalProperties, required.
 *   `const`, `pattern` and `$schema` are not on it, so the Gemini profile does not use them.
 */
export type SchemaProfile = 'full' | 'claude' | 'gemini';
export const SCHEMA_PROFILES: readonly SchemaProfile[] = ['full', 'claude', 'gemini'];

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Applies `fn` to a schema node and, first, to every sub-schema below it. Property names are never treated as keywords. */
function mapSchema(node: unknown, fn: (n: Node) => Node): unknown {
  if (!isNode(node)) return node;
  const out: Node = { ...node };
  for (const key of ['properties', '$defs']) {
    const group = out[key];
    if (isNode(group)) out[key] = Object.fromEntries(Object.entries(group).map(([k, v]) => [k, mapSchema(v, fn)]));
  }
  for (const key of ['items', 'additionalProperties']) {
    if (isNode(out[key])) out[key] = mapSchema(out[key], fn);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const list = out[key];
    if (Array.isArray(list)) out[key] = list.map((v) => mapSchema(v, fn));
  }
  return fn(out);
}

const describe = (node: Node, note: string): Node => ({ ...node, description: node.description ? `${String(node.description)} ${note}` : note });

const range = (lo: unknown, hi: unknown, unit: string): string =>
  lo !== undefined && hi !== undefined ? (lo === hi ? `exactly ${String(lo)}${unit}` : `${String(lo)} to ${String(hi)}${unit}`) : lo !== undefined ? `at least ${String(lo)}${unit}` : `at most ${String(hi)}${unit}`;

/** Removes the given keywords and says in the description what they required, in words. */
function dropWithNote(node: Node, keys: readonly string[]): Node {
  const has = (k: string): boolean => keys.includes(k) && k in node;
  const notes: string[] = [];
  if (has('minimum') || has('maximum')) notes.push(range(node.minimum, node.maximum, ''));
  if (has('minLength') || has('maxLength')) notes.push(range(node.minLength, node.maxLength, ' characters'));
  if (has('minItems') || has('maxItems')) notes.push(range(node.minItems, node.maxItems, ' items'));
  if (has('pattern')) notes.push(`matches ${String(node.pattern)}`);
  const out: Node = { ...node };
  for (const k of keys) delete out[k];
  return notes.length ? describe(out, `(${notes.join(', ')})`) : out;
}

/** oneOf -> anyOf (the unions are discriminated, so they are exclusive anyway); tuples -> items + minItems/maxItems. */
function normalize(node: Node): Node {
  const out: Node = { ...node };
  if (Array.isArray(out.oneOf)) {
    out.anyOf = out.oneOf;
    delete out.oneOf;
  }
  if (Array.isArray(out.prefixItems)) {
    const [first, ...rest] = out.prefixItems as unknown[];
    if (rest.some((r) => JSON.stringify(r) !== JSON.stringify(first))) throw new Error('a tuple with different element schemas has no items form');
    out.items = first;
    out.minItems = out.maxItems = (out.prefixItems as unknown[]).length;
    delete out.prefixItems;
  }
  return out;
}

function forClaude(node: Node): Node {
  const dropped = ['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems', ...(typeof node.minItems === 'number' && node.minItems > 1 ? ['minItems'] : [])];
  const out = dropWithNote(node, dropped);
  for (const key of ['$schema', '$id', 'title']) delete out[key];
  return out;
}

function forGemini(node: Node): Node {
  const out = dropWithNote(node, ['pattern', 'minLength', 'maxLength']);
  if ('const' in out) {
    out.enum = [out.const];
    delete out.const;
  }
  for (const key of ['$schema', '$id']) delete out[key];
  return out;
}

export function sceneJsonSchema(profile: SchemaProfile = 'full'): Record<string, unknown> {
  const raw = z.toJSONSchema(SceneSchema, { target: 'draft-2020-12', io: 'input' }) as Node;
  const full = mapSchema(raw, normalize) as Node;
  if (profile === 'full') return { $id: 'https://kensho.invalid/scene-gate-1.json', title: 'scene-gate/1', ...full };
  const strip = profile === 'claude' ? forClaude : forGemini;
  return mapSchema({ title: 'scene-gate/1', ...full }, strip) as Node;
}
