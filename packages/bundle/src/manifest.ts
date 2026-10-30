import { z } from 'zod';
import { DOMAINS, canonicalBytes, canonicalize, sha256Domain, sha256Hex } from '@kensho/ir';

export const BUNDLE_FORMAT = 'bundle/1';
export const SIGNATURE_FORMAT = 'bundle-sig/1';

const int = z.int();
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const vec3 = z.tuple([int, int, int]);
const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const Placement = z.strictObject({
  asset: name,
  /** Integer micrometres. */
  translation_um: vec3,
  /** A unit quaternion in millionths: [x, y, z, w]. */
  rotation_uq: z.tuple([int, int, int, int]),
  /** Parts per million: 1_000_000 is unit scale. */
  scale_ppm: vec3,
});

export const Camera = z.strictObject({
  position_um: vec3,
  look_at_um: vec3,
  /** Vertical field of view in microradians. */
  fov_urad: int.positive(),
});

export const Manifest = z.strictObject({
  kensho: z.literal(BUNDLE_FORMAT),
  assets: z.array(z.strictObject({ id: name, sha256: sha, bytes: int.nonnegative(), path: z.string().regex(/^assets\/[0-9a-f]{64}\.glb$/) })),
  placements: z.array(Placement),
  camera: Camera.optional(),
  gate_versions: z.record(z.string(), z.string()),
  verdicts: z.array(z.strictObject({ asset: name, gate: z.string(), verdict: z.enum(['PASS', 'FAIL', 'ABSTAIN']), verdict_hash: sha })),
  seeds: z.record(z.string(), int),
  /** Every non-primary path taken to produce this bundle. */
  fallbacks_used: z.array(z.string()),
});

export type BundleManifest = z.infer<typeof Manifest>;

export const canonicalManifestBytes = (m: BundleManifest): Uint8Array => canonicalBytes(m);

/** SHA-256 over `kensho-bundle-v1 ‖ 0x00 ‖ canonical manifest`. */
export const bundleHash = (m: BundleManifest): string => sha256Domain(DOMAINS.bundle, canonicalManifestBytes(m));

export const assetPath = (sha256: string): string => `assets/${sha256}.glb`;

export interface BundleAssetInput {
  id: string;
  bytes: Uint8Array;
  /** The G4 verdict for these bytes. */
  verdict: 'PASS' | 'FAIL' | 'ABSTAIN';
  verdict_hash: string;
}

export interface BuildManifestInput {
  assets: BundleAssetInput[];
  placements: BundleManifest['placements'];
  camera?: BundleManifest['camera'];
  gateVersions: Record<string, string>;
  seeds?: Record<string, number>;
  fallbacksUsed?: string[];
}

/** Builds and validates a manifest. A float anywhere makes the canonical form throw, so it cannot be signed. */
export function buildManifest(input: BuildManifestInput): BundleManifest {
  const manifest = Manifest.parse({
    kensho: BUNDLE_FORMAT,
    assets: input.assets.map((a) => {
      const sha256 = sha256Hex(a.bytes);
      return { id: a.id, sha256, bytes: a.bytes.length, path: assetPath(sha256) };
    }),
    placements: input.placements,
    ...(input.camera ? { camera: input.camera } : {}),
    gate_versions: input.gateVersions,
    verdicts: input.assets.map((a) => ({ asset: a.id, gate: 'G4', verdict: a.verdict, verdict_hash: a.verdict_hash })),
    seeds: input.seeds ?? {},
    fallbacks_used: input.fallbacksUsed ?? [],
  });
  canonicalize(manifest); // throws if anything is not an integer
  return manifest;
}

/** References must resolve and every asset must carry a PASS verdict from the asset gate. Returns problems. */
export function manifestProblems(m: BundleManifest): string[] {
  const problems: string[] = [];
  const ids = new Set(m.assets.map((a) => a.id));
  if (ids.size !== m.assets.length) problems.push('duplicate asset ids');
  for (const p of m.placements) if (!ids.has(p.asset)) problems.push(`placement references unknown asset ${p.asset}`);
  for (const a of m.assets) {
    const v = m.verdicts.find((x) => x.asset === a.id && x.gate === 'G4');
    if (!v) problems.push(`asset ${a.id} has no G4 verdict`);
    else if (v.verdict !== 'PASS') problems.push(`asset ${a.id} has G4 verdict ${v.verdict}`);
  }
  return problems;
}
