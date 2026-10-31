import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failedAttempts } from '../scripts/results.ts';
import { checkTapes, listTapeFiles } from '../src/harness.ts';
import { recordedHashes } from '../src/study-run.ts';
import { transportFailureLimitExceeded } from '../src/transport.ts';

const PACKAGE = resolve(import.meta.dirname, '..');
const doc = readFileSync(join(PACKAGE, 'AMENDMENT-1.md'), 'utf8');
const prereg = readFileSync(join(PACKAGE, 'PREREGISTRATION.md'), 'utf8');
const tapes = join(PACKAGE, 'tapes');
const FLASH = 'gemini-3.8-flash';

describe('AMENDMENT-1.md, a draft that has not been run', () => {
  it('says it is a draft, not frozen and not run, and names the tag it would be frozen at', () => {
    expect(doc).toContain('**Status: DRAFT. Not frozen. Not run.**');
    expect(doc).not.toMatch(/Status: FROZEN/);
    expect(doc).toContain('`scene-gate-amendment-1`');
    expect(doc).toContain('Step 0 result: `OPEN`');
    expect(doc).toContain('(not run)');
  });

  it('changes transport only: the same prompts, checks, model and metrics, and leaves existing tapes untouched', () => {
    expect(doc).toContain('It changes no prompt, no check, no model, no parameter and no metric.');
    expect(doc).toContain('**Existing tapes are untouched.**');
    expect(doc).toContain('**it cannot write to any other model\'s directory**');
    const h = recordedHashes(prereg);
    for (const file of ['prompts.json', 'system.md', 'repair.md'] as const) expect(doc).toContain(h[file].slice(0, 8));
  });

  it('keeps the same $10 cap and the retry list, and drafts the longer backoff, pacing and amended stop rule', () => {
    expect(doc).toContain('The spend cap is the same $10 for the whole study.');
    expect(doc).toContain('30 s, 90 s, 270 s');
    expect(doc).toContain('at least 10 s from the start of one request to the start of the next');
    expect(doc).toContain('4 or more `transport_failure`');
    expect(transportFailureLimitExceeded(4, 37)).toBe(true);
    expect(transportFailureLimitExceeded(3, 37)).toBe(false);
  });

  it('has a tag plan that does not move the v2 tag, and says the 7 failed pairs stay failures', () => {
    expect(doc).toContain('The tag `scene-gate-prereg-v2` is not moved.');
    expect(doc).toContain('The 7 failed pairs are not retried');
    expect(doc).toContain('git push origin scene-gate scene-gate-amendment-1');
  });

  it('states what the 429s do and do not show, and makes a diagnosis the first step', () => {
    expect(doc).toContain('**Every one of the 28 failed attempts was HTTP 429**');
    expect(doc).toContain('**That is a hypothesis, not a finding.**');
    expect(doc).toContain('smoke-schema gemini --diagnose');
  });
});

describe('the facts in AMENDMENT-1.md, checked against the tapes', () => {
  const have = existsSync(tapes);
  it.skipIf(!have)('are true: 23 generations of the model, 16 replies all passing, 7 transport failures, 37 missing, 132 tapes', () => {
    const report = checkTapes(tapes);
    const flash = report.rows.filter((r) => r.kind === 'generate' && r.model === FLASH);
    expect(flash).toHaveLength(23);
    expect(flash.filter((r) => r.verdict)).toHaveLength(16);
    expect(flash.filter((r) => r.verdict === 'pass')).toHaveLength(16);
    const failed = flash.filter((r) => r.outcome === 'transport_failure').map((r) => `${r.prompt_id}/${r.sample}`);
    expect(failed).toEqual(['ord-06/1', 'ord-06/2', 'ord-07/0', 'ord-07/1', 'ord-07/2', 'ord-08/0', 'ord-08/1']);
    expect(60 - flash.length).toBe(37);
    expect(report.rows.filter((r) => r.kind === 'repair' && r.model === FLASH)).toHaveLength(0);
    expect(listTapeFiles(tapes)).toHaveLength(132);
    expect(doc).toContain('| Generation tapes for `gemini-3.8-flash` | 23 of 60 |');
    expect(doc).toContain('| Generations that do not exist | 37:');
    expect(doc).toContain('All 132 tapes');
  });

  it.skipIf(!have)('are true about the attempts: 28 failed attempts, every one an HTTP 429', () => {
    expect(failedAttempts(tapes)[FLASH]).toEqual({ 'HTTP 429': 28 });
  });
});
