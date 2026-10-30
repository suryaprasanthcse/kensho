import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { assembleReport } from './run.ts';
import type { AssetGateOptions, AssetGateReport, CheckId, CheckOutput, TestHooks } from './types.ts';

export const DEFAULT_TIMEOUT_MS = 60_000;

const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/**
 * Runs the asset gate in a worker thread under a hard deadline. When the deadline passes, the worker is
 * terminated, every check that had not finished is recorded as abstained, and the verdict can only be
 * FAIL (if an error was already found) or ABSTAIN. A crashed worker is treated the same way.
 */
export async function runAssetGate(
  bytes: Uint8Array,
  options: AssetGateOptions,
  opts: { timeoutMs?: number; hooks?: TestHooks } = {},
): Promise<AssetGateReport> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results = new Map<CheckId, CheckOutput>();
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  let missingReason = 'check did not finish';

  await new Promise<void>((resolve) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: { bytes, options, hooks: opts.hooks ?? {} },
      execArgv: ['--import', tsxLoader],
    });
    let settled = false;
    const finish = (reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reason) missingReason = reason;
      void worker.terminate().finally(resolve);
    };
    const timer = setTimeout(() => finish(`deadline of ${timeoutMs} ms passed`), timeoutMs);
    worker.on('message', (m: { type: string; id?: CheckId; out?: CheckOutput; ms?: number; message?: string }) => {
      if (m.type === 'check') {
        results.set(m.id!, m.out!);
        timings[m.id!] = m.ms!;
      } else if (m.type === 'done') finish();
      else if (m.type === 'fatal') finish(`worker failed: ${m.message}`);
    });
    worker.on("error", (e: Error) => finish(`worker crashed: ${e.message}`));
    worker.on('exit', (code) => finish(code === 0 ? undefined : `worker exited with code ${code}`));
  });

  timings.total = performance.now() - t0;
  return assembleReport(bytes, options, results, timings, opts.hooks, missingReason);
}
