import { parentPort, workerData } from 'node:worker_threads';
import { runChecks } from './run.ts';
import type { AssetGateOptions, TestHooks } from './types.ts';

interface Input {
  bytes: Uint8Array;
  options: AssetGateOptions;
  hooks: TestHooks;
}

const { bytes, options, hooks } = workerData as Input;
try {
  await runChecks(bytes, options, hooks, (id, out, ms) => {
    parentPort!.postMessage({ type: 'check', id, out, ms });
  });
  parentPort!.postMessage({ type: 'done' });
} catch (e) {
  parentPort!.postMessage({ type: 'fatal', message: (e as Error).message });
}
