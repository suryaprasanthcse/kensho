import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REGISTRY } from '@kensho/diagnostics';
import { CLASS_COUNTS, generateAll, readLabels } from '@kensho/synthetic_oracle';
import { buildSmokeCases } from '../src/bundles.ts';
import { ASSET_DIR, LABELS_PATH, ROOT } from '../src/paths.ts';
import { percentile, wilson } from '../src/stats.ts';

const tracked = (): string[] => {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

describe('statistics', () => {
  it('Wilson interval matches known values', () => {
    const none = wilson(0, 40);
    expect(none.lo).toBe(0);
    expect(none.hi).toBeCloseTo(0.0877, 3);
    const all = wilson(10, 10);
    expect(all.lo).toBeCloseTo(0.7225, 3);
    expect(all.hi).toBeCloseTo(1, 9);
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
    const half = wilson(50, 100);
    expect(half.lo).toBeCloseTo(0.4038, 3);
    expect(half.hi).toBeCloseTo(0.5962, 3);
  });

  it('nearest-rank percentiles', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe('committed fixture labels', () => {
  it('are reproduced exactly by regeneration, byte for byte', async () => {
    const committed = readLabels(LABELS_PATH);
    expect(committed.fixtures.length).toBe(CLASS_COUNTS.reduce((n, [, , c]) => n + c, 0));
    const { drift } = await generateAll(ASSET_DIR, committed);
    expect(drift).toEqual([]);
  });

  it('carry a verdict and expected codes for every file, and a SHA-256', () => {
    for (const l of readLabels(LABELS_PATH).fixtures) {
      expect(l.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(['PASS', 'FAIL']).toContain(l.expected.verdict);
      if (l.expected.verdict === 'FAIL') expect(l.expected.codes.length).toBeGreaterThan(0);
    }
  });
});

describe('every shipped code has a fixture', () => {
  it('names a defect class in the labels or a smoke case that exists', async () => {
    const classes = new Set(readLabels(LABELS_PATH).fixtures.flatMap((l) => l.expected.codes));
    const smoke = new Set((await buildSmokeCases()).map((c) => c.fixture));
    for (const info of Object.values(REGISTRY)) {
      const ok = info.fixtures.every((f) => (info.gate === 'G4' ? classes.has(f) : smoke.has(f)));
      expect(ok, `${info.code}: ${info.fixtures.join(',')}`).toBe(true);
    }
  });
});

describe('repository hygiene', () => {
  const files = tracked();
  const maybe = files.length ? it : it.skip;

  maybe('commits no keys and no generated fixtures', () => {
    expect(files.filter((f) => /\.(glb|pem|key)$/.test(f) || f.startsWith('.dev-keys/') || f.startsWith('.generated/'))).toEqual([]);
  });

  maybe('keeps .env ignored and untracked, and .env.example a placeholder', () => {
    const ignored = (path: string) => spawnSync('git', ['check-ignore', '-q', path], { cwd: ROOT }).status === 0;
    expect(ignored('.env')).toBe(true);
    expect(ignored('.env.local')).toBe(true);
    expect(ignored('.env.example')).toBe(false);
    expect(files).not.toContain('.env');
    expect(files).toContain('.env.example');
    expect(readFileSync(join(ROOT, '.env.example'), 'utf8')).toContain('HYPER3D_API_KEY=your_key_here');
  });

  maybe('commits no value for the API key anywhere but the placeholder', () => {
    for (const f of files) {
      if (!/\.(ts|js|json|md|yml|yaml|toml|example)$/.test(f) && f !== '.gitignore') continue;
      const text = readFileSync(join(ROOT, f), 'utf8');
      for (const m of text.matchAll(/HYPER3D_API_KEY\s*=\s*([^\s`'"\\]+)/g)) {
        // unit tests use short throwaway strings; anything key-shaped, or anywhere else, must be the placeholder
        if (f.includes('/test/')) expect(m[1]!.length, `${f}: ${m[1]}`).toBeLessThan(20);
        else expect(m[1], f).toBe('your_key_here');
      }
    }
  });

  maybe('carries the Apache-2.0 text once, at the root', () => {
    const found = files.filter((f) => /^(LICENSE|LICENCE|COPYING)/i.test(f.split('/').pop()!));
    expect(found).toEqual(['LICENSE']);
    const text = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
    expect(text).toContain('Apache License');
    expect(text).toContain('Version 2.0, January 2004');
    expect(text).toContain('END OF TERMS AND CONDITIONS');
  });

  maybe('never names the private integration profile in any committed file', () => {
    const word = ['ar', 'cade'].join('');
    const hits = files.filter((f) => /\.(ts|js|json|md|yml|yaml|toml|py|gitignore|gitattributes)$/.test(f) || !f.includes('.')).filter((f) => new RegExp(word, 'i').test(readFileSync(join(ROOT, f), 'utf8')));
    expect(hits).toEqual([]);
  });

  maybe('has private, Apache-2.0, exactly pinned packages', () => {
    const pkgs = files.filter((f) => f.endsWith('package.json'));
    expect(pkgs.length).toBeGreaterThan(18);
    for (const f of pkgs) {
      const pj = JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as Record<string, unknown>;
      expect(pj.private, f).toBe(true);
      expect(pj.license, f).toBe('Apache-2.0');
      for (const field of ['dependencies', 'devDependencies']) {
        for (const [name, range] of Object.entries((pj[field] ?? {}) as Record<string, string>)) {
          expect(range, `${f} ${name}`).toMatch(/^(workspace:\*|\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?)$/);
        }
      }
    }
  });

  it('lists the root packageManager and a committed lockfile', () => {
    expect((JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { packageManager: string }).packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(existsSync(join(ROOT, 'pnpm-lock.yaml'))).toBe(true);
  });

  it('keeps READMEs free of numeric claims about test counts', () => {
    for (const f of tracked().filter((t) => t.endsWith('README.md'))) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/\b\d+\s+(tests?|specs?)\b/i);
    }
  });
});
