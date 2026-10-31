import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPrompts } from '../src/harness.ts';
import { OVERLAP_TOLERANCE_MM, SUPPORT_TOLERANCE_MM } from '../src/thresholds.ts';

const PACKAGE = join(import.meta.dirname, '..');
const text = readFileSync(join(PACKAGE, 'PREREGISTRATION.md'), 'utf8');
const prompts = loadPrompts(join(PACKAGE, 'prompts', 'prompts.json'));

describe('the preregistration draft', () => {
  it('is marked DRAFT and not frozen', () => {
    expect(text).toContain('**Status: DRAFT. Not frozen.**');
    expect(text).not.toMatch(/Status: FROZEN/);
  });

  it('records the models page, the date it was read, and no 1.5 model', () => {
    expect(text).toContain('https://ai.google.dev/gemini-api/docs/models');
    expect(text).toContain('2026-11-01');
    expect(text).not.toMatch(/gemini-1\.5/);
    for (const id of text.match(/`gemini-[a-z0-9.-]+`/g) ?? []) expect(id).not.toMatch(/gemini-1\./);
  });

  it('leaves a slot for the second model and the other values the owner decides', () => {
    expect(text).toMatch(/\| 2 \| `TBD` \|/);
    for (const slot of ['Commit', 'SHA-256 of `prompts.json`', 'SHA-256 of `system.md`', 'Budget']) expect(text, slot).toContain(slot);
  });

  it('states 20 prompts x 3 runs and matches the prompts file', () => {
    expect(prompts.prompts).toHaveLength(20);
    expect(text).toContain('20 prompts x 3 runs per model = 60 scene generations per model');
    expect(text).toContain('10 ordinary');
    expect(text).toContain('10 structured');
  });

  it('quotes the thresholds the code uses and keeps the optional check off', () => {
    expect(text).toContain(`${OVERLAP_TOLERANCE_MM} mm overlap, ${SUPPORT_TOLERANCE_MM} mm support`);
    expect(text).toContain('is **off**');
  });

  it('defines every metric and says it has a single repair round', () => {
    for (const m of ['M1', 'M2', 'M3', 'M4', 'M5']) expect(text).toContain(m);
    expect(text).toContain('exactly one repair round');
    expect(text).toContain('no early stopping');
  });

  it('carries the disclosure verbatim', () => {
    expect(text).toContain('I wrote the specification and set the thresholds; Claude Code wrote the code and tests under my direction.');
  });
});
