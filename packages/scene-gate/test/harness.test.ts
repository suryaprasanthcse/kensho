import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TAPE_VERSION,
  TapeSchema,
  checkTapes,
  listTapeFiles,
  loadPrompts,
  readTape,
  tapePath,
  toTape,
  writeTape,
  type GenerationRequest,
  type Tape,
} from '../src/harness.ts';
import { SEMANTIC_CODES } from '../src/diagnostic.ts';
import { OVERLAP_TOLERANCE_MM, STEP_RADIUS_MM, SUPPORT_TOLERANCE_MM } from '../src/thresholds.ts';
import { sha256Hex } from '../src/verdict.ts';
import { EXAMPLE_SCENE, cleanScene } from './fixtures.ts';

const PACKAGE = resolve(import.meta.dirname, '..');
const PROMPTS = join(PACKAGE, 'prompts', 'prompts.json');
const SYSTEM = join(PACKAGE, 'prompts', 'system.md');

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), 'scene-gate-tapes-'))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

const tape = (over: Partial<Tape> = {}): Tape => ({
  version: TAPE_VERSION,
  kind: 'generate',
  model: 'model-a',
  parameters: { temperature: 1, max_tokens: 4096 },
  prompt_id: 'ord-01',
  prompt_hash: sha256Hex('A small arena with crates and five coins.'),
  system_hash: sha256Hex('system'),
  sample: 0,
  raw_output: JSON.stringify(cleanScene()),
  finish_reason: 'stop',
  timestamp: '2026-11-01T00:00:00.000Z',
  ...over,
});

/** The example scene with its missing guard target and nine missing coins added: the corrected scene a repair reply holds. */
const FIXED_EXAMPLE = JSON.stringify({
  ...EXAMPLE_SCENE,
  entities: [
    ...EXAMPLE_SCENE.entities,
    { id: 'chest_1', kind: 'static', box_mm: [600, 600, 600], pos_mm: [8000, 300, 3000] },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `coin_x${i}`, kind: 'pickup', tags: ['coin'], box_mm: [300, 300, 60], pos_mm: [-2000 - 400 * i, 600, 3000] })),
  ],
});

describe('tapes', () => {
  it('require every recorded field', () => {
    expect(TapeSchema.safeParse(tape()).success).toBe(true);
    for (const field of ['model', 'parameters', 'prompt_hash', 'raw_output', 'timestamp', 'version'] as const) {
      const broken: Record<string, unknown> = { ...tape() };
      delete broken[field];
      expect(TapeSchema.safeParse(broken).success, field).toBe(false);
    }
    expect(TapeSchema.safeParse({ ...tape(), prompt_hash: 'abc' }).success).toBe(false);
    expect(TapeSchema.safeParse({ ...tape(), timestamp: 'yesterday' }).success).toBe(false);
  });

  it('live at <root>/<model>/<prompt>/<sample>.<kind>.json with a filesystem-safe model slug', () => {
    expect(tapePath('r', tape())).toBe(join('r', 'model-a', 'ord-01', '0.generate.json'));
    expect(tapePath('r', tape({ model: 'org/model:v1', kind: 'repair', sample: 2 }))).toBe(join('r', 'org_model_v1', 'ord-01', '2.repair.json'));
    expect(tapePath('r', tape({ model: '..' }))).toBe(join('r', '_', 'ord-01', '0.generate.json'));
  });

  it('record provider usage, which must be integers or null, and never use it for a verdict', () => {
    const usage = { promptTokenCount: 1200, candidatesTokenCount: 900, thoughtsTokenCount: null, totalTokenCount: 2100 };
    expect(TapeSchema.safeParse({ ...tape(), usage }).success).toBe(true);
    expect(TapeSchema.safeParse({ ...tape(), usage: { promptTokenCount: 1.5 } }).success).toBe(false);
    expect(TapeSchema.safeParse({ ...tape(), usage: { promptTokenCount: '12' } }).success).toBe(false);
    const path = writeTape(root, tape({ usage }));
    expect(readTape(path).usage).toEqual(usage);
    const withUsage = checkTapes(root).rows[0]!;
    rmSync(path);
    writeTape(root, tape());
    expect(checkTapes(root).rows[0]).toEqual(withUsage);
  });

  it('are written once and read back unchanged', () => {
    const path = writeTape(root, tape());
    expect(existsSync(path)).toBe(true);
    expect(readTape(path)).toEqual(tape());
    expect(() => writeTape(root, tape({ raw_output: 'different' }))).toThrow(/EEXIST/);
    expect(readTape(path).raw_output).toBe(tape().raw_output);
  });

  it('are built from a request and response without touching a clock', () => {
    const request: GenerationRequest = {
      model: 'm',
      parameters: { temperature: 0 },
      system: 'sys',
      prompt: { id: 'p1', text: 'hello' },
      sample: 1,
      jsonSchema: {},
    };
    const usage = { promptTokenCount: 10, candidatesTokenCount: 20 };
    const built = toTape('generate', request, { rawOutput: '{}', finishReason: 'stop', usage }, '2026-11-01T12:00:00.000Z');
    expect(built).toMatchObject({ prompt_hash: sha256Hex('hello'), system_hash: sha256Hex('sys'), sample: 1, timestamp: '2026-11-01T12:00:00.000Z', usage });
    expect(toTape('generate', request, { rawOutput: '{}', finishReason: null }, '2026-11-01T12:00:00.000Z')).not.toHaveProperty('usage');
    expect(TapeSchema.safeParse(built).success).toBe(true);
  });
});

