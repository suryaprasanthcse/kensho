import { createRequire } from 'node:module';
import type { Operation } from 'fast-json-patch';
import { evaluateValue, type CheckOptions } from './check.ts';
import type { Diagnostic } from './diagnostic.ts';
import type { Objective, Scene } from './schema.ts';

// fast-json-patch is CommonJS without statically detectable named exports, so load it through require
const { applyPatch, validate } = createRequire(import.meta.url)('fast-json-patch') as typeof import('fast-json-patch');

export type JsonPatch = Operation[];

export type RefusalReason =
  | 'original_schema_invalid'
  | 'invalid_patch'
  | 'patch_failed'
  | 'schema_invalid_after_patch'
  | 'objective_removed'
  | 'objective_weakened'
  | 'new_code'
  | 'not_shrinking';

export type RepairResult =
  | { readonly status: 'accepted'; readonly scene: Scene; readonly before: Diagnostic[]; readonly after: Diagnostic[] }
  | { readonly status: 'refused'; readonly reason: RefusalReason; readonly detail: string };

const refuse = (reason: RefusalReason, detail: string): RepairResult => ({ status: 'refused', reason, detail });

const errorCodeCounts = (list: readonly Diagnostic[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const d of list) if (d.severity === 'error') m.set(d.code, (m.get(d.code) ?? 0) + 1);
  return m;
};

/**
 * A patch may not make an objective easier. Objectives are matched by id. Each must survive with the same type; a
 * collect objective keeps its tag and may not lower its count; a reach or unlock objective keeps its target.
 * Changing a tag or a target is refused because it dodges a failing check just as lowering a count does.
 */
function weakenedObjective(before: readonly Objective[], after: readonly Objective[]): RepairResult | null {
  for (const o of before) {
    const n = after.find((x) => x.id === o.id);
    if (!n) return refuse('objective_removed', `objective ${o.id} was removed`);
    if (n.type !== o.type) return refuse('objective_weakened', `objective ${o.id} changed type from ${o.type} to ${n.type}`);
    if (o.type === 'collect' && n.type === 'collect') {
      if (n.tag !== o.tag) return refuse('objective_weakened', `objective ${o.id} changed its tag from "${o.tag}" to "${n.tag}"`);
      if (n.count < o.count) return refuse('objective_weakened', `objective ${o.id} lowered its count from ${o.count} to ${n.count}`);
    } else if (o.type !== 'collect' && n.type !== 'collect' && n.target !== o.target) {
      return refuse('objective_weakened', `objective ${o.id} changed its target from "${o.target}" to "${n.target}"`);
    }
  }
  return null;
}

/**
 * Applies an RFC 6902 patch to a copy of the scene and accepts the result only if all of these hold:
 * - the patch is well formed, applies cleanly, and the result is still schema-valid;
 * - no objective is removed or made easier;
 * - no code appears that the scene did not already have (any severity);
 * - the multiset of error codes shrinks strictly: no code occurs more often than before, and at least one occurs less.
 * The input scene is never modified.
 */
export function applyRepair(scene: unknown, patch: unknown, options: CheckOptions = {}): RepairResult {
  const original = evaluateValue(scene, options);
  if (original.kind !== 'checked') return refuse('original_schema_invalid', 'only a schema-valid scene can be repaired');

  const malformed = validate(patch as Operation[]);
  if (malformed) return refuse('invalid_patch', malformed.message);

  let patched: unknown;
  try {
    patched = applyPatch(structuredClone(original.scene), patch as Operation[], true, true).newDocument;
  } catch (error) {
    return refuse('patch_failed', error instanceof Error ? error.message : String(error));
  }

  const repaired = evaluateValue(patched, options);
  if (repaired.kind !== 'checked') {
    return refuse('schema_invalid_after_patch', repaired.diagnostics[0]?.message ?? 'the patched scene is not schema-valid');
  }

  const weakened = weakenedObjective(original.scene.objectives, repaired.scene.objectives);
  if (weakened) return weakened;

  const knownCodes = new Set(original.diagnostics.map((d) => d.code));
  const fresh = [...new Set(repaired.diagnostics.map((d) => d.code))].filter((c) => !knownCodes.has(c));
  if (fresh.length) return refuse('new_code', `the patch introduced ${fresh.join(', ')}`);

  const before = errorCodeCounts(original.diagnostics);
  const after = errorCodeCounts(repaired.diagnostics);
  const grew = [...after].filter(([code, n]) => n > (before.get(code) ?? 0)).map(([code]) => code);
  const total = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
  if (grew.length) return refuse('not_shrinking', `${grew.join(', ')} occurs more often than before`);
  if (total(after) >= total(before)) return refuse('not_shrinking', 'the error codes did not strictly shrink');

  return { status: 'accepted', scene: repaired.scene, before: original.diagnostics, after: repaired.diagnostics };
}
