import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failedAttempts } from '../scripts/results.ts';
import { checkTapes, listTapeFiles } from '../src/harness.ts';

const PACKAGE = resolve(import.meta.dirname, '..');
const doc = readFileSync(join(PACKAGE, 'AMENDMENT-1.md'), 'utf8');
const tapes = join(PACKAGE, 'tapes');
const FLASH = 'gemini-3.8-flash';

describe('AMENDMENT-1.md, a withdrawn draft that was never run', () => {
  it('says it is withdrawn, not frozen, never run, and that its tag was never created', () => {
    expect(doc).toContain('**Status: WITHDRAWN. Not frozen. Never run.**');
    expect(doc).toContain('The tag `scene-gate-amendment-1` was never created');
    expect(doc).not.toMatch(/Status: (DRAFT|FROZEN)/);
    expect(doc.split('\n').length).toBeLessThan(40);
  });

  it('says what it proposed, in transport terms only, and that existing tapes were to stay untouched', () => {
    expect(doc).toContain('`scene-gate-prereg-v2`');
    expect(doc).toContain('changed only how a request that gets no reply is handled');
    expect(doc).toContain('leaving every existing tape untouched');
  });

  it('gives the reason: 20 requests a day on the Free tier against 37 to 74 needed, with the cause not shown', () => {
    expect(doc).toContain('On 2026-11-01 at 19:08 IST');
    expect(doc).toContain('**20 requests per day (RPD), tier Free**');
    expect(doc).toContain('37 to 74 requests before retries');
    expect(doc).toContain('consistent with a daily request quota');
    expect(doc).toContain('the study never read a 429 body, so the cause is not shown');
    expect(doc).toContain('No dependency on billing or on a multi-day run.');
  });

  it('says the 132 tapes are the record and that the model is incomplete under the 10% rule', () => {
    expect(doc).toContain('The 132 tapes in `tapes/` are the record');
    expect(doc).toContain('incomplete under the pre-registered 10% rule');
    expect(doc).toContain('23 of 60 generations (16 replies, all passing; 7 `transport_failure`, every failed attempt HTTP 429), 37 generations not run, and no repair round');
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
    expect(flash.filter((r) => r.outcome === 'transport_failure')).toHaveLength(7);
    expect(60 - flash.length).toBe(37);
    expect(report.rows.filter((r) => r.kind === 'repair' && r.model === FLASH)).toHaveLength(0);
    expect(listTapeFiles(tapes)).toHaveLength(132);
  });

  it.skipIf(!have)('are true about the attempts: 28 failed attempts, every one an HTTP 429', () => {
    expect(failedAttempts(tapes)[FLASH]).toEqual({ 'HTTP 429': 28 });
  });
});