describe('the draft prompts', () => {
  const file = loadPrompts(PROMPTS);

  it('are twenty in number, ten ordinary and ten structured', () => {
    expect(file.prompts).toHaveLength(20);
    expect(file.prompts.filter((p) => p.category === 'ordinary')).toHaveLength(10);
    expect(file.prompts.filter((p) => p.category === 'structured')).toHaveLength(10);
  });

  it('give the stacked-crates prompt an objective and the switch prompt a locked door, a key and a goal', () => {
    const text = (id: string): string => file.prompts.find((p) => p.id === id)!.text;
    expect(text('str-04')).toBe('A tower of three stacked crates standing beside a wall, with one coin on the floor next to the tower. The objective is to collect the coin.');
    expect(text('str-08')).toBe(
      'Two rooms joined by a locked door. The key is in the first room, along with a switch coin that emits a signal when collected. The goal marker in the second room must be reached.',
    );
  });

  it('have unique ids and distinct texts', () => {
    expect(new Set(file.prompts.map((p) => p.id)).size).toBe(20);
    expect(new Set(file.prompts.map((p) => p.text)).size).toBe(20);
  });

  it('carry no status or draft marker in any of the three files, because system.md and repair.md are sent to the model', () => {
    for (const name of ['prompts.json', 'system.md', 'repair.md']) {
      const text = readFileSync(join(PACKAGE, 'prompts', name), 'utf8');
      expect(text, name).not.toMatch(/DRAFT|FROZEN|<!--|-->/);
    }
    expect(Object.keys(JSON.parse(readFileSync(PROMPTS, 'utf8')))).toEqual(['prompts']);
    expect(readFileSync(SYSTEM, 'utf8').startsWith('You write game scenes')).toBe(true);
  });

  it('state the rules in plain words, without naming any diagnostic code', () => {
    const text = readFileSync(SYSTEM, 'utf8');
    for (const code of [...SEMANTIC_CODES, 'SCHEMA_INVALID']) expect(text).not.toContain(code);
    expect(text).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
  });

  it('quote the thresholds of the default checks, and say nothing of the optional height check', () => {
    const text = readFileSync(SYSTEM, 'utf8');
    expect(text).toContain(`${OVERLAP_TOLERANCE_MM} mm`);
    expect(text).toContain(`${SUPPORT_TOLERANCE_MM} mm`);
    expect(text).not.toContain(`${STEP_RADIUS_MM}`);
    expect(text).not.toContain('must collect or reach');
    expect(text.trimEnd().endsWith('So does the player box at the spawn point.')).toBe(true);
  });

  it('cover every rule the default checks enforce', () => {
    const text = readFileSync(SYSTEM, 'utf8').toLowerCase();
    for (const phrase of ['share an id', 'right kind of entity', 'never asks for more', 'loop', 'locked away', 'overlap each other', 'spawn point', 'resting on something', 'inside `bounds_mm`']) {
      expect(text, phrase).toContain(phrase);
    }
  });
});

