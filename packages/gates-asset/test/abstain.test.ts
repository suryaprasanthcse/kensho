import { describe, expect, it } from 'vitest';
import { buildFixture } from '@kensho/synthetic_oracle';
import { runAssetGate } from '../src/index.ts';

const control = async () => {
  const fx = await buildFixture('CONTROL-02');
  return { bytes: fx.bytes, options: { tier: fx.options.tier, assetClass: fx.options.class, body: fx.options.body } };
};

describe('fail closed under a deadline', () => {
  it('a check that never finishes yields ABSTAIN, with earlier checks kept and later ones abstained', async () => {
    const { bytes, options } = await control();
    const t0 = Date.now();
    const r = await runAssetGate(bytes, options, { timeoutMs: 4000, hooks: { stall: ['textures'] } });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.verdict).toBe('ABSTAIN');
    expect(r.checks.validator?.status).toBe('ran');
    expect(r.checks.triangles?.status).toBe('ran');
    expect(r.checks.textures?.status).toBe('abstained');
    expect(r.checks.collider?.status).toBe('abstained');
    expect(r.checks.collider?.reason).toMatch(/deadline/);
    expect(r.test_hooks).toEqual(['stall:textures']);
  });

  it('a check that hangs the thread is terminated and abstained', async () => {
    const { bytes, options } = await control();
    const r = await runAssetGate(bytes, options, { timeoutMs: 4000, hooks: { spin: ['finite'] } });
    expect(r.verdict).toBe('ABSTAIN');
    expect(r.checks.finite?.status).toBe('abstained');
  });

  it('a definite error found before the deadline still FAILs', async () => {
    const fx = await buildFixture('TRIANGLE_BUDGET-00');
    const r = await runAssetGate(fx.bytes, { tier: fx.options.tier, assetClass: fx.options.class, body: fx.options.body }, { timeoutMs: 4000, hooks: { stall: ['collider'] } });
    expect(r.verdict).toBe('FAIL');
    expect(r.diagnostics.map((d) => d.code)).toContain('TRIANGLE_BUDGET');
    expect(r.checks.collider?.status).toBe('abstained');
  });

  it('a deadline too short for the worker to start abstains every check', async () => {
    const { bytes, options } = await control();
    const r = await runAssetGate(bytes, options, { timeoutMs: 1 });
    expect(r.verdict).toBe('ABSTAIN');
    expect(Object.values(r.checks).every((c) => c.status === 'abstained')).toBe(true);
  });

  it('the same input through the worker and inline gives the same verdict hash', async () => {
    const { bytes, options } = await control();
    const viaWorker = await runAssetGate(bytes, options);
    const { runAssetGateInline } = await import('../src/index.ts');
    const inline = await runAssetGateInline(bytes, options);
    expect(viaWorker.verdict).toBe('PASS');
    expect(viaWorker.verdict_hash).toBe(inline.verdict_hash);
  });
});
