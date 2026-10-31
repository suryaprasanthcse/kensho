import { isJsonPointer, pointerFrom } from '@kensho/diagnostics';
import { canonicalJson, compareCodeUnits } from './canonical.ts';

export { pointerFrom };

export type Severity = 'error' | 'warning';

/** Integers, strings, booleans and flat arrays of them, so the evidence can be hashed. */
export type EvidenceValue = string | number | boolean | readonly (string | number)[];

/**
 * `{code, severity, pointer, message, evidence}`, where `pointer` is an RFC 6901 JSON Pointer into the scene.
 * This is not `@kensho/diagnostics`' Diagnostic: that one requires a `gate` from a closed set and can only be built
 * for registered codes (see DECISIONS.md).
 */
export interface Diagnostic {
  readonly code: string;
  readonly severity: Severity;
  readonly pointer: string;
  readonly message: string;
  readonly evidence: Readonly<Record<string, EvidenceValue>>;
}

/** The semantic codes, in table order. SCHEMA_INVALID is reported separately and is not one of them. */
export const SEMANTIC_CODES = [
  'DUPLICATE_ID',
  'UNRESOLVED_REF',
  'OBJECTIVE_COUNT',
  'RULE_CYCLE',
  'PROGRESSION_CYCLE',
  'SPATIAL_OVERLAP',
  'SPAWN_OBSTRUCTED',
  'UNSUPPORTED_DYNAMIC',
  'OUT_OF_BOUNDS',
  'UNREACHABLE_HEIGHT',
] as const;
export type SemanticCode = (typeof SEMANTIC_CODES)[number];

export const SCHEMA_INVALID = 'SCHEMA_INVALID';

export function diag(
  code: string,
  pointer: string,
  message: string,
  evidence: Record<string, EvidenceValue> = {},
  severity: Severity = 'error',
): Diagnostic {
  if (!isJsonPointer(pointer)) throw new TypeError(`${code}: invalid RFC 6901 pointer ${JSON.stringify(pointer)}`);
  const walk = (v: EvidenceValue): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'number' && !Number.isInteger(v)) throw new TypeError(`${code}: non-integer evidence ${v}`);
  };
  Object.values(evidence).forEach(walk);
  return { code, severity, pointer, message, evidence };
}

/**
 * Deterministic order: by pointer, then by code. Ties (several findings at one pointer with one code) fall back to
 * message and canonical evidence, so the order never depends on the input order.
 */
export function sortDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
  return [...list].sort(
    (a, b) =>
      compareCodeUnits(a.pointer, b.pointer) ||
      compareCodeUnits(a.code, b.code) ||
      compareCodeUnits(a.message, b.message) ||
      compareCodeUnits(canonicalJson(a.evidence), canonicalJson(b.evidence)),
  );
}
