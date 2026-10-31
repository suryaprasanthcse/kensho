import { hashRecord, type AssetRequest } from '@kensho/ir';
import { Hyper3dError } from './errors.ts';

/** The subset of Rodin request fields this client sends. `tier` is required: omitting it silently downgrades. */
export interface RodinParams {
  tier: string;
  geometry_file_format: 'glb';
  mesh_mode?: 'Raw' | 'Quad';
  quality_override?: number;
  texture_mode?: string;
  uhd_texture?: boolean;
  /** For example `HighPack`. */
  addons?: string[];
  /** Three integers. The axis order is unconfirmed: check the API spec before relying on it. */
  bbox_condition?: [number, number, number];
  TAPose?: boolean;
}

export interface NormalizedRequest {
  prompt: string;
  seed: number;
  assetClass: AssetRequest['assetClass'];
  params: RodinParams;
  /** hash(request): the idempotency key. */
  key: string;
}

const MAX_SEED = 65_535;

const bad = (m: string): never => {
  throw new Hyper3dError('INVALID_REQUEST', m);
};

/** AssetRequest params are flat scalars, so lists travel as comma-separated strings. */
export function toAssetRequest(r: { prompt: string; seed: number; assetClass: AssetRequest['assetClass']; params: Omit<RodinParams, 'geometry_file_format'> & { geometry_file_format?: 'glb' } }): AssetRequest {
  const flat: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(r.params)) {
    if (v === undefined) continue;
    flat[k] = Array.isArray(v) ? v.join(',') : (v as string | number | boolean);
  }
  return { prompt: r.prompt, seed: r.seed, assetClass: r.assetClass, params: flat };
}

/** The web preset from the design notes: Gen-2.5 Medium, raw mesh, about 20k faces, GLB. */
export const webPreset = (): Omit<RodinParams, 'geometry_file_format'> => ({ tier: 'Gen-2.5-Medium', mesh_mode: 'Raw', quality_override: 20_000 });

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Validates a request and computes its idempotency key. Nothing here touches the network. */
export function normalizeRequest(req: AssetRequest, opts: { allowLegacyTier?: boolean } = {}): NormalizedRequest {
  const p = req.params;
  const tier = p.tier;
  if (typeof tier !== 'string' || !tier.trim()) bad('tier is required: leaving it out silently selects a legacy generation');
  if (!opts.allowLegacyTier && /^(regular|gen-1(\.5)?)$/i.test(String(tier).trim())) bad(`tier "${String(tier)}" is a legacy tier`);
  if (typeof req.prompt !== 'string' || !req.prompt.trim() || req.prompt.length > 2000) bad('prompt must be 1 to 2000 characters');
  if (!isInt(req.seed) || req.seed < 0 || req.seed > MAX_SEED) bad(`seed must be an integer from 0 to ${MAX_SEED}`);
  if (p.geometry_file_format !== undefined && p.geometry_file_format !== 'glb') bad('only geometry_file_format=glb is supported');
  if (p.mesh_mode !== undefined && p.mesh_mode !== 'Raw' && p.mesh_mode !== 'Quad') bad('mesh_mode must be Raw or Quad');
  if (p.quality_override !== undefined && (!isInt(p.quality_override) || p.quality_override < 500 || p.quality_override > 2_000_000)) bad('quality_override must be an integer from 500 to 2000000');
  if (p.texture_mode !== undefined && typeof p.texture_mode !== 'string') bad('texture_mode must be a string');
  if (p.uhd_texture !== undefined && typeof p.uhd_texture !== 'boolean') bad('uhd_texture must be a boolean');
  if (p.TAPose !== undefined && typeof p.TAPose !== 'boolean') bad('TAPose must be a boolean');
  let bbox: [number, number, number] | undefined;
  if (p.bbox_condition !== undefined) {
    const parts = String(p.bbox_condition).split(',');
    if (parts.length !== 3 || !parts.every((s) => /^[1-9]\d*$/.test(s))) bad('bbox_condition must be three positive integers, like 100,100,200');
    bbox = parts.map(Number) as [number, number, number];
  }
  const addons = p.addons === undefined ? undefined : String(p.addons).split(',').map((s) => s.trim()).filter(Boolean);
  const params: RodinParams = {
    tier: String(tier).trim(),
    geometry_file_format: 'glb',
    ...(p.mesh_mode !== undefined ? { mesh_mode: p.mesh_mode as 'Raw' | 'Quad' } : {}),
    ...(p.quality_override !== undefined ? { quality_override: p.quality_override as number } : {}),
    ...(p.texture_mode !== undefined ? { texture_mode: p.texture_mode as string } : {}),
    ...(p.uhd_texture !== undefined ? { uhd_texture: p.uhd_texture as boolean } : {}),
    ...(addons && addons.length ? { addons } : {}),
    ...(bbox ? { bbox_condition: bbox } : {}),
    ...(p.TAPose !== undefined ? { TAPose: p.TAPose as boolean } : {}),
  };
  const key = hashRecord('kensho-rodin-request-v1', { prompt: req.prompt, seed: req.seed, assetClass: req.assetClass, params: params as never });
  return { prompt: req.prompt, seed: req.seed, assetClass: req.assetClass, params, key };
}

export const paramsDigest = (params: RodinParams): string => hashRecord('kensho-asset-params-v1', params as never);

/** Credits in thousandths, from the documented price list. Prices can change: `consumed` is checked on every job. */
export function expectedMillicredits(params: RodinParams): number {
  return 500 + (params.tier === 'Gen-2.5-Extreme-High' ? 500 : 0) + (params.texture_mode === 'extreme-high' ? 2000 : 0);
}
