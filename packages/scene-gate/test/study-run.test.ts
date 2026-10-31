import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkTapes, listTapeFiles, loadPrompts, readTape, type GenerationRequest, type ProviderClient, type RepairRequest } from '../src/harness.ts';
import { sceneJsonSchema } from '../src/json-schema.ts';
import { SpendLedger } from '../src/spend.ts';
import { STUDY_MODELS, STUDY_TAG, STUDY_TAPES_PATH } from '../src/study.ts';
import { PROMPT_FILES, gitState, preflight, recordedHashes, resolveTapesArg, runStudy, sha256OfBytes, type GitState, type PromptFile, type StudyConfig } from '../src/study-run.ts';
import type { ProviderReply } from '../src/transport.ts';
import { EXAMPLE_SCENE } from './fixtures.ts';

// Fake client only: nothing here sends a request to a provider, and nothing here starts the real study.
const PACKAGE = resolve(import.meta.dirname, '..');
const PROMPTS = loadPrompts(join(PACKAGE, 'prompts', 'prompts.json')).prompts;
const SYSTEM = readFileSync(join(PACKAGE, 'prompts', 'system.md'), 'utf8');
const TEMPLATE = readFileSync(join(PACKAGE, 'prompts', 'repair.md'), 'utf8');
const PREREG = readFileSync(join(PACKAGE, 'PREREGISTRATION.md'), 'utf8');
const FILES = Object.fromEntries(PROMPT_FILES.map((f) => [f, readFileSync(join(PACKAGE, 'prompts', f))])) as Record<PromptFile, Buffer>;
const COMMIT = 'a'.repeat(40);

const USAGE = { promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: null, totalTokenCount: 1500 };
const reply = (rawOutput: string): ProviderReply => ({ status: 200, response: { rawOutput, finishReason: 'STOP', usage: USAGE } });
const FAILING = JSON.stringify(EXAMPLE_SCENE);
const FIXED = JSON.stringify({
  ...EXAMPLE_SCENE,
  entities: [
    ...EXAMPLE_SCENE.entities,
    { id: 'chest_1', kind: 'static', box_mm: [600, 600, 600], pos_mm: [8000, 300, 3000] },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `coin_x${i}`, kind: 'pickup', tags: ['coin'], box_mm: [300, 300, 60], pos_mm: [-2000 - 400 * i, 600, 3000] })),
  ],
});

interface Call {
  readonly phase: 'generate' | 'repair';
  readonly model: string;
  readonly prompt: string;
  readonly sample: number;
}

function fakeClient(onGenerate: (r: GenerationRequest, n: number) => ProviderReply = () => reply(FAILING), onRepair: (r: RepairRequest, n: number) => ProviderReply = () => reply(FIXED)) {
  const calls: Call[] = [];
  const client: ProviderClient = {
    generate: async (r) => (calls.push({ phase: 'generate', model: r.model, prompt: r.prompt.id, sample: r.sample }), onGenerate(r, calls.filter((c) => c.phase === 'generate').length)),
    repair: async (r) => (calls.push({ phase: 'repair', model: r.model, prompt: r.prompt.id, sample: r.sample }), onRepair(r, calls.filter((c) => c.phase === 'repair').length)),
  };
  return { client, calls };
}

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), 'scene-gate-study-'))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

const config = (client: ProviderClient, ledger = new SpendLedger()): StudyConfig & { sleeps: number[] } => {
  const sleeps: number[] = [];
  let t = Date.parse('2026-11-02T00:00:00Z');
  return {
    prompts: PROMPTS,
    system: SYSTEM,
    template: TEMPLATE,
    jsonSchema: sceneJsonSchema('gemini'),
    deps: { client, tapeRoot: root, commit: COMMIT, ledger, sleep: async (ms) => void sleeps.push(ms), now: () => new Date((t += 1000)) },
    sleeps,
  };
};

const git = (over: Partial<GitState> = {}): GitState => ({ head: () => COMMIT, tagCommit: () => COMMIT, dirty: () => [], ...over });

