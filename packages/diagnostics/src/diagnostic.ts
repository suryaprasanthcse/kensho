import { createRequire } from 'node:module';
import type { Operation } from 'fast-json-patch';
import type { Json } from '@kensho/ir';
import { REGISTRY, isPlannedCode, type Gate, type Severity } from './registry.ts';

export type { Operation as JsonPatchOperation };

// fast-json-patch is CommonJS without statically detectable named exports, so load it through require
const { validate } = createRequire(import.meta.url)('fast-json-patch') as typeof import('fast-json-patch');

/** `{code, gate, severity, pointer, message, evidence, fix?}`. Evidence holds integers only, so it can be hashed. */
export interface Diagnostic {
  code: string;
  gate: Gate;
  severity: Severity;
  /** RFC 6901 JSON Pointer. For asset findings it points into the glTF JSON. */
  pointer: string;
  message: string;
  evidence: { [key: string]: Json };
  /** RFC 6902 JSON Patch. */
  fix?: Operation[];
}

const POINTER = /^(\/([^~/]|~[01])*)*$/;

/** True for a syntactically valid RFC 6901 pointer (the empty string points at the whole document). */
export const isJsonPointer = (p: string): boolean => POINTER.test(p);

export const pointerFrom = (...tokens: (string | number)[]): string =>
  tokens.map((t) => '/' + String(t).replace(/~/g, '~0').replace(/\//g, '~1')).join('');

export class DiagnosticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiagnosticError';
  }
}

export interface DiagnosticInput {
  pointer: string;
  message: string;
  evidence?: { [key: string]: Json };
  fix?: Operation[];
  /** Overrides the registry default, for codes whose severity depends on context. */
  severity?: Severity;
}

/** Builds a diagnostic for a shipped code. Planned codes, bad pointers and bad patches are refused. */
export function makeDiagnostic(code: string, input: DiagnosticInput): Diagnostic {
  const info = REGISTRY[code];
  if (!info) {
    throw new DiagnosticError(
      isPlannedCode(code) ? `code ${code} is planned and has no fixture, so it does not ship` : `unknown code ${code}`,
    );
  }
  if (!isJsonPointer(input.pointer)) throw new DiagnosticError(`${code}: invalid RFC 6901 pointer ${JSON.stringify(input.pointer)}`);
  if (input.fix) {
    const err = validate(input.fix);
    if (err) throw new DiagnosticError(`${code}: invalid RFC 6902 patch: ${err.message}`);
  }
  return {
    code,
    gate: info.gate,
    severity: input.severity ?? info.severity,
    pointer: input.pointer,
    message: input.message,
    evidence: input.evidence ?? {},
    ...(input.fix ? { fix: input.fix } : {}),
  };
}

/** Deterministic order: severity, then code, then pointer, then message. */
export function sortDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...list].sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      a.code.localeCompare(b.code, 'en') ||
      a.pointer.localeCompare(b.pointer, 'en') ||
      a.message.localeCompare(b.message, 'en'),
  );
}
