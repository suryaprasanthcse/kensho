import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RealManifest } from '../src/real-assets.ts';
import { ROOT } from '../src/paths.ts';

const manifest = JSON.parse(readFileSync(join(ROOT, 'corpus', 'assets', 'real', 'golem.manifest.json'), 'utf8')) as RealManifest;

describe('the real-asset manifest', () => {
  it('lists five assets with valid classes, bodies and frozen hashes', () => {
    expect(manifest.format).toBe('kensho-real-assets/1');
    expect(manifest.assets.length).toBe(5);
    for (const a of manifest.assets) {
      expect(['hero', 'prop', 'background']).toContain(a.class);
      expect(['dynamic', 'static']).toContain(a.body);
      expect(a.raw.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.split.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.raw.job.generation_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Number.isInteger(a.size_largest_um)).toBe(true);
      expect(a.box_um === null || (a.box_um.length === 3 && a.box_um.every(Number.isInteger))).toBe(true);
    }
  });

  it('holds only relative paths and no signed URL or credential', () => {
    const text = JSON.stringify(manifest);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/X-Tos|Credential|Signature|[A-Z]:\\/);
    for (const a of manifest.assets) for (const f of [a.raw.file, a.split.file]) expect(f).toMatch(/^assets\/[\w./-]+\.glb$/);
  });

  it('anchors only the vault door', () => {
    expect(manifest.assets.filter((a) => a.anchored).map((a) => a.id)).toEqual(['vault_door']);
    expect(manifest.assets.find((a) => a.id === 'vault_door')!.body).toBe('static');
  });
});