describe('what must hold before the study starts', () => {
  const input = (over: Partial<Parameters<typeof preflight>[0]> = {}) => ({ preregistration: PREREG, files: FILES, git: git(), ...over });

  it('passes for the real prompt files, the real preregistration, a clean tree and HEAD on the tag', () => {
    expect(preflight(input())).toEqual([]);
    expect(Object.keys(recordedHashes(PREREG))).toEqual(['prompts.json', 'system.md', 'repair.md']);
  });

  it.each(PROMPT_FILES)('refuses when %s differs from the SHA-256 in PREREGISTRATION.md, even by one byte', (file) => {
    const changed = { ...FILES, [file]: Buffer.concat([FILES[file], Buffer.from(' ')]) };
    const problems = preflight(input({ files: changed }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${file}: SHA-256 ${sha256OfBytes(changed[file])} does not match the ${recordedHashes(PREREG)[file]}`);
  });

  it('refuses when the preregistration records no hash for a file', () => {
    const problems = preflight(input({ preregistration: PREREG.replace(/\| SHA-256 of `repair\.md` \| `[0-9a-f]{64}` \|/, '') }));
    expect(problems).toEqual(['PREREGISTRATION.md records no SHA-256 for repair.md']);
  });

  it('refuses a dirty working tree, naming the paths', () => {
    const problems = preflight(input({ git: git({ dirty: () => [' M packages/scene-gate/src/runner.ts', '?? notes.txt'] }) }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the working tree is not clean (2 paths)');
    expect(problems[0]).toContain('packages/scene-gate/src/runner.ts');
  });

  it('refuses when HEAD is not the commit the tag names, and when there is no tag', () => {
    const other = 'b'.repeat(40);
    expect(preflight(input({ git: git({ head: () => other }) }))).toEqual([`HEAD ${other} is not the commit tagged ${STUDY_TAG} (${COMMIT})`]);
    expect(preflight(input({ git: git({ tagCommit: () => null }) }))).toEqual([`there is no tag ${STUDY_TAG}, so there is no frozen commit to run from`]);
  });

  it('reports every problem at once', () => {
    const problems = preflight(input({ files: { ...FILES, 'system.md': Buffer.from('changed') }, git: git({ dirty: () => ['?? x'], head: () => 'c'.repeat(40) }) }));
    expect(problems).toHaveLength(3);
  });

  it('names the tag the preregistration names', () => {
    expect(PREREG).toContain(`\`${STUDY_TAG}\``);
    expect(STUDY_TAG).toBe('scene-gate-prereg-v2');
  });
});

describe('reading the repository with git', () => {
  let repo: string;
  const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'scene-gate-repo-'));
    run('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    run('add', '.');
    run('commit', '-q', '-m', 'one');
    run('tag', 'frozen');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('finds HEAD and the commit a tag names, and null for a tag that does not exist', () => {
    const state = gitState(repo);
    expect(state.head()).toBe(run('rev-parse', 'HEAD'));
    expect(state.tagCommit('frozen')).toBe(state.head());
    expect(state.tagCommit('missing')).toBeNull();
  });

  it('calls a fresh checkout clean and ignores everything under the tapes directory', () => {
    const state = gitState(repo);
    expect(state.dirty()).toEqual([]);
    mkdirSync(join(repo, STUDY_TAPES_PATH, 'gemini-3.5-flash-lite', 'ord-01'), { recursive: true });
    writeFileSync(join(repo, STUDY_TAPES_PATH, 'gemini-3.5-flash-lite', 'ord-01', '0.generate.json'), '{}');
    expect(state.dirty()).toEqual([]);
  });

  it('calls a modified, staged or untracked file outside the tapes directory dirty', () => {
    const state = gitState(repo);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    expect(state.dirty()).toEqual([' M a.txt']);
    run('add', 'a.txt');
    expect(state.dirty()).toEqual(['M  a.txt']);
    writeFileSync(join(repo, 'b.txt'), 'new\n');
    expect(state.dirty()).toEqual(['M  a.txt', '?? b.txt']);
  });

  it('sees HEAD move off the tag after another commit, so the study would refuse', () => {
    const state = gitState(repo, STUDY_TAPES_PATH);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    run('commit', '-q', '-am', 'two');
    expect(state.dirty()).toEqual([]);
    const problems = preflight({ preregistration: PREREG, files: FILES, git: { ...state, tagCommit: (t) => state.tagCommit(t === STUDY_TAG ? 'frozen' : t) } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is not the commit tagged');
  });
});

describe('the --tapes argument', () => {
  const repoRoot = resolve('/some/repo');
  it('accepts the study tapes directory from the repository root, as pnpm reports it', () => {
    expect(resolveTapesArg('packages/scene-gate/tapes', repoRoot, repoRoot)).toBe(resolve(repoRoot, STUDY_TAPES_PATH));
    expect(resolveTapesArg('packages/scene-gate/tapes/', repoRoot, repoRoot)).toBe(resolve(repoRoot, STUDY_TAPES_PATH));
  });

  it('accepts it from the package directory too, and from anywhere with a path that reaches it', () => {
    expect(resolveTapesArg('tapes', resolve(repoRoot, 'packages', 'scene-gate'), repoRoot)).toBe(resolve(repoRoot, STUDY_TAPES_PATH));
    expect(resolveTapesArg(resolve(repoRoot, STUDY_TAPES_PATH), '/elsewhere', repoRoot)).toBe(resolve(repoRoot, STUDY_TAPES_PATH));
  });

  it('refuses any other directory and a missing argument', () => {
    for (const bad of ['tapes', 'packages/scene-gate', 'packages/scene-gate/tapes-e2e', '../tapes', '/tmp/tapes']) {
      expect(() => resolveTapesArg(bad, repoRoot, repoRoot), bad).toThrow(/--tapes must be packages\/scene-gate\/tapes/);
    }
    expect(() => resolveTapesArg(undefined, repoRoot, repoRoot)).toThrow('--tapes is required');
  });

  it('is checked by the command before anything else: a wrong path exits 2 with no key read and no request', () => {
    const script = join(PACKAGE, 'scripts', 'run-study.ts');
    const wrong = spawnSync(process.execPath, ['--import', 'tsx', script, '--tapes', 'somewhere/else'], { cwd: resolve(PACKAGE, '..', '..'), encoding: 'utf8', env: { ...process.env, INIT_CWD: resolve(PACKAGE, '..', '..') } });
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('--tapes must be packages/scene-gate/tapes');
    const none = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: resolve(PACKAGE, '..', '..'), encoding: 'utf8' });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('--tapes is required');
  });

  it('runs the preflight before it looks for a key or builds a client', () => {
    const source = readFileSync(join(PACKAGE, 'scripts', 'run-study.ts'), 'utf8');
    const at = (needle: string) => source.indexOf(needle);
    expect(at('resolveTapesArg(')).toBeLessThan(at('preflight('));
    expect(at('preflight(')).toBeLessThan(at('findKey('));
    expect(at('findKey(')).toBeLessThan(at('new GeminiClient('));
  });
});

