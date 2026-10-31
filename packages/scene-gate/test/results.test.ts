import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildResults, exploratoryOne, exploratoryTwo, failedAttempts } from '../scripts/results.ts';
import { loadPrompts, TAPE_VERSION, writeTape, checkTapes, type Tape } from '../src/harness.ts';
import { sha256Hex } from '../src/verdict.ts';
import { box, cleanScene, edited } from './fixtures.ts';

const PACKAGE = resolve(import.meta.dirname, '..');
const PROMPTS = loadPrompts(join(PACKAGE, 'prompts', 'prompts.json'));
const SYSTEM = readFileSync(join(PACKAGE, 'prompts', 'system.md'), 'utf8');
const LITE = 'gemini-3.5-flash-lite';
const FLASH = 'gemini-3.8-flash';

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), 'scene-gate-results-'))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

const text = (id: string) => PROMPTS.prompts.find((p) => p.id === id)!.text;
const attempt = (status: number | null, error: string | null = null) => ({ attempt: 1, started: '2026-11-01T00:00:00.000Z', duration_ms: 1, http_status: status, error, usage: null, cost_micro_usd: 100 });

function tape(model: string, prompt_id: string, sample: number, raw: string | 'transport_failure', status = 429): Tape {
  const base = {
    version: TAPE_VERSION as typeof TAPE_VERSION, kind: 'generate' as const, model, parameters: {}, prompt_id, prompt_hash: sha256Hex(text(prompt_id)), system_hash: sha256Hex(SYSTEM), sample, timestamp: '2026-11-01T00:00:00.000Z',
  };
  return raw === 'transport_failure'
    ? { ...base, outcome: 'transport_failure', raw_output: '', attempts: [attempt(status)] }
    : { ...base, raw_output: raw, finish_reason: 'STOP', attempts: [attempt(200)] };
}

const PASS = JSON.stringify(cleanScene());
const OOB_ONLY = JSON.stringify(edited((s) => void (s.entities[0]!.pos_mm = [0, 1500, -30000])));
const OVERLAP_ONLY = JSON.stringify(edited((s) => void s.entities.push(box('wall_extra', 'static', [100, 1500, -8000], [10000, 3000, 200]))));
const BOTH = JSON.stringify(edited((s) => { s.entities[0]!.pos_mm = [0, 1500, -30000]; s.entities.push(box('block', 'static', [3000, 400, 2000], [800, 800, 800])); }));

/** lite has 6 generations, flash has 3 scenes and 2 transport failures on other pairs. */
function seed(): void {
  const lite: [string, number, string][] = [
    ['ord-01', 0, PASS], ['ord-01', 1, OOB_ONLY], ['ord-01', 2, OVERLAP_ONLY], ['ord-02', 0, BOTH], ['ord-02', 1, 'transport_failure'], ['ord-02', 2, OOB_ONLY],
  ];
  for (const [id, s, raw] of lite) writeTape(root, tape(LITE, id, s, raw));
  const flash: [string, number, string][] = [
    ['ord-01', 0, PASS], ['ord-01', 1, PASS], ['ord-01', 2, OOB_ONLY], ['ord-02', 0, 'transport_failure'], ['ord-02', 1, 'transport_failure'],
  ];
  for (const [id, s, raw] of flash) writeTape(root, tape(FLASH, id, s, raw));
}
const rows = () => checkTapes(root).rows;

