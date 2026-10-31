import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src/check.ts';
import { SEMANTIC_CODES } from '../src/diagnostic.ts';
import { HALF, OVERLAP_TOLERANCE_MM, STEP_RADIUS_MM, SUPPORT_TOLERANCE_MM } from '../src/thresholds.ts';

const SRC = join(import.meta.dirname, '..', 'src');
const source = (...parts: string[]): string => readFileSync(join(SRC, ...parts), 'utf8');
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the check registry', () => {
  it('has one entry per semantic code, in table order, and one file per entry', () => {
    expect(CHECKS.map((c) => c.code)).toEqual([...SEMANTIC_CODES]);
    const files = readdirSync(join(SRC, 'checks')).map((f) => f.replace(/\.ts$/, '')).sort();
    expect(files).toEqual(CHECKS.map((c) => c.file).sort());
  });

  it('marks only UNREACHABLE_HEIGHT as optional', () => {
    expect(CHECKS.filter((c) => c.optional).map((c) => c.code)).toEqual(['UNREACHABLE_HEIGHT']);
  });
});

describe('the thresholds are the specified ones', () => {
  it('are 5 mm, 20 mm and 1.5 m, in whole millimetres', () => {
    expect([OVERLAP_TOLERANCE_MM, SUPPORT_TOLERANCE_MM, STEP_RADIUS_MM]).toEqual([5, 20, 1500]);
    expect(HALF).toBe(2);
  });
});

describe('the checks are deterministic and use integer arithmetic only', () => {
  const files = [...readdirSync(join(SRC, 'checks')).map((f) => join('checks', f)), 'geometry.ts', 'check.ts', 'canonical.ts', 'diagnostic.ts', 'verdict.ts', 'parse.ts', 'repair.ts'];

  it.each(files)('%s reads no clock, randomness, network, file system or environment', (file) => {
    const text = stripComments(source(file));
    expect(text).not.toMatch(/\bDate\b|Math\.random|performance\.now|\bfetch\s*\(|process\.env|node:(fs|http|https|net|child_process)|crypto\.random|setTimeout/);
  });

  it.each(['geometry.ts', ...readdirSync(join(SRC, 'checks')).map((f) => join('checks', f))])('%s has no decimal literals or rounding', (file) => {
    const text = stripComments(source(file));
    expect(text).not.toMatch(/\b\d+\.\d+\b|Math\.(round|floor|ceil|trunc|sqrt|pow|hypot)|parseFloat|toFixed/);
  });
});
