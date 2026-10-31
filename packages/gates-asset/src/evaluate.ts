import type { AssetGateReport } from './types.ts';

export interface ExpectedLabel {
  verdict: 'PASS' | 'FAIL';
  codes: string[];
  allowed: string[];
  /** The prune autofix must have run and been proven sound. */
  autofix?: 'sound';
}

export interface Evaluation {
  ok: boolean;
  problems: string[];
  /** Codes the label requires that the report lacks. */
  missing: string[];
  /** Codes the report carries that the label neither requires nor allows. */
  unexpected: string[];
  /** Label said FAIL, report said PASS: the one outcome that must never happen. */
  falsePass: boolean;
}

/**
 * Compares a report with a fixture's label. A clean control must also have derived a collider, so a gate
 * that stopped doing so is noticed.
 */
export function evaluateReport(report: AssetGateReport, expected: ExpectedLabel, isControl: boolean): Evaluation {
  const codes = [...new Set(report.diagnostics.map((d) => d.code))];
  const missing = expected.codes.filter((c) => !codes.includes(c));
  const unexpected = codes.filter((c) => !expected.codes.includes(c) && !expected.allowed.includes(c));
  const problems: string[] = [];
  if (report.verdict !== expected.verdict) problems.push(`verdict ${report.verdict}, expected ${expected.verdict}`);
  if (missing.length) problems.push(`missing ${missing.join(',')}`);
  if (unexpected.length) problems.push(`unexpected ${unexpected.join(',')}`);
  const abstained = Object.entries(report.checks).filter(([, c]) => c.status === 'abstained').map(([id]) => id);
  if (abstained.length) problems.push(`abstained: ${abstained.join(',')}`);
  if (expected.autofix === 'sound') {
    const fix = report.measures.autofix as { applied?: number; sound?: number } | undefined;
    if (fix?.applied !== 1 || fix?.sound !== 1) problems.push('the prune autofix did not run soundly');
  }
  if (isControl && expected.verdict === 'PASS') {
    const collider = report.measures.collider as { kind?: string } | undefined;
    if (!collider?.kind) problems.push('no collider derived');
  }
  return { ok: problems.length === 0, problems, missing, unexpected, falsePass: expected.verdict === 'FAIL' && report.verdict === 'PASS' };
}