describe('check-tapes', () => {
  const seed = (): void => {
    for (const [sample, raw] of [
      [0, JSON.stringify(cleanScene())],
      [1, JSON.stringify(EXAMPLE_SCENE)],
      [2, JSON.stringify(cleanScene())],
    ] as const) {
      writeTape(root, tape({ sample, raw_output: raw }));
    }
    for (let sample = 0; sample < 3; sample++) {
      writeTape(root, tape({ prompt_id: 'ord-02', sample, raw_output: JSON.stringify(cleanScene()).slice(0, 300), finish_reason: 'length' }));
    }
    writeTape(root, tape({ kind: 'repair', sample: 1, raw_output: FIXED_EXAMPLE }));
  };

  it('re-checks every tape and summarises per model', () => {
    seed();
    const report = checkTapes(root);
    const verdicts = Object.fromEntries(report.rows.filter((r) => r.kind === 'generate').map((r) => [`${r.prompt_id}/${r.sample}`, r.verdict]));
    expect(verdicts).toEqual({
      'ord-01/0': 'pass',
      'ord-01/1': 'fail',
      'ord-01/2': 'pass',
      'ord-02/0': 'schema_invalid',
      'ord-02/1': 'schema_invalid',
      'ord-02/2': 'schema_invalid',
    });
    const m = report.summary.models['model-a']!;
    expect(m.tapes).toBe(6);
    expect(m.verdicts).toEqual({ pass: 2, fail: 1, schema_invalid: 3 });
    expect(m.schema_invalid_reasons).toEqual({ truncated: 3 });
    expect(m.error_codes).toEqual({ OBJECTIVE_COUNT: 1, UNRESOLVED_REF: 1 });
    expect(m.unplayable).toMatchObject({ schemaValid: 3, unplayable: 1, schemaInvalid: 3 });
    expect(m.flip).toMatchObject({ triples: 2, flips: 1 });
  });

  it('applies repair tapes to their generate tape and reports the outcome', () => {
    seed();
    const report = checkTapes(root);
    expect(report.summary.repair).toMatchObject({ attempted: 1, accepted: 1, fully_fixed: 1, refusals: {} });
    expect(report.rows.find((r) => r.kind === 'repair')).toMatchObject({ verdict: 'pass', repair: { status: 'accepted', fully_fixed: true, ops: 10 } });
    expect(report.summary.repair.ops).toEqual({ n: 1, total: 10, median: 10, max: 10 });
    expect(report.summary.repair.ops_accepted).toEqual({ n: 1, total: 10, median: 10, max: 10 });
  });

  it('counts a repair reply that is not a JSON object, or that fixes nothing, as a refusal, and counts the operations', () => {
    seed();
    writeTape(root, tape({ kind: 'repair', sample: 0, raw_output: 'sorry' }));
    writeTape(root, tape({ kind: 'repair', sample: 2, raw_output: JSON.stringify(cleanScene()) }));
    const report = checkTapes(root);
    expect(report.summary.repair).toMatchObject({ attempted: 3, accepted: 1, refusals: { unparseable_reply: 1, not_shrinking: 1 } });
    expect(report.summary.repair.ops).toEqual({ n: 2, total: 10, median: 5, max: 10 });
    expect(report.summary.repair.ops_accepted).toEqual({ n: 1, total: 10, median: 10, max: 10 });
    const rows = Object.fromEntries(report.rows.filter((r) => r.kind === 'repair').map((r) => [r.sample, r.repair]));
    expect(rows[0]).toEqual({ status: 'refused', reason: 'unparseable_reply' });
    expect(rows[2]).toEqual({ status: 'refused', reason: 'not_shrinking', ops: 0 });
  });

  it('computes the patch from the reply itself, so the operations can be recounted from the tape', () => {
    seed();
    const first = checkTapes(root).rows.find((r) => r.kind === 'repair');
    const second = checkTapes(root).rows.find((r) => r.kind === 'repair');
    expect(second).toEqual(first);
  });

  it('is deterministic: two runs give identical reports, in path order', () => {
    seed();
    const a = JSON.stringify(checkTapes(root));
    const b = JSON.stringify(checkTapes(root));
    expect(a).toBe(b);
    const paths = checkTapes(root).rows.map((r) => r.path);
    expect(paths).toEqual([...paths].sort());
    expect(listTapeFiles(root)).toEqual(paths);
  });

  it('reports an unreadable tape and a repair with no parent as errors, not as verdicts', () => {
    writeTape(root, tape({ kind: 'repair', sample: 5, raw_output: '[]' }));
    mkdirSync(join(root, 'model-a', 'junk'), { recursive: true });
    writeFileSync(join(root, 'model-a', 'junk', '0.generate.json'), '{ not json');
    const report = checkTapes(root);
    expect(report.summary.errors).toBe(2);
    expect(report.rows.every((r) => r.error && !r.verdict)).toBe(true);
  });

  it('flags tapes that drifted from the frozen prompts and system text', () => {
    const prompts = loadPrompts(PROMPTS);
    const system = readFileSync(SYSTEM, 'utf8');
    const first = prompts.prompts[0]!;
    writeTape(root, tape({ prompt_id: first.id, prompt_hash: sha256Hex(first.text), system_hash: sha256Hex(system), sample: 0 }));
    writeTape(root, tape({ prompt_id: first.id, prompt_hash: sha256Hex(first.text + '!'), system_hash: sha256Hex(system), sample: 1 }));
    writeTape(root, tape({ prompt_id: first.id, prompt_hash: sha256Hex(first.text), system_hash: sha256Hex(system + '\n'), sample: 2 }));
    writeTape(root, tape({ prompt_id: 'not-a-prompt', sample: 3 }));
    const report = checkTapes(root, { expect: { prompts, system } });
    const driftBySample = Object.fromEntries(report.rows.map((r) => [r.sample, r.drift]));
    expect(driftBySample).toEqual({ 0: undefined, 1: 'prompt_hash', 2: 'system_hash', 3: 'unknown_prompt' });
    expect(report.summary.drift).toBe(3);
    expect(checkTapes(root).summary.drift).toBe(0);
  });

  it('runs from the command line and prints the same report', () => {
    seed();
    const repoRoot = resolve(PACKAGE, '..', '..');
    const bin = join(PACKAGE, 'src', 'bin.ts');
    const out = execFileSync(process.execPath, ['--import', 'tsx', bin, 'check-tapes', root], { cwd: repoRoot, encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual(JSON.parse(JSON.stringify(checkTapes(root))));
    const bad = spawnSync(process.execPath, ['--import', 'tsx', bin, 'nonsense'], { cwd: repoRoot, encoding: 'utf8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('usage:');
  });
});

describe('transport_failure tapes', () => {
  const attempt = (n: number, over: Record<string, unknown> = {}) => ({
    attempt: n, started: '2026-11-01T00:00:00.000Z', duration_ms: 180000, http_status: null, error: 'TimeoutError', usage: null, cost_micro_usd: 22_280, ...over,
  });
  const failure = (over: Partial<Tape> = {}): Tape => tape({ outcome: 'transport_failure', raw_output: '', finish_reason: undefined, attempts: [attempt(1), attempt(2)], ...over });

  it('are valid only with empty output, no usage, and at least one attempt', () => {
    expect(TapeSchema.safeParse(failure()).success).toBe(true);
    expect(TapeSchema.safeParse(failure({ raw_output: '{}' })).success).toBe(false);
    expect(TapeSchema.safeParse(failure({ attempts: [] })).success).toBe(false);
    expect(TapeSchema.safeParse(failure({ attempts: undefined })).success).toBe(false);
    expect(TapeSchema.safeParse(failure({ usage: { promptTokenCount: 1 } })).success).toBe(false);
  });

  it('log attempts in a strict shape: integers only, an ISO start, an error class and not a message', () => {
    expect(TapeSchema.safeParse(failure({ attempts: [attempt(1, { cost_micro_usd: 1.5 })] })).success).toBe(false);
    expect(TapeSchema.safeParse(failure({ attempts: [attempt(0)] })).success).toBe(false);
    expect(TapeSchema.safeParse(failure({ attempts: [attempt(1, { started: 'soon' })] })).success).toBe(false);
    expect(TapeSchema.safeParse(failure({ attempts: [{ ...attempt(1), message: 'x' } as never] })).success).toBe(false);
  });

  it('are reported apart from schema_invalid, stay in the tape count, and carry no verdict', () => {
    writeTape(root, tape({ sample: 0 }));
    writeTape(root, failure({ sample: 1 }));
    writeTape(root, tape({ sample: 2, raw_output: '{"scene": ' }));
    const report = checkTapes(root);
    const m = report.summary.models['model-a']!;
    expect(m.tapes).toBe(3);
    expect(m.verdicts).toEqual({ pass: 1, fail: 0, schema_invalid: 1 });
    expect(m.transport_failures).toBe(1);
    expect(m.schema_invalid_reasons).toEqual({ truncated: 1 });
    expect(m.unplayable).toMatchObject({ generations: 3, schemaValid: 1, schemaInvalid: 1, transportFailures: 1 });
    const row = report.rows.find((r) => r.sample === 1)!;
    expect(row).toMatchObject({ outcome: 'transport_failure', attempts: 2, spend_micro_usd: 44_560 });
    expect(row.verdict).toBeUndefined();
    expect(row.hash).toBeUndefined();
  });

  it('count in the flip rate as an outcome, and are shown excluded beside it', () => {
    writeTape(root, tape({ sample: 0 }));
    writeTape(root, tape({ sample: 1 }));
    writeTape(root, failure({ sample: 2 }));
    const flip = checkTapes(root).summary.models['model-a']!.flip;
    expect(flip).toMatchObject({ triples: 1, flips: 1 });
    expect(flip.excludingTransport).toMatchObject({ triples: 0, flips: 0 });
  });

  it('count every attempt of every tape toward the spend, per model and in total', () => {
    writeTape(root, tape({ sample: 0, attempts: [attempt(1, { http_status: 200, error: null, cost_micro_usd: 5_300 })] }));
    writeTape(root, failure({ sample: 1 }));
    writeTape(root, failure({ kind: 'repair', sample: 1, attempts: [attempt(1, { cost_micro_usd: 1_000 })] }));
    const report = checkTapes(root);
    expect(report.summary.models['model-a']).toMatchObject({ attempts: 4, spend_micro_usd: 5_300 + 44_560 + 1_000 });
    expect(report.summary.spend_micro_usd).toBe(50_860);
  });

  it('a failed repair request is a refusal that stays in the repair denominator', () => {
    writeTape(root, tape({ sample: 1, raw_output: JSON.stringify(EXAMPLE_SCENE) }));
    writeTape(root, failure({ kind: 'repair', sample: 1 }));
    const report = checkTapes(root);
    expect(report.summary.repair).toMatchObject({ attempted: 1, accepted: 0, refusals: { transport_failure: 1 } });
    expect(report.summary.repair.ops.n).toBe(0);
    expect(report.rows.find((r) => r.kind === 'repair')).toMatchObject({ outcome: 'transport_failure', repair: { status: 'refused', reason: 'transport_failure' } });
  });

  it('are kept apart from schema_invalid in the generation tape count of a model that has only failures', () => {
    writeTape(root, failure({ sample: 0 }));
    const m = checkTapes(root).summary.models['model-a']!;
    expect(m).toMatchObject({ tapes: 1, transport_failures: 1, verdicts: { pass: 0, fail: 0, schema_invalid: 0 } });
  });
});
