import { createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@kensho/ir';
import {
  NotSignableError,
  buildManifest,
  generateKeyPair,
  loadOrCreateDevKeys,
  signingMessage,
  verifyBundle,
  writeSignedBundle,
  type BundleManifest,
} from '../src/index.ts';

let root: string;
const keys = generateKeyPair();
const A = new Uint8Array([1, 2, 3, 4, 5]);
const B = new Uint8Array([9, 9, 9, 9, 9, 9]);
const fakeHash = 'a'.repeat(64);

const placements = [
  { asset: 'crate', translation_um: [1_000_000, 0, -2_000_000] as [number, number, number], rotation_uq: [0, 0, 0, 1_000_000] as [number, number, number, number], scale_ppm: [1_000_000, 1_000_000, 1_000_000] as [number, number, number] },
];
const manifest = (verdict: 'PASS' | 'FAIL' | 'ABSTAIN' = 'PASS') =>
  buildManifest({
    assets: [
      { id: 'crate', bytes: A, verdict, verdict_hash: fakeHash },
      { id: 'barrel', bytes: B, verdict: 'PASS', verdict_hash: fakeHash },
    ],
    placements,
    camera: { position_um: [0, 2_000_000, 5_000_000], look_at_um: [0, 0, 0], fov_urad: 1_000_000 },
    gateVersions: { G4: 'g4-subset/0.1.0' },
    seeds: { layout: 7 },
    fallbacksUsed: [],
  });
const assets = new Map([['crate', A], ['barrel', B]]);

const make = (name: string, m: BundleManifest = manifest(), k = keys) => {
  const dir = join(root, name);
  writeSignedBundle(dir, m, assets, k);
  return dir;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kensho-bundle-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('a signed bundle', () => {
  it('verifies against the trusted key and exposes its manifest and hash', () => {
    const r = verifyBundle(make('ok'), keys.publicKey);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.assets.map((a) => a.id)).toEqual(['crate', 'barrel']);
      expect(r.bundleHash).toMatch(/^[0-9a-f]{64}$/);
      expect([...r.assetPaths.keys()]).toEqual(['crate', 'barrel']);
    }
  });

  it('is content addressed: assets are stored by their SHA-256', () => {
    const dir = make('cas');
    expect(readdirSync(join(dir, 'assets')).sort()).toEqual([`${sha256Hex(A)}.glb`, `${sha256Hex(B)}.glb`].sort());
  });

  it('signs over `kensho-bundle-v1`, a zero byte, then the canonical bytes', () => {
    const dir = make('msg');
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as BundleManifest;
    const sig = Buffer.from(JSON.parse(readFileSync(join(dir, 'manifest.sig'), 'utf8')).signature, 'base64');
    const msg = signingMessage(m);
    expect(msg.subarray(0, 16).toString()).toBe('kensho-bundle-v1');
    expect(msg[16]).toBe(0);
    expect(verify(null, msg, keys.publicKey, sig)).toBe(true);
    // without the domain prefix the same signature must not verify
    expect(verify(null, msg.subarray(17), keys.publicKey, sig)).toBe(false);
  });

  it('is deterministic: the same manifest and key give the same bytes', () => {
    const a = make('det1'), b = make('det2');
    expect(readFileSync(join(a, 'manifest.sig'))).toEqual(readFileSync(join(b, 'manifest.sig')));
    expect(readFileSync(join(a, 'manifest.json'))).toEqual(readFileSync(join(b, 'manifest.json')));
  });
});