describe('the study, with a fake client', () => {
  it('runs 240 requests in the fixed order: both models generate, then both repair', async () => {
    const fake = fakeClient();
    const c = config(fake.client);
    const report = await runStudy(c);

    expect(report.status).toBe('complete');
    expect(fake.calls).toHaveLength(240);
    const phases = fake.calls.map((x) => `${x.phase}:${x.model}`);
    const block = (phase: string, model: string, from: number) => expect(phases.slice(from, from + 60).every((p) => p === `${phase}:${model}`), `${phase} ${model}`).toBe(true);
    block('generate', 'gemini-3.5-flash-lite', 0);
    block('generate', 'gemini-3.8-flash', 60);
    block('repair', 'gemini-3.5-flash-lite', 120);
    block('repair', 'gemini-3.8-flash', 180);
    expect(report.reports.map((r) => `${r.phase} ${r.model} ${r.status} ${r.written}/${r.planned}`)).toEqual([
      'generate gemini-3.5-flash-lite complete 60/60',
      'generate gemini-3.8-flash complete 60/60',
      'repair gemini-3.5-flash-lite complete 60/60',
      'repair gemini-3.8-flash complete 60/60',
    ]);
    expect(STUDY_MODELS).toEqual(['gemini-3.5-flash-lite', 'gemini-3.8-flash']);
  });

  it('goes through prompts in file order and samples 0, 1, 2 within each prompt', async () => {
    const fake = fakeClient();
    await runStudy(config(fake.client));
    const generated = fake.calls.filter((x) => x.phase === 'generate' && x.model === 'gemini-3.5-flash-lite');
    expect(generated.map((x) => `${x.prompt}/${x.sample}`)).toEqual(PROMPTS.flatMap((p) => [0, 1, 2].map((s) => `${p.id}/${s}`)));
  });

  it('writes 240 tapes at <model>/<prompt_id>/<sample>.{generate,repair}.json, each with the commit hash', async () => {
    await runStudy(config(fakeClient().client));
    const files = listTapeFiles(root);
    expect(files).toHaveLength(240);
    const expected = STUDY_MODELS.flatMap((m) => PROMPTS.flatMap((p) => [0, 1, 2].flatMap((s) => [`${m}/${p.id}/${s}.generate.json`, `${m}/${p.id}/${s}.repair.json`]))).sort();
    expect(files).toEqual(expected);
    for (const f of files) {
      const tape = readTape(join(root, ...f.split('/')));
      expect(tape.commit, f).toBe(COMMIT);
      expect(tape.attempts, f).toHaveLength(1);
      expect(tape.parameters, f).toEqual({ max_output_tokens: 16384 });
    }
  });

  it('leaves tapes that check-tapes reads without error, with one commit, no drift, and the spend of the ledger', async () => {
    const c = config(fakeClient().client);
    const report = await runStudy(c);
    const checked = checkTapes(root, { expect: { prompts: { prompts: [...PROMPTS] }, system: SYSTEM } });
    expect(checked.summary).toMatchObject({ errors: 0, drift: 0, commits: [COMMIT] });
    for (const model of STUDY_MODELS) {
      expect(checked.summary.models[model]).toMatchObject({ tapes: 60, verdicts: { pass: 0, fail: 60, schema_invalid: 0 }, transport_failures: 0, attempts: 120 });
    }
    expect(checked.summary.repair).toMatchObject({ attempted: 120, accepted: 120, fully_fixed: 120 });
    expect(checked.summary.spend_micro_usd).toBe(report.spent_micro_usd);
    expect(report.spent_micro_usd).toBe(c.deps.ledger.spent);
    // 120 requests per model at 1000 prompt + 500 candidate tokens: 1,550 micro-dollars for flash-lite, 2,625 for 3.8-flash.
    expect(report.spent_micro_usd).toBe(120 * 1_550 + 120 * 2_625);
  });

  it('repairs only the generations that failed, one request each', async () => {
    const fake = fakeClient((r) => reply(r.sample === 0 ? FAILING : JSON.stringify({ ...JSON.parse(FIXED) })));
    await runStudy(config(fake.client));
    const repairs = fake.calls.filter((x) => x.phase === 'repair');
    expect(repairs).toHaveLength(40);
    expect(new Set(repairs.map((x) => x.sample))).toEqual(new Set([0]));
  });
});

