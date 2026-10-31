import type { CheckRecord, Diagnostic, Verdict } from '@kensho/diagnostics';
import type { Json } from '@kensho/ir';

export type Tier = 'mobile' | 'desktop';
export type AssetClass = 'hero' | 'prop' | 'background';
export type Body = 'dynamic' | 'static';

export const GATE_ID = 'G4' as const;
export const GATE_VERSION = 'g4-subset/0.1.0';
export const REPORT_FORMAT = 'kensho-asset-gate-report/1';

export interface AssetGateOptions {
  tier: Tier;
  assetClass: AssetClass;
  body: Body;
  /** Declared box in integer micrometres. Without it the conformance check is `not_checked`. */
  boxUm?: [number, number, number];
}

export const DEFAULT_OPTIONS = { assetClass: 'prop', body: 'dynamic' } as const;

/** Every check that can run, in execution order. */
export const CHECK_IDS = [
  'validator',
  'parse',
  'triangles',
  'primitives',
  'materials',
  'textures',
  'finite',
  'degenerate',
  'winding',
  'boundary',
  'nonmanifold',
  'islands',
  'bbox',
  'hull_complexity',
  'collider',
  'autofix',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** Test-only hooks. They exist so tests can prove a broken or hung check is noticed. */
export interface TestHooks {
  /** The check runs, then its findings are discarded: a gate that silently stopped noticing. */
  neutralize?: CheckId[];
  /** The check throws. */
  crash?: CheckId[];
  /** The check never finishes (an await that never resolves). */
  stall?: CheckId[];
  /** The check hangs the thread with synchronous work. */
  spin?: CheckId[];
}

export interface CheckOutput {
  record: CheckRecord;
  diagnostics: Diagnostic[];
  measures: { [key: string]: Json };
}

export interface AssetGateReport {
  kensho: typeof REPORT_FORMAT;
  gate: typeof GATE_ID;
  gate_version: string;
  input: { sha256: string; bytes: number };
  options: { tier: Tier; class: AssetClass; body: Body; box_um: [number, number, number] | null };
  verdict: Verdict;
  diagnostics: Diagnostic[];
  measures: { [key: string]: Json };
  checks: Record<string, CheckRecord>;
  verdict_hash: string;
  /** Wall-clock timings. Excluded from verdict_hash. */
  timings_ms: { [key: string]: number };
  /** Names of test hooks active for this run. Empty in production. */
  test_hooks: string[];
}
