import type { Diagnostic } from './diagnostic.ts';

export type Verdict = 'PASS' | 'FAIL' | 'ABSTAIN';

/** `ran`: executed to completion. `not_checked`: not asked for or not applicable. `abstained`: could not finish. */
export type CheckStatus = 'ran' | 'not_checked' | 'abstained';

export interface CheckRecord {
  status: CheckStatus;
  /** Why a check is not_checked or abstained. */
  reason?: string;
}

export const EXIT_CODES = { PASS: 0, FAIL: 1, ABSTAIN: 2, USAGE: 3 } as const;

export const exitCodeFor = (v: Verdict): number => EXIT_CODES[v];

/**
 * FAIL if any error diagnostic exists (a definite failure stays definite). Otherwise ABSTAIN if any check
 * abstained, because a check that cannot finish must never read as PASS. Otherwise PASS.
 * `not_checked` never counts as a pass and never blocks one: reports list it explicitly.
 */
export function deriveVerdict(diagnostics: readonly Diagnostic[], checks: Readonly<Record<string, CheckRecord>>): Verdict {
  if (diagnostics.some((d) => d.severity === 'error')) return 'FAIL';
  if (Object.values(checks).some((c) => c.status === 'abstained')) return 'ABSTAIN';
  return 'PASS';
}
