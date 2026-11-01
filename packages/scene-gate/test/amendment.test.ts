import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failedAttempts } from '../scripts/results.ts';
import { checkTapes, listTapeFiles } from '../src/harness.ts';
import { SPEND_CAP_MICRO_USD, priceFor, worstCaseMicroUsd } from '../src/spend.ts';
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
    expect(doc).toContain('Step 0 result: run on 2026-11-01 at 16:31 IST. `gemini: HTTP 200, reply parses: yes`. Inconclusive about the cause.');
    expect(doc).toContain('One successful request cannot tell the two apart');
    expect(doc).toContain('**If the request is served** (what happened)');
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

  it('records the provider facts, the open AI Studio slot, the 37 to 74 range and what a stop means', () => {
    expect(doc).toContain('Rate limits are applied per project, not per API key');
    expect(doc).toContain('reset at midnight Pacific time');
    expect(doc).toContain('**13:30 IST**');
    expect(doc).toContain('2026-11-02 13:30 IST');
    expect(doc).toContain('`OPEN`: gemini-3.8-flash RPD = __, tier = __, read on __');
    expect(doc).toContain('37 to 74 requests before retries');
    expect(doc).not.toContain('about 74 requests');
    expect(doc).toContain('**There is no second attempt under this amendment**');
    expect(doc).toContain('reported as **not run**');
    expect(doc).toContain('Decision 1 (owner, 2026-11-01): section 3 is kept as drafted.');
    expect(doc).toContain('the client does not read the body of a 429');
    expect(doc).toContain('**Status: DRAFT. Not frozen. Not run.**');
  });

  it('closes the decided items, leaves only the AI Studio values and the manifest hash open, and keeps a restart from resetting the stop count', () => {
    const section = (from: string, to: string): string => doc.slice(doc.indexOf(from), doc.indexOf(to));
    expect(section('## 3. What changes', '### If the amended run stops')).not.toContain('OPEN');
    expect(doc).toContain('**A restart does not reset the stop count.**');
    expect(doc).toContain('recomputes the number of `transport_failure` tapes already written under this amendment');
    expect(doc).toContain('The operator does not interrupt a run to avoid the stop rule.');
    expect(doc).toContain('may be missing from the ledger');
    expect(doc).toContain('Section 4 records what could be learned before freezing.');
    expect(doc).not.toContain('settles this before anything is frozen');
    expect(doc).not.toContain('SHA-256 of this document at freeze');
    expect(doc).toContain('The tag pins this document');
    expect(doc).toContain('part of this implementation and has its own tests');
    expect(doc).not.toContain('documentation on this was not checked');
    expect(doc).not.toContain('read again before freezing');
    expect(doc).toContain('These were the branches considered before Step 0.');
    expect(doc).toContain('the replacement clauses of the second and third branches do not apply');
    expect(doc).toContain('Limits vary depending on the specific model being used');
    const nine = doc.slice(doc.indexOf('## 9. Open decisions'));
    const open = nine.split('\n').filter((l) => l.includes('`OPEN`'));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatch(/^4\. /);
    for (const n of [1, 2, 3, 5, 6, 7]) expect(nine).toMatch(new RegExp(`\\n${n}\\. Decided \\(owner, 2026-11-01\\)`));
    expect(doc.match(/`OPEN`/g)?.length).toBeGreaterThan(0);
  });

  it('records the cost-cap arithmetic and what happens when the cap is reached', () => {
    expect(doc).toContain('**$6.519754**');
    expect(doc).toContain('74 × $0.06594 = $4.8796; **$1.6402 to spare**');
    expect(doc).toContain('**88 failed attempts**');
    expect(doc).toContain('**114 failed attempts = $7.5172, before any reply is priced**');
    expect(doc).toContain('**So the cap does not guarantee a full run.**');
    expect(doc).toContain('429s are not counted cheaper');
    expect(doc).toContain('the runner stops with `spend_cap`');
    expect(doc).toContain('written as a `transport_failure` tape');
    expect(doc).toContain('Decided (owner, 2026-11-01): the cap stop is accepted.');
    // the figures follow from the frozen prices and the tapes
    const worst = worstCaseMicroUsd(priceFor(FLASH, new Date('2026-11-01T00:00:00Z')));
    expect(worst).toBe(65_940);
    const remaining = SPEND_CAP_MICRO_USD - 3_480_246;
    expect(remaining).toBe(6_519_754);
    expect(74 * worst).toBe(4_879_560);
    expect(remaining - 74 * worst).toBe(1_640_194);
    expect(114 * worst).toBe(7_517_160);
    expect(114 * worst).toBeGreaterThan(remaining);
    expect(3 * 4 + 34 * 3).toBe(114);
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
