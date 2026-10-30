import { hashRecord, type AssetProvider, type AssetRequest, type JobRef, type JobState, type RawAsset } from '@kensho/ir';
import { buildFixture } from './fixtures.ts';

export const SYNTHETIC_ORACLE_ID = 'synthetic-oracle/0.1';

const keyOf = (req: AssetRequest): string => hashRecord('kensho-asset-request-v1', { ...req, params: { ...req.params } });

/**
 * An offline provider: `params.fixture` names a fixture and `fetch` returns its bytes. No credits are
 * consumed and nothing leaves the machine.
 */
export function createSyntheticOracle(): AssetProvider {
  const jobs = new Map<string, AssetRequest>();
  return {
    id: SYNTHETIC_ORACLE_ID,
    async submit(req): Promise<JobRef> {
      const key = keyOf(req);
      jobs.set(key, req);
      return { providerId: SYNTHETIC_ORACLE_ID, key };
    },
    async poll(job): Promise<JobState> {
      return jobs.has(job.key) ? { status: 'done' } : { status: 'failed', detail: 'unknown job' };
    },
    async fetch(job): Promise<RawAsset> {
      const req = jobs.get(job.key);
      if (!req) throw new Error(`unknown job ${job.key}`);
      const id = String(req.params.fixture ?? '');
      const fx = await buildFixture(id);
      return { bytes: fx.bytes, providerId: SYNTHETIC_ORACLE_ID, paramsDigest: hashRecord('kensho-asset-params-v1', { ...req.params }), consumed: 0 };
    },
  };
}