describe('refusal before anything loads', () => {
  const refusal = (dir: string) => {
    const r = verifyBundle(dir, keys.publicKey);
    expect(r.ok).toBe(false);
    return r.ok ? [] : r.diagnostics.map((d) => d.code);
  };

  it('refuses an unsigned bundle', () => {
    const dir = make('unsigned');
    rmSync(join(dir, 'manifest.sig'));
    expect(refusal(dir)).toEqual(['BUNDLE_UNSIGNED']);
  });

  it('refuses a bundle signed with another key', () => {
    expect(refusal(make('wrongkey', manifest(), generateKeyPair()))).toEqual(['BUNDLE_SIGNATURE_INVALID']);
  });

  it('refuses a swapped signature even when the claimed key id is the trusted one', () => {
    const dir = make('swapped');
    const other = make('swapped_other', buildManifest({ assets: [{ id: 'crate', bytes: A, verdict: 'PASS', verdict_hash: fakeHash }], placements: [], gateVersions: { G4: 'x' } }));
    const sig = JSON.parse(readFileSync(join(other, 'manifest.sig'), 'utf8'));
    writeFileSync(join(dir, 'manifest.sig'), JSON.stringify(sig));
    expect(refusal(dir)).toEqual(['BUNDLE_SIGNATURE_INVALID']);
  });

  it('refuses a manifest edited after signing', () => {
    const dir = make('tamper_manifest');
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as BundleManifest;
    m.placements[0]!.translation_um[0] += 1;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m)); // still canonical-looking; the signature no longer fits
    expect(refusal(dir)).toEqual(['BUNDLE_SIGNATURE_INVALID']);
  });

  it('refuses a manifest re-encoded with whitespace', () => {
    const dir = make('pretty');
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
    expect(refusal(dir)).toEqual(['BUNDLE_SIGNATURE_INVALID']);
  });

  it('refuses a single changed byte in an asset', () => {
    const dir = make('tamper_asset');
    const file = join(dir, 'assets', `${sha256Hex(A)}.glb`);
    const bytes = readFileSync(file);
    bytes[0] ^= 0xff;
    writeFileSync(file, bytes);
    expect(refusal(dir)).toEqual(['BUNDLE_TAMPERED']);
  });

  it('refuses a missing asset and an unlisted extra file', () => {
    const missing = make('missing');
    rmSync(join(missing, 'assets', `${sha256Hex(A)}.glb`));
    expect(refusal(missing)).toEqual(['BUNDLE_TAMPERED']);
    const extra = make('extra');
    writeFileSync(join(extra, 'assets', 'smuggled.glb'), 'x');
    expect(refusal(extra)).toEqual(['BUNDLE_TAMPERED']);
  });

  it('refuses a missing or malformed manifest', () => {
    const none = join(root, 'empty');
    mkdirSync(none, { recursive: true });
    expect(refusal(none)).toEqual(['BUNDLE_MALFORMED']);
    const bad = make('malformed');
    writeFileSync(join(bad, 'manifest.json'), '{"kensho":"bundle/1"');
    expect(refusal(bad)).toEqual(['BUNDLE_MALFORMED']);
  });

  it('refuses a manifest whose asset path tries to leave the bundle', () => {
    const m = JSON.parse(JSON.stringify(manifest())) as BundleManifest;
    m.assets[0]!.path = '../../etc/passwd';
    const dir = make('traversal');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
    expect(refusal(dir)).toEqual(['BUNDLE_MALFORMED']);
  });

  it('refuses an unreadable signature file', () => {
    const dir = make('badsig');
    writeFileSync(join(dir, 'manifest.sig'), 'not json');
    expect(refusal(dir)).toEqual(['BUNDLE_SIGNATURE_INVALID']);
  });
});

describe('signing is blocked unless every asset passed', () => {
  it.each(['FAIL', 'ABSTAIN'] as const)('refuses a %s verdict', (v) => {
    expect(() => writeSignedBundle(join(root, `blocked_${v}`), manifest(v), assets, keys)).toThrowError(NotSignableError);
    expect(existsSync(join(root, `blocked_${v}`))).toBe(false);
  });

  it('refuses bytes that do not match the manifest', () => {
    expect(() => writeSignedBundle(join(root, 'mismatch'), manifest(), new Map([['crate', B], ['barrel', B]]), keys)).toThrowError(NotSignableError);
  });

  it('cannot even build a manifest holding a float', () => {
    expect(() =>
      buildManifest({ assets: [], placements: [{ ...placements[0]!, translation_um: [1.5, 0, 0] }], gateVersions: {} }),
    ).toThrow();
  });
});

describe('dev keys', () => {
  it('are generated at runtime into the given folder and reloaded unchanged', () => {
    const dir = join(root, 'keys');
    expect(existsSync(dir)).toBe(false);
    const a = loadOrCreateDevKeys(dir);
    const b = loadOrCreateDevKeys(dir);
    expect(b.keyId).toBe(a.keyId);
    expect(createPublicKey(readFileSync(join(dir, 'gate.pub.pem'))).asymmetricKeyType).toBe('ed25519');
    expect(readFileSync(join(dir, 'gate.key.pem'), 'utf8')).toContain('PRIVATE KEY');
  });

});
