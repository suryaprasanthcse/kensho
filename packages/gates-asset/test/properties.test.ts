import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { buildFixture, buildGlb, geometry as G, listFixtureIds, type NodeSpec } from '@kensho/synthetic_oracle';
import { runAssetGateInline, type AssetGateOptions, type AssetGateReport } from '../src/index.ts';

/** What must not change: everything except the input hash and timings. */
const essence = (r: AssetGateReport, withPointers: boolean) => ({
  verdict: r.verdict,
  diagnostics: r.diagnostics.map((d) => ({ code: d.code, severity: d.severity, evidence: d.evidence, message: d.message, ...(withPointers ? { pointer: d.pointer } : {}) })),
  measures: r.measures,
  checks: r.checks,
});

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const small = listFixtureIds().filter((id) => !id.startsWith('HULL_') && !id.startsWith('TEXTURE_BUDGET'));

describe('G4 verdicts are invariant', () => {
  it('under a glTF round-trip (read, write)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...small), async (id) => {
        const fx = await buildFixture(id);
        const opts: AssetGateOptions = { tier: fx.options.tier, assetClass: fx.options.class, body: fx.options.body, ...(fx.options.box_um ? { boxUm: fx.options.box_um } : {}) };
        let rewritten: Uint8Array;
        try {
          rewritten = await io.writeBinary(await io.readBinary(fx.bytes));
        } catch {
          return; // a file the library itself cannot read has no round-trip
        }
        const a = await runAssetGateInline(fx.bytes, opts);
        const b = await runAssetGateInline(rewritten, opts);
        // a rewrite may repair what the validator objects to: only compare when the original parsed cleanly
        if (a.checks.validator && a.diagnostics.some((d) => d.code === 'GLTF_INVALID')) return;
        expect(essence(b, true)).toEqual(essence(a, true));
      }),
      { numRuns: 60 },
    );
  });

  it('under reordering of scene nodes, on fixtures that have several nodes', async () => {
    const multi = ['TEXTURE_BUDGET-07', 'TEXTURE_BUDGET-08', 'TEXTURE_BUDGET-09'];
    for (const id of multi) {
      const fx = await buildFixture(id);
      const opts: AssetGateOptions = { tier: fx.options.tier, assetClass: fx.options.class, body: fx.options.body };
      const doc = await io.readBinary(fx.bytes);
      const before = await runAssetGateInline(await io.writeBinary(doc), opts);
      for (const scene of doc.getRoot().listScenes()) {
        const kids = scene.listChildren();
        kids.forEach((k) => scene.removeChild(k));
        kids.reverse().forEach((k) => scene.addChild(k));
      }
      const after = await runAssetGateInline(await io.writeBinary(doc), opts);
      expect(essence(after, false)).toEqual(essence(before, false));
    }
  });

  it('under reordering of nodes in random multi-node assets (any defects, either body kind)', async () => {
    const nodeArb = fc.record({
      kind: fc.constantFrom('box', 'sphere', 'cylinder'),
      defect: fc.constantFrom('none', 'open', 'flip', 'none'),
      scale: fc.tuple(...[0, 1, 2].map(() => fc.integer({ min: 2, max: 40 }))),
      at: fc.tuple(...[0, 1, 2].map(() => fc.integer({ min: -6, max: 6 }))),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(nodeArb, { minLength: 2, maxLength: 5 }), fc.constantFrom('dynamic', 'static'), async (nodes, body) => {
        const mk = (n: (typeof nodes)[number]): NodeSpec => {
          const g = n.kind === 'box' ? G.box(1, 1, 1) : n.kind === 'sphere' ? G.sphere(0.5, 8, 12) : G.cylinder(0.5, 1, 2, 10);
          if (n.defect === 'open') G.dropTriangles(g, 3, 2);
          if (n.defect === 'flip') G.flipTriangles(g, [1, 4]);
          return { parts: [{ geometry: g, material: 0 }], scale: n.scale.map((s) => s / 8) as [number, number, number], translation: n.at.map((t) => t / 2) as [number, number, number] };
        };
        const grey = { color: [0.5, 0.5, 0.5] as [number, number, number] };
        const opts: AssetGateOptions = { tier: 'desktop', assetClass: 'prop', body };
        const a = await runAssetGateInline(await buildGlb({ materials: [grey], nodes: nodes.map(mk) }), opts);
        const b = await runAssetGateInline(await buildGlb({ materials: [grey], nodes: [...nodes].reverse().map(mk) }), opts);
        expect(essence(b, false)).toEqual(essence(a, false));
      }),
      { numRuns: 40 },
    );
  });
});
