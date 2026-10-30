import { sign, verify, type KeyObject } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DOMAINS, domainPreimage, sha256Hex } from '@kensho/ir';
import { makeDiagnostic, type Diagnostic } from '@kensho/diagnostics';
import { keyIdOf, type KeyPair } from './keys.ts';
import {
  Manifest,
  SIGNATURE_FORMAT,
  bundleHash,
  canonicalManifestBytes,
  manifestProblems,
  type BundleManifest,
} from './manifest.ts';

const SignatureFile = z.strictObject({
  kensho: z.literal(SIGNATURE_FORMAT),
  alg: z.literal('ed25519'),
  key_id: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export class NotSignableError extends Error {
  constructor(reason: string) {
    super(`bundle cannot be signed: ${reason}`);
    this.name = 'NotSignableError';
  }
}

/** The exact bytes that are signed: `kensho-bundle-v1 ‖ 0x00 ‖ canonical manifest`. */
export const signingMessage = (m: BundleManifest): Buffer => domainPreimage(DOMAINS.bundle, canonicalManifestBytes(m));

/**
 * Writes a bundle directory: `manifest.json` (canonical bytes), `manifest.sig` and `assets/<sha256>.glb`.
 * Refuses to sign when any asset lacks a PASS verdict: abstentions and failures block signing.
 */
export function writeSignedBundle(dir: string, manifest: BundleManifest, assets: ReadonlyMap<string, Uint8Array>, keys: KeyPair): string {
  const problems = manifestProblems(manifest);
  if (problems.length) throw new NotSignableError(problems.join('; '));
  for (const a of manifest.assets) {
    const bytes = assets.get(a.id);
    if (!bytes || sha256Hex(bytes) !== a.sha256) throw new NotSignableError(`bytes for ${a.id} do not match the manifest`);
  }
  mkdirSync(join(dir, 'assets'), { recursive: true });
  for (const a of manifest.assets) writeFileSync(join(dir, a.path), assets.get(a.id)!);
  writeFileSync(join(dir, 'manifest.json'), canonicalManifestBytes(manifest));
  const signature = sign(null, signingMessage(manifest), keys.privateKey).toString('base64');
  writeFileSync(join(dir, 'manifest.sig'), JSON.stringify({ kensho: SIGNATURE_FORMAT, alg: 'ed25519', key_id: keys.keyId, signature }));
  return bundleHash(manifest);
}

export type VerifyResult =
  | { ok: true; manifest: BundleManifest; bundleHash: string; assetPaths: Map<string, string> }
  | { ok: false; diagnostics: Diagnostic[] };

const refuse = (code: string, message: string, pointer = '', evidence: Record<string, string | number> = {}): VerifyResult => ({
  ok: false,
  diagnostics: [makeDiagnostic(code, { pointer, message, evidence })],
});

/**
 * Verifies a bundle against a trusted public key before anything is loaded. Order: manifest form,
 * signature present, signature valid, then every asset's bytes. Any failure is a refusal; there is no
 * partial acceptance.
 */
export function verifyBundle(dir: string, trusted: KeyObject): VerifyResult {
  let raw: Buffer;
  try {
    raw = readFileSync(join(dir, 'manifest.json'));
  } catch {
    return refuse('BUNDLE_MALFORMED', 'manifest.json is missing or unreadable');
  }
  let manifest: BundleManifest;
  try {
    manifest = Manifest.parse(JSON.parse(raw.toString('utf8')));
  } catch (e) {
    return refuse('BUNDLE_MALFORMED', `manifest.json does not match the schema: ${(e as Error).message.slice(0, 200)}`);
  }

  let sigRaw: Buffer;
  try {
    sigRaw = readFileSync(join(dir, 'manifest.sig'));
  } catch {
    return refuse('BUNDLE_UNSIGNED', 'manifest.sig is missing: unsigned bundles are refused');
  }
  let sig: z.infer<typeof SignatureFile>;
  try {
    sig = SignatureFile.parse(JSON.parse(sigRaw.toString('utf8')));
  } catch {
    return refuse('BUNDLE_SIGNATURE_INVALID', 'manifest.sig is not a valid signature file');
  }
  if (sig.key_id !== keyIdOf(trusted)) return refuse('BUNDLE_SIGNATURE_INVALID', 'signed by a key that is not trusted', '', { key_id: sig.key_id });
  const canonical = Buffer.from(canonicalManifestBytes(manifest));
  if (!canonical.equals(raw)) {
    // same content in a different encoding is still a different file: refuse rather than guess
    return refuse('BUNDLE_SIGNATURE_INVALID', 'manifest.json is not in canonical form');
  }
  const valid = verify(null, domainPreimage(DOMAINS.bundle, canonical), trusted, Buffer.from(sig.signature, 'base64'));
  if (!valid) return refuse('BUNDLE_SIGNATURE_INVALID', 'the signature does not verify over the manifest');

  const problems = manifestProblems(manifest);
  if (problems.length) return refuse('BUNDLE_MALFORMED', problems.join('; '));

  const assetPaths = new Map<string, string>();
  const listed = new Set(manifest.assets.map((a) => a.path));
  for (const [i, a] of manifest.assets.entries()) {
    const file = join(dir, a.path);
    try {
      if (lstatSync(file).isSymbolicLink()) return refuse('BUNDLE_TAMPERED', `${a.path} is a symbolic link`, `/assets/${i}`);
      const bytes = readFileSync(file);
      if (bytes.length !== a.bytes || sha256Hex(bytes) !== a.sha256) {
        return refuse('BUNDLE_TAMPERED', `${a.path} does not match its hash in the signed manifest`, `/assets/${i}`, { asset_index: i });
      }
    } catch {
      return refuse('BUNDLE_TAMPERED', `${a.path} is missing`, `/assets/${i}`, { asset_index: i });
    }
    assetPaths.set(a.id, file);
  }
  try {
    for (const name of readdirSync(join(dir, 'assets'))) {
      if (!listed.has(`assets/${name}`)) return refuse('BUNDLE_TAMPERED', `assets/${name} is not listed in the signed manifest`);
    }
  } catch {
    /* no assets directory: nothing to compare */
  }
  return { ok: true, manifest, bundleHash: bundleHash(manifest), assetPaths };
}