describe('restarting the study', () => {
  it('skips every tape that exists, sends nothing, and still counts what the tapes cost', async () => {
    await runStudy(config(fakeClient().client));
    const again = fakeClient(() => {
      throw new Error('must not be called');
    });
    const c = config(again.client);
    const report = await runStudy(c);
    expect(again.calls).toHaveLength(0);
    expect(report.status).toBe('complete');
    expect(report.reports.every((r) => r.written === 0 && r.skipped === r.planned)).toBe(true);
    expect(report.reports.reduce((n, r) => n + r.skipped, 0)).toBe(240);
    expect(report.spent_micro_usd).toBe(120 * 1_550 + 120 * 2_625);
    expect(listTapeFiles(root)).toHaveLength(240);
  });

  it('picks up where an interrupted run stopped, without repeating or overwriting a tape', async () => {
    const broken = fakeClient((_r, n) => (n === 50 ? { status: 400 } : reply(FAILING)));
    const first = await runStudy(config(broken.client));
    expect(first.status).toBe('incomplete');
    expect(first.reports).toHaveLength(1);
    expect(first.reports[0]).toMatchObject({ stopped: 'rejected', detail: 'HTTP 400', written: 49 });
    expect(listTapeFiles(root)).toHaveLength(49);
    const before = readFileSync(join(root, ...listTapeFiles(root)[0]!.split('/')), 'utf8');

    const resumed = fakeClient();
    const second = await runStudy(config(resumed.client));
    expect(second.status).toBe('complete');
    expect(resumed.calls.filter((x) => x.phase === 'generate')).toHaveLength(120 - 49);
    expect(resumed.calls).toHaveLength(240 - 49);
    expect(listTapeFiles(root)).toHaveLength(240);
    expect(readFileSync(join(root, ...listTapeFiles(root)[0]!.split('/')), 'utf8')).toBe(before);
  });
});

