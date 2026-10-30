import { buildGlb, geometry as G, type AssetSpec, type MaterialSpec, type NodeSpec } from '@kensho/synthetic_oracle';
import { runAssetGateInline, type AssetGateOptions, type AssetGateReport, type TestHooks } from '../src/index.ts';

export const base: AssetGateOptions = { tier: 'mobile', assetClass: 'prop', body: 'dynamic' };

export const grey: MaterialSpec = { color: [0.6, 0.6, 0.6] };

/** One node, one primitive. */
export async function glbOfGeometry(g: G.Geometry, materials: MaterialSpec[] = [grey]): Promise<Uint8Array> {
  return buildGlb({ materials, nodes: [{ parts: [{ geometry: g, material: 0 }] }] });
}

export async function glbOfSpec(spec: AssetSpec): Promise<Uint8Array> {
  return buildGlb(spec);
}

export async function gate(bytes: Uint8Array, opts: Partial<AssetGateOptions> = {}, hooks?: TestHooks): Promise<AssetGateReport> {
  return runAssetGateInline(bytes, { ...base, ...opts }, hooks);
}

export const codesOf = (r: AssetGateReport): string[] => [...new Set(r.diagnostics.map((d) => d.code))].sort();

/** Triangle count 2 * segs * tubeSegs, exactly. */
export const torusWithTriangles = (segs: number, tube: number): G.Geometry => G.torus(0.4, 0.15, segs, tube);

export type { NodeSpec };
export { G };
