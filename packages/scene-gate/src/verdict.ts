import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.ts';
import type { Evaluation } from './check.ts';
import type { Diagnostic } from './diagnostic.ts';

export type Verdict = 'pass' | 'fail' | 'schema_invalid';

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** SHA-256 over the canonical JSON (keys sorted at every depth) of the diagnostics, in the order given. */
export const hashDiagnostics = (diagnostics: readonly Diagnostic[]): string => sha256Hex(canonicalJson(diagnostics));

/** `schema_invalid` when there is no scene to judge, `fail` when any error remains, otherwise `pass` (warnings pass). */
export const verdictOf = (evaluation: Evaluation): Verdict => {
  if (evaluation.kind === 'schema_invalid') return 'schema_invalid';
  return evaluation.diagnostics.some((d) => d.severity === 'error') ? 'fail' : 'pass';
};

export interface VerdictRecord {
  readonly verdict: Verdict;
  readonly hash: string;
  /** Distinct error codes, sorted. For schema_invalid this is `SCHEMA_INVALID` alone. */
  readonly codes: readonly string[];
}

export const verdictRecord = (evaluation: Evaluation): VerdictRecord => ({
  verdict: verdictOf(evaluation),
  hash: hashDiagnostics(evaluation.diagnostics),
  codes: [...new Set(evaluation.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code))].sort(),
});
