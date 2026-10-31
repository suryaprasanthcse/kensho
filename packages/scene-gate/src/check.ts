import { checkDuplicateId } from './checks/duplicate-id.ts';
import { checkObjectiveCount } from './checks/objective-count.ts';
import { checkOutOfBounds } from './checks/out-of-bounds.ts';
import { checkProgressionCycle } from './checks/progression-cycle.ts';
import { checkRuleCycle } from './checks/rule-cycle.ts';
import { checkSpatialOverlap } from './checks/spatial-overlap.ts';
import { checkSpawnObstructed } from './checks/spawn-obstructed.ts';
import { checkUnreachableHeight } from './checks/unreachable-height.ts';
import { checkUnresolvedRef } from './checks/unresolved-ref.ts';
import { checkUnsupportedDynamic } from './checks/unsupported-dynamic.ts';
import { SCHEMA_INVALID, diag, pointerFrom, sortDiagnostics, type Diagnostic, type SemanticCode } from './diagnostic.ts';
import { parseRawOutput, type InvalidReason } from './parse.ts';
import { SceneSchema, type Scene } from './schema.ts';

export interface CheckOptions {
  /** Run UNREACHABLE_HEIGHT. Off by default. */
  readonly unreachableHeight?: boolean;
}

export interface CheckEntry {
  readonly code: SemanticCode;
  /** The module under src/checks, without extension. The mutation runner swaps these files out one by one. */
  readonly file: string;
  readonly optional?: 'unreachableHeight';
  readonly run: (scene: Scene) => Diagnostic[];
}

export const CHECKS: readonly CheckEntry[] = [
  { code: 'DUPLICATE_ID', file: 'duplicate-id', run: checkDuplicateId },
  { code: 'UNRESOLVED_REF', file: 'unresolved-ref', run: checkUnresolvedRef },
  { code: 'OBJECTIVE_COUNT', file: 'objective-count', run: checkObjectiveCount },
  { code: 'RULE_CYCLE', file: 'rule-cycle', run: checkRuleCycle },
  { code: 'PROGRESSION_CYCLE', file: 'progression-cycle', run: checkProgressionCycle },
  { code: 'SPATIAL_OVERLAP', file: 'spatial-overlap', run: checkSpatialOverlap },
  { code: 'SPAWN_OBSTRUCTED', file: 'spawn-obstructed', run: checkSpawnObstructed },
  { code: 'UNSUPPORTED_DYNAMIC', file: 'unsupported-dynamic', run: checkUnsupportedDynamic },
  { code: 'OUT_OF_BOUNDS', file: 'out-of-bounds', run: checkOutOfBounds },
  { code: 'UNREACHABLE_HEIGHT', file: 'unreachable-height', optional: 'unreachableHeight', run: checkUnreachableHeight },
];

/** Runs every enabled check on a schema-valid scene and returns the diagnostics sorted by pointer, then code. */
export function checkScene(scene: Scene, options: CheckOptions = {}): Diagnostic[] {
  const all: Diagnostic[] = [];
  for (const entry of CHECKS) {
    if (entry.optional && !options[entry.optional]) continue;
    all.push(...entry.run(scene));
  }
  return sortDiagnostics(all);
}

export type Evaluation =
  | { readonly kind: 'schema_invalid'; readonly reason: InvalidReason; readonly diagnostics: Diagnostic[] }
  | { readonly kind: 'checked'; readonly scene: Scene; readonly diagnostics: Diagnostic[] };

const MAX_SCHEMA_ISSUES = 50;

const schemaInvalid = (reason: InvalidReason, diagnostics: Diagnostic[]): Evaluation => ({
  kind: 'schema_invalid',
  reason,
  diagnostics: sortDiagnostics(diagnostics),
});

/** Validates an already parsed value against the schema, then runs the checks. */
export function evaluateValue(value: unknown, options: CheckOptions = {}): Evaluation {
  const parsed = SceneSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, MAX_SCHEMA_ISSUES)
      .map((i) => diag(SCHEMA_INVALID, pointerFrom(...i.path.map((p) => String(p))), i.message, { reason: 'schema', issue: i.code }));
    return schemaInvalid('schema', issues);
  }
  return { kind: 'checked', scene: parsed.data, diagnostics: checkScene(parsed.data, options) };
}

/** Parses raw model output (strictly), validates it, then runs the checks. Never throws on bad model output. */
export function evaluateRaw(text: string, options: CheckOptions = {}, finishReason?: string | null): Evaluation {
  const raw = parseRawOutput(text, finishReason);
  if (!raw.ok) return schemaInvalid(raw.reason, [diag(SCHEMA_INVALID, '', raw.detail, { reason: raw.reason })]);
  return evaluateValue(raw.value, options);
}
