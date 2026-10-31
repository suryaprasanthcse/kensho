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

const FIX_EXAMPLE = JSON.stringify([
  { op: 'add', path: '/entities/-', value: { id: 'chest_1', kind: 'static', box_mm: [600, 600, 600], pos_mm: [8000, 300, 3000] } },
  ...Array.from({ length: 9 }, (_, i) => ({
    op: 'add',
    path: '/entities/-',
    value: { id: `coin_x${i}`, kind: 'pickup', tags: ['coin'], box_mm: [300, 300, 60], pos_mm: [-2000 - 400 * i, 600, 3000] },
  })),
]);

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
    const built = toTape('generate', request, { rawOutput: '{}', finishReason: 'stop' }, '2026-11-01T12:00:00.000Z');
    expect(built).toMatchObject({ prompt_hash: sha256Hex('hello'), system_hash: sha256Hex('sys'), sample: 1, timestamp: '2026-11-01T12:00:00.000Z' });
    expect(TapeSchema.safeParse(built).success).toBe(true);
  });
});

describe('the draft prompts', () => {
  const file = loadPrompts(PROMPTS);

  it('are marked DRAFT, twenty in number, ten ordinary and ten structured', () => {
    expect(file.status).toBe('DRAFT');
    expect(file.note).toContain('DRAFT');
    expect(file.prompts).toHaveLength(20);
    expect(file.prompts.filter((p) => p.category === 'ordinary')).toHaveLength(10);
    expect(file.prompts.filter((p) => p.category === 'structured')).toHaveLength(10);
  });

  it('have unique ids and distinct texts', () => {
    expect(new Set(file.prompts.map((p) => p.id)).size).toBe(20);
    expect(new Set(file.prompts.map((p) => p.text)).size).toBe(20);
  });

  it('come with a system prompt that is also marked DRAFT', () => {
    expect(readFileSync(SYSTEM, 'utf8').startsWith('<!-- DRAFT')).toBe(true);
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
    writeTape(root, tape({ kind: 'repair', sample: 1, raw_output: FIX_EXAMPLE }));
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
    expect(report.rows.find((r) => r.kind === 'repair')).toMatchObject({ verdict: 'pass', repair: { status: 'accepted', fully_fixed: true } });
  });

  it('counts a repair tape whose patch is not JSON, or is refused, as a refusal', () => {
    seed();
    writeTape(root, tape({ kind: 'repair', sample: 0, raw_output: 'sorry' }));
    writeTape(root, tape({ kind: 'repair', sample: 2, raw_output: '[]' }));
    const report = checkTapes(root);
    expect(report.summary.repair).toMatchObject({ attempted: 3, accepted: 1, refusals: { invalid_patch: 1, not_shrinking: 1 } });
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
