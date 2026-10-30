import { createHash } from 'node:crypto';
import { DOMAINS, hashRecord, type Json } from '@kensho/ir';
import { deriveVerdict, sortDiagnostics, type CheckRecord, type Diagnostic } from '@kensho/diagnostics';
import { CHECKS, CHECK_NEEDS_GEOMETRY, abstained, makeCtx } from './checks.ts';
import {
  CHECK_IDS,
  DEFAULT_OPTIONS,
  GATE_ID,
  GATE_VERSION,
  REPORT_FORMAT,
  type AssetGateOptions,
  type AssetGateReport,
  type CheckId,
  type CheckOutput,
  type TestHooks,
} from './types.ts';

export type CheckListener = (id: CheckId, out: CheckOutput, ms: number) => void;

/** Fills defaults so callers can pass only what they know. */
export const resolveOptions = (o: Pick<AssetGateOptions, 'tier'> & Partial<AssetGateOptions>): AssetGateOptions => ({
  tier: o.tier,
  assetClass: o.assetClass ?? DEFAULT_OPTIONS.assetClass,
  body: o.body ?? DEFAULT_OPTIONS.body,
  ...(o.boxUm ? { boxUm: o.boxUm } : {}),
});

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The checks a hook list names, for the record. */
export const hookNames = (hooks?: TestHooks): string[] =>
  hooks ? Object.entries(hooks).flatMap(([kind, ids]) => (ids as CheckId[]).map((id) => `${kind}:${id}`)).sort() : [];

/**
 * Runs every check in order, in this thread. A check that throws becomes `abstained`; nothing here can
 * turn a failure to run into a pass. Findings are streamed through `onCheck` as each check completes.
 */
export async function runChecks(
  bytes: Uint8Array,
  options: AssetGateOptions,
  hooks: TestHooks = {},
  onCheck?: CheckListener,
): Promise<Map<CheckId, CheckOutput>> {
  const ctx = makeCtx(bytes, options);
  const results = new Map<CheckId, CheckOutput>();
  for (const id of CHECK_IDS) {
    const t0 = performance.now();
    let out: CheckOutput;
    try {
      const parse = results.get('parse');
      if (id !== 'validator' && id !== 'parse' && parse && parse.record.status !== 'ran') {
        out = { record: { status: ctx.validatorErrors > 0 ? 'not_checked' : 'abstained', reason: 'asset could not be parsed' }, diagnostics: [], measures: {} };
      } else if (hooks.crash?.includes(id)) {
        throw new Error(`test hook: ${id} crashed`);
      } else if (hooks.stall?.includes(id)) {
        // a pending promise alone would let the worker exit early; keep the event loop alive so it truly hangs
        await new Promise<never>(() => {
          setInterval(() => {}, 1 << 30);
        });
        throw new Error('unreachable');
      } else if (hooks.spin?.includes(id)) {
        for (;;) {
          /* hang the thread */
        }
      } else {
        out = await CHECKS[id](ctx);
        if (hooks.neutralize?.includes(id)) out = { record: out.record, diagnostics: [], measures: {} };
      }
    } catch (e) {
      out = abstained(`crashed: ${e instanceof Error ? e.message : String(e)}`);
    }
    results.set(id, out);
    onCheck?.(id, out, performance.now() - t0);
  }
  return results;
}

/** Builds the final report. Any check without a result is recorded as abstained with `missingReason`. */
export function assembleReport(
  bytes: Uint8Array,
  options: AssetGateOptions,
  results: ReadonlyMap<CheckId, CheckOutput>,
  timings: Record<string, number>,
  hooks: TestHooks | undefined,
  missingReason: string,
): AssetGateReport {
  const checks: Record<string, CheckRecord> = {};
  const diagnostics: Diagnostic[] = [];
  const measures: { [k: string]: Json } = {};
  for (const id of CHECK_IDS) {
    const out = results.get(id) ?? abstained(missingReason);
    checks[id] = out.record;
    diagnostics.push(...out.diagnostics);
    Object.assign(measures, out.measures);
  }
  const sorted = sortDiagnostics(diagnostics);
  const verdict = deriveVerdict(sorted, checks);
  const opts = {
    tier: options.tier,
    class: options.assetClass,
    body: options.body,
    box_um: options.boxUm ?? null,
  };
  const input = { sha256: sha256(bytes), bytes: bytes.length };
  const verdict_hash = hashRecord(DOMAINS.verdict, {
    kensho: REPORT_FORMAT,
    gate: GATE_ID,
    gate_version: GATE_VERSION,
    input,
    options: opts,
    verdict,
    diagnostics: sorted as unknown as Json,
    measures,
    checks: checks as unknown as Json,
  });
  return {
    kensho: REPORT_FORMAT,
    gate: GATE_ID,
    gate_version: GATE_VERSION,
    input,
    options: opts as AssetGateReport['options'],
    verdict,
    diagnostics: sorted,
    measures,
    checks,
    verdict_hash,
    timings_ms: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
    test_hooks: hookNames(hooks),
  };
}

/** The whole gate, in this thread and without a deadline. Used by tests; production goes through `runAssetGate`. */
export async function runAssetGateInline(bytes: Uint8Array, options: AssetGateOptions, hooks?: TestHooks): Promise<AssetGateReport> {
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  const results = await runChecks(bytes, options, hooks, (id, _out, ms) => {
    timings[id] = ms;
  });
  timings.total = performance.now() - t0;
  return assembleReport(bytes, options, results, timings, hooks, 'check did not run');
}

export { CHECK_NEEDS_GEOMETRY };