describe('E1: the first model on the pairs where the second produced a scene', () => {
  it('takes exactly the second model\'s non-failed pairs, and counts the first model there', () => {
    seed();
    const e1 = exploratoryOne(rows(), LITE, FLASH);
    expect(e1.pairs).toEqual(['ord-01/0', 'ord-01/1', 'ord-01/2']);
    // lite on those: pass, oob-only fail, overlap-only fail
    expect(e1.subject).toEqual({ schemaValid: 3, fail: 2, schemaInvalid: 0, transportFailure: 0, missing: 0 });
    expect(e1.reference).toEqual({ schemaValid: 3, fail: 1 });
  });

  it('keeps a pair where the first model had a transport failure or no tape out of its denominator, and says so', () => {
    seed();
    writeTape(root, tape(FLASH, 'ord-02', 2, PASS));
    writeTape(root, tape(FLASH, 'ord-03', 0, PASS));
    const e1 = exploratoryOne(rows(), LITE, FLASH);
    expect(e1.pairs).toEqual(['ord-01/0', 'ord-01/1', 'ord-01/2', 'ord-02/2', 'ord-03/0']);
    expect(e1.subject).toEqual({ schemaValid: 4, fail: 3, schemaInvalid: 0, transportFailure: 0, missing: 1 });
  });

  it('does not count a pair where the second model had a transport failure, whatever the first model did', () => {
    seed();
    expect(exploratoryOne(rows(), LITE, FLASH).pairs).not.toContain('ord-02/0');
    expect(exploratoryOne(rows(), LITE, FLASH).pairs).not.toContain('ord-02/1');
  });
});

describe('E2: the failure rate with OUT_OF_BOUNDS ignored', () => {
  it('counts a failing scene only if it has some other error code', () => {
    seed();
    const e2 = exploratoryTwo(rows(), LITE);
    // schema-valid: pass, oob, overlap, both, oob = 5 (the transport failure is not a scene)
    expect(e2).toEqual({ schemaValid: 5, failing: 4, failingWithoutBounds: 2, onlyBounds: 2, otherCodes: { SPATIAL_OVERLAP: 2 } });
  });

  it('is zero for a model that never has another code, and for one with no scenes', () => {
    seed();
    expect(exploratoryTwo(rows(), FLASH)).toMatchObject({ schemaValid: 3, failing: 1, failingWithoutBounds: 0, onlyBounds: 1 });
    expect(exploratoryTwo(rows(), 'no-such-model')).toMatchObject({ schemaValid: 0, failing: 0 });
  });
});

describe('the failed attempts of transport failures', () => {
  it('are counted by HTTP status or error class, per model, from the tapes', () => {
    seed();
    writeTape(root, { ...tape(FLASH, 'ord-03', 1, 'transport_failure', 503), attempts: [attempt(503), attempt(null, 'TimeoutError')] });
    expect(failedAttempts(root)).toEqual({ [LITE]: { 'HTTP 429': 1 }, [FLASH]: { 'HTTP 429': 2, 'HTTP 503': 1, TimeoutError: 1 } });
  });
});

describe('RESULTS.md', () => {
  it('puts the pre-registered metrics first and labels the exploratory analyses as not pre-registered', () => {
    seed();
    const md = buildResults(root, PROMPTS, SYSTEM);
    const at = (s: string) => md.indexOf(s);
    expect(at('## 1. Pre-registered metrics')).toBeGreaterThan(-1);
    expect(at('## 1. Pre-registered metrics')).toBeLessThan(at('## 2. Exploratory analyses: NOT pre-registered'));
    expect(md).toContain('**Both analyses below were chosen after the pre-registered results were seen.');
    expect(at('### E1.')).toBeGreaterThan(at('## 2. Exploratory analyses: NOT pre-registered'));
    expect(at('### E2.')).toBeGreaterThan(at('### E1.'));
    expect(md).toContain('M1 unplayable rate: fail / (pass + fail)');
  });

  it('is deterministic', () => {
    seed();
    expect(buildResults(root, PROMPTS, SYSTEM)).toBe(buildResults(root, PROMPTS, SYSTEM));
  });

  it('is the committed RESULTS.md, regenerated from the committed tapes', () => {
    const tapes = join(PACKAGE, 'tapes');
    const file = join(PACKAGE, 'RESULTS.md');
    if (!existsSync(tapes) || !existsSync(file)) return;
    expect(readFileSync(file, 'utf8')).toBe(buildResults(tapes, PROMPTS, SYSTEM));
  });
});