describe('the spend cap', () => {
  it('stops the whole study when the next attempt could reach the cap, before the second model or any repair', async () => {
    const fake = fakeClient();
    const c = config(fake.client, new SpendLedger(100_000));
    const report = await runStudy(c);
    expect(report.status).toBe('incomplete');
    expect(report.reports).toHaveLength(1);
    expect(report.reports[0]).toMatchObject({ phase: 'generate', model: 'gemini-3.5-flash-lite', stopped: 'spend_cap' });
    expect(fake.calls.every((x) => x.phase === 'generate' && x.model === 'gemini-3.5-flash-lite')).toBe(true);
    expect(fake.calls.length).toBeLessThan(60);
    // Each reply cost 1,550 and the next attempt needs room for 42,760: the study stops once 57,240 is spent.
    expect(report.spent_micro_usd).toBeLessThan(100_000);
    expect(report.spent_micro_usd + 42_760).toBeGreaterThanOrEqual(100_000);
    expect(report.spent_micro_usd).toBe(fake.calls.length * 1_550);
  });

  it('keeps generation ahead of repair: a cap that bites late cuts the repairs, never the generations', async () => {
    // The 120 generations cost 60 x 1,550 + 60 x 2,625 = 250,500; the last one needs room for 65,940 more, so 313,815 is the least the cap can be.
    // At 320,000 they all fit, and the repairs run out of room after 18 requests.
    const fake = fakeClient();
    const report = await runStudy(config(fake.client, new SpendLedger(320_000)));
    const generation = report.reports.filter((r) => r.phase === 'generate');
    expect(generation.every((r) => r.status === 'complete' && r.written === 60)).toBe(true);
    expect(report.status).toBe('incomplete');
    expect(report.reports.some((r) => r.phase === 'repair' && r.stopped === 'spend_cap')).toBe(true);
    expect(fake.calls.filter((x) => x.phase === 'generate')).toHaveLength(120);
  });
});

describe('a model that keeps failing', () => {
  it('stops at its 7th transport failure and gets no repair round, while the other model goes on', async () => {
    const fake = fakeClient((r) => (r.model === 'gemini-3.5-flash-lite' ? ({ status: 503 } as ProviderReply) : reply(FAILING)));
    const c = config(fake.client);
    const report = await runStudy(c);
    expect(report.status).toBe('incomplete');
    expect(report.reports.map((r) => `${r.phase} ${r.model} ${r.status}${r.stopped ? ` ${r.stopped}` : ''}`)).toEqual([
      'generate gemini-3.5-flash-lite incomplete transport_failure_limit',
      'generate gemini-3.8-flash complete',
      'repair gemini-3.8-flash complete',
    ]);
    expect(report.reports[0]).toMatchObject({ written: 7, transport_failures: 7 });
    expect(fake.calls.filter((x) => x.model === 'gemini-3.5-flash-lite')).toHaveLength(7 * 4);
    expect(readdirSync(root).sort()).toEqual(['gemini-3.5-flash-lite', 'gemini-3.8-flash']);
    const checked = checkTapes(root);
    expect(checked.summary.models['gemini-3.5-flash-lite']).toMatchObject({ tapes: 7, transport_failures: 7 });
    expect(checked.summary.models['gemini-3.8-flash']).toMatchObject({ tapes: 60, transport_failures: 0 });
    expect(c.sleeps.filter((s) => s === 8_000)).toHaveLength(7);
  });
});
