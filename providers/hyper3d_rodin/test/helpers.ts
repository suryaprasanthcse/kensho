import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssetRequest } from '@kensho/ir';
import { Hyper3dRodinProvider, VirtualClock, startMockRodin, toAssetRequest, webPreset, type MockOptions, type MockServer, type RodinConfig } from '../src/index.ts';

export const KEY = 'test-key';

export interface Rig {
  mock: MockServer;
  provider: Hyper3dRodinProvider;
  clock: VirtualClock;
  ledgerPath: string;
  dir: string;
  cleanup(): Promise<void>;
}

/** A provider wired to a fresh local mock, a virtual clock and deterministic jitter. */
export async function rig(mockOptions: MockOptions = {}, config: Partial<RodinConfig> = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'kensho-rodin-'));
  const mock = await startMockRodin({ apiKey: KEY, ...mockOptions });
  const clock = new VirtualClock();
  const ledgerPath = join(dir, 'ledger.jsonl');
  const provider = new Hyper3dRodinProvider({
    apiKey: KEY,
    baseUrl: mock.baseUrl,
    maxCredits: 1000,
    ledgerPath,
    clock,
    random: () => 0.5,
    requestTimeoutMs: 2000,
    ...config,
  });
  return {
    mock,
    provider,
    clock,
    ledgerPath,
    dir,
    cleanup: async () => {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The web preset for prompt number `i`; the seed is the number. */
export const req = (i: number, over: Record<string, string | number | boolean> = {}): AssetRequest => {
  const r = toAssetRequest({ prompt: `wooden prop number ${i}`, seed: i, assetClass: 'prop', params: webPreset() });
  return { ...r, params: { ...r.params, ...over } };
};

export const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'RESOLVED';
  } catch (e) {
    return (e as { code?: string }).code ?? `OTHER:${(e as Error).message}`;
  }
};

/** Polls until the job is done (or failed), returning the number of polls it took. */
export async function untilDone(provider: Rig['provider'], job: Parameters<Rig['provider']['poll']>[0], max = 50): Promise<{ polls: number; status: string }> {
  for (let i = 1; i <= max; i++) {
    const s = await provider.poll(job);
    if (s.status !== 'pending') return { polls: i, status: s.status };
  }
  throw new Error('still pending');
}
