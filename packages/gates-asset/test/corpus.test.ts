import { describe, expect, it } from 'vitest';
import { CLASS_COUNTS, buildFixture, fixtureId, listFixtureIds, type Fixture } from '@kensho/synthetic_oracle';
import { CHECK_IDS, evaluateReport, runAssetGateInline, type AssetGateReport, type CheckId, type TestHooks } from '../src/index.ts';

const optionsOf = (fx: Fixture) => ({
  tier: fx.options.tier,
  assetClass: fx.options.class,
  body: fx.options.body,
  ...(fx.options.box_um ? { boxUm: fx.options.box_um } : {}),
});

async function runFixture(fx: Fixture, hooks?: TestHooks): Promise<AssetGateReport> {
  return runAssetGateInline(fx.bytes, optionsOf(fx), hooks);
}

/** Every label mismatch over a set of fixtures. This is what a "suite that notices" means in practice. */
async function mismatches(fixtures: Fixture[], hooks?: TestHooks): Promise<string[]> {
  const out: string[] = [];
  for (const fx of fixtures) {
    const ev = evaluateReport(await runFixture(fx, hooks), fx.expected, fx.control);
    if (!ev.ok) out.push(`${fx.id}: ${ev.problems.join('; ')}`);
  }
  return out;
}

const readGlbJson = (bytes: Uint8Array): unknown => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + dv.getUint32(12, true))));
};
const resolves = (doc: unknown, pointer: string): boolean => {
  if (pointer === '') return true;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const tok = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !(tok in (cur as object))) return false;
    cur = (cur as Record<string, unknown>)[tok];
  }
  return true;
};

describe('the labelled synthetic corpus', () => {
  it('every fixture gets exactly its labelled verdict and codes, with nothing abstained', async () => {
    const fixtures = await Promise.all(listFixtureIds().map(buildFixture));
    expect(await mismatches(fixtures)).toEqual([]);
  });

  it('never passes a fixture that is labelled FAIL', async () => {
    for (const id of listFixtureIds()) {
      const fx = await buildFixture(id);
      if (fx.expected.verdict !== 'FAIL') continue;
      expect((await runFixture(fx)).verdict, id).not.toBe('PASS');
    }
  });

  it('every diagnostic pointer resolves in the glTF JSON when the asset parses', async () => {
    for (const id of ['TEXTURE_BUDGET-00', 'TEXTURE_BUDGET-08', 'OPEN_BOUNDARY-01', 'NONMANIFOLD_EDGE-02', 'FLOATING_ISLANDS-03', 'BBOX_CONFORMANCE-04', 'TRIANGLE_BUDGET-02', 'DEGENERATE_TRIANGLE-05', 'WINDING_INCONSISTENT-01', 'NONFINITE_POSITION-00', 'PRIMITIVE_BUDGET-00', 'MATERIAL_BUDGET-00', 'GLTF_INVALID-03']) {
      const fx = await buildFixture(id);
      const r = await runFixture(fx);
      const doc = readGlbJson(fx.bytes);
      expect(r.diagnostics.length, id).toBeGreaterThan(0);
      for (const d of r.diagnostics) expect(resolves(doc, d.pointer), `${id} ${d.code} ${d.pointer}`).toBe(true);
    }
  });
});

describe('gate mutation: a suite that cannot notice a broken check proves nothing', () => {
  // a small slice of the corpus keeps this affordable: two seeds per class plus controls
  const slice: string[] = [];
  for (const [klass, variant, n] of CLASS_COUNTS) for (let s = 0; s < (klass === 'CONTROL' ? 8 : 2); s++) if (s < n) slice.push(fixtureId(klass, variant, s));
  const MUTATED = CHECK_IDS.filter((id) => id !== 'parse');

  it('the unmutated slice is clean', async () => {
    expect(await mismatches(await Promise.all(slice.map(buildFixture)))).toEqual([]);
  });

  it.each(MUTATED)('disabling the %s check makes the labelled suite fail', async (id: CheckId) => {
    const fixtures = await Promise.all(slice.map(buildFixture));
    const found = await mismatches(fixtures, { neutralize: [id] });
    expect(found.length, `no fixture noticed that ${id} was disabled`).toBeGreaterThan(0);
  });

  it.each(CHECK_IDS)('a crash in the %s check can never produce PASS', async (id: CheckId) => {
    const fx = await buildFixture('CONTROL-02');
    const r = await runFixture(fx, { crash: [id] });
    expect(r.verdict).toBe('ABSTAIN');
    expect(r.checks[id]?.status).toBe('abstained');
  });
});
