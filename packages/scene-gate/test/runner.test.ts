import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkTapes, readTape, tapePath, writeTape, type GenerationRequest, type ProviderClient, type RepairRequest, type Tape } from '../src/harness.ts';
import { runGenerations, runRepairs, type RunnerDeps } from '../src/runner.ts';
import { SpendLedger } from '../src/spend.ts';
import type { ProviderReply } from '../src/transport.ts';
import { sha256Hex } from '../src/verdict.ts';
import { EXAMPLE_SCENE, cleanScene } from './fixtures.ts';

const MODEL = 'gemini-3.5-flash-lite';
const USAGE = { promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 1500 };
const COST_OF_USAGE = 5_300;
const WORST = 42_760;
const PARAMETERS = { max_output_tokens: 16384 };
const SYSTEM = 'system text';

const prompts = Array.from({ length: 10 }, (_, i) => ({ id: `p${String(i + 1).padStart(2, '0')}`, text: `prompt number ${i + 1}` }));
const reply = (rawOutput: string): ProviderReply => ({ status: 200, response: { rawOutput, finishReason: 'STOP', usage: USAGE } });
const CLEAN = JSON.stringify(cleanScene());

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), 'scene-gate-runner-'))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A client driven by a function of the request, so a test can fail particular requests. */
function client(onGenerate: (r: GenerationRequest, call: number) => ProviderReply | Error, onRepair: (r: RepairRequest, call: number) => ProviderReply | Error = () => reply('{}')) {
  const generated: GenerationRequest[] = [];
  const repaired: RepairRequest[] = [];
  const timeouts: number[] = [];
  const attempt = <R>(log: R[], request: R, t: number, produce: (r: R, n: number) => ProviderReply | Error) => {
    log.push(request);
    timeouts.push(t);
    const result = produce(request, log.length);
    if (result instanceof Error) throw result;
    return Promise.resolve(result);
  };
  const c: ProviderClient = {
    generate: (r, t) => attempt(generated, r, t, onGenerate),
    repair: (r, t) => attempt(repaired, r, t, onRepair),
  };
  return { client: c, generated, repaired, timeouts };
}

function deps(c: ProviderClient, ledger = new SpendLedger()): RunnerDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  let t = Date.parse('2026-11-01T00:00:00Z');
  return { client: c, tapeRoot: root, ledger, sleeps, sleep: async (ms) => void sleeps.push(ms), now: () => new Date((t += 1000)) };
}

const config = (d: RunnerDeps, subset = prompts) => ({ model: MODEL, parameters: PARAMETERS, system: SYSTEM, prompts: subset, samples: 3, jsonSchema: { type: 'object' }, deps: d });
const read = (prompt: string, sample: number, kind: 'generate' | 'repair' = 'generate'): Tape => readTape(tapePath(root, { model: MODEL, prompt_id: prompt, sample, kind }));
const two = prompts.slice(0, 2);

describe('the generation loop', () => {
  it('sends one request per prompt and sample, in order, and writes a tape for each with its attempt log', async () => {
    const c = client(() => reply(CLEAN));
    const d = deps(c.client);
    const report = await runGenerations(config(d, two));
    expect(report).toMatchObject({ model: MODEL, phase: 'generate', status: 'complete', stopped: null, planned: 6, written: 6, skipped: 0, transport_failures: 0 });
    expect(c.generated.map((r) => `${r.prompt.id}/${r.sample}`)).toEqual(['p01/0', 'p01/1', 'p01/2', 'p02/0', 'p02/1', 'p02/2']);
    const tape = read('p02', 1);
    expect(tape).toMatchObject({ kind: 'generate', model: MODEL, parameters: PARAMETERS, prompt_hash: sha256Hex('prompt number 2'), system_hash: sha256Hex(SYSTEM), raw_output: CLEAN, usage: USAGE });
    expect(tape.outcome).toBeUndefined();
    expect(tape.attempts).toHaveLength(1);
    expect(tape.attempts![0]).toMatchObject({ attempt: 1, http_status: 200, error: null, cost_micro_usd: COST_OF_USAGE });
    expect(report.spent_micro_usd).toBe(6 * COST_OF_USAGE);
  });

  it('passes the request exactly as built: the system text, the schema, the sample, and the 180 s timeout', async () => {
    const c = client(() => reply(CLEAN));
    await runGenerations(config(deps(c.client), two.slice(0, 1)));
    expect(c.generated[0]).toMatchObject({ model: MODEL, parameters: PARAMETERS, system: SYSTEM, prompt: { id: 'p01', text: 'prompt number 1' }, jsonSchema: { type: 'object' } });
    expect(new Set(c.timeouts)).toEqual(new Set([180_000]));
  });

  it('never repeats a request that already has a tape, and charges the ledger for what the tapes cost', async () => {
    const first = client(() => reply(CLEAN));
    await runGenerations(config(deps(first.client), two));
    const second = client(() => {
      throw new Error('must not be called');
    });
    const d = deps(second.client);
    const report = await runGenerations(config(d, two));
    expect(second.generated).toHaveLength(0);
    expect(report).toMatchObject({ status: 'complete', written: 0, skipped: 6 });
    expect(d.ledger.spent).toBe(6 * COST_OF_USAGE);
  });

  it('records a request that never got a reply as a transport_failure tape and goes on', async () => {
    const c = client((r) => (r.prompt.id === 'p01' && r.sample === 1 ? new TypeError('fetch failed') : reply(CLEAN)));
    const d = deps(c.client);
    const report = await runGenerations(config(d));
    expect(report).toMatchObject({ status: 'complete', planned: 30, written: 30, transport_failures: 1 });
    const failed = read('p01', 1);
    expect(failed).toMatchObject({ outcome: 'transport_failure', raw_output: '' });
    expect(failed.attempts!.map((a) => [a.http_status, a.error, a.cost_micro_usd])).toEqual(Array(4).fill([null, 'TypeError', WORST]));
    expect(failed.usage).toBeUndefined();
    expect(d.sleeps).toEqual([2_000, 4_000, 8_000]);
    expect(c.generated.filter((r) => r.prompt.id === 'p01' && r.sample === 1)).toHaveLength(4);
    expect(report.spent_micro_usd).toBe(29 * COST_OF_USAGE + 4 * WORST);
  });

  it('never regenerates a transport failure on a later run', async () => {
    const c = client((r) => (r.prompt.id === 'p01' && r.sample === 0 ? { status: 503 } : reply(CLEAN)));
    await runGenerations(config(deps(c.client)));
    const again = client(() => reply(CLEAN));
    const report = await runGenerations(config(deps(again.client)));
    expect(again.generated).toHaveLength(0);
    expect(report).toMatchObject({ status: 'complete', written: 0, skipped: 30, transport_failures: 1 });
    expect(read('p01', 0).outcome).toBe('transport_failure');
  });

  it('allows up to 10% transport failures: 3 of 30 completes', async () => {
    const c = client((r) => (r.prompt.id === 'p01' ? { status: 503 } : reply(CLEAN)));
    const report = await runGenerations(config(deps(c.client)));
    expect(report).toMatchObject({ status: 'complete', stopped: null, planned: 30, written: 30, transport_failures: 3 });
  });

  it('stops the model when transport failures pass 10%: the 4th of 30 ends the run, incomplete', async () => {
    const c = client((r) => (r.prompt.id === 'p01' || r.prompt.id === 'p02' ? { status: 503 } : reply(CLEAN)));
    const report = await runGenerations(config(deps(c.client)));
    expect(report).toMatchObject({ status: 'incomplete', stopped: 'transport_failure_limit', planned: 30, written: 4, transport_failures: 4 });
    expect(report.detail).toBe('4 of 30 generations ended as transport_failure');
    expect(c.generated).toHaveLength(16);
    expect(c.generated.some((r) => r.prompt.id === 'p03')).toBe(false);
  });

  it('stays stopped when run again, because the failures on the tapes still count', async () => {
    const c = client(() => ({ status: 503 }));
    await runGenerations(config(deps(c.client)));
    const again = client(() => reply(CLEAN));
    const report = await runGenerations(config(deps(again.client)));
    expect(again.generated).toHaveLength(0);
    expect(report).toMatchObject({ status: 'incomplete', stopped: 'transport_failure_limit', skipped: 4, written: 0 });
  });

  it('counts the transport failures of a repair run for nothing: only generations can stop a model', async () => {
    const c = client(() => reply(JSON.stringify(EXAMPLE_SCENE)), () => ({ status: 503 }));
    await runGenerations(config(deps(c.client), two));
    const repairs = await runRepairs({ model: MODEL, parameters: PARAMETERS, system: SYSTEM, template: 'T {{prompt}} {{scene}} {{diagnostics}}', prompts, jsonSchema: {}, deps: deps(c.client) });
    expect(repairs).toMatchObject({ phase: 'repair', status: 'complete', planned: 6, written: 6, transport_failures: 6 });
  });

  it('stops at once on a status that is not retried and not a reply, such as a 400, and writes no tape', async () => {
    const c = client(() => ({ status: 400 }));
    const d = deps(c.client);
    const report = await runGenerations(config(d, two));
    expect(report).toMatchObject({ status: 'incomplete', stopped: 'rejected', detail: 'HTTP 400', written: 0 });
    expect(c.generated).toHaveLength(1);
    expect(d.sleeps).toEqual([]);
  });

  it('stops without sending when the next request could reach the $10 cap', async () => {
    const c = client(() => reply(CLEAN));
    const d = deps(c.client, new SpendLedger(60_000));
    const report = await runGenerations(config(d, prompts.slice(0, 3)));
    // Requests cost 5,300 each and each needs room for 42,760 more: the 5th would reach 63,960, over 60,000.
    expect(report).toMatchObject({ status: 'incomplete', stopped: 'spend_cap', written: 4 });
    expect(c.generated).toHaveLength(4);
    expect(report.spent_micro_usd).toBe(4 * COST_OF_USAGE);
  });

  it('counts failed attempts toward the cap, and keeps them on a tape when the cap stops a request half way', async () => {
    const c = client(() => ({ status: 503 }));
    const d = deps(c.client, new SpendLedger(100_000));
    const report = await runGenerations(config(d, two));
    expect(report).toMatchObject({ status: 'incomplete', stopped: 'spend_cap', written: 1 });
    const tape = read('p01', 0);
    expect(tape.outcome).toBe('transport_failure');
    expect(tape.attempts).toHaveLength(2);
    expect(report.spent_micro_usd).toBe(2 * WORST);
  });

  it('reports a model with no price as an error rather than guessing one', async () => {
    const c = client(() => reply(CLEAN));
    await expect(runGenerations({ ...config(deps(c.client)), model: 'some-unpriced-model' })).rejects.toThrow(/no price recorded/);
    expect(c.generated).toHaveLength(0);
  });
});

describe('the repair loop', () => {
  const TEMPLATE = '<!-- DRAFT -->\nREPAIR {{prompt}}\n{{scene}}\n{{diagnostics}}\n';
  const FIXED = JSON.stringify({ ...EXAMPLE_SCENE, entities: [...EXAMPLE_SCENE.entities, { id: 'chest_1', kind: 'static', box_mm: [600, 600, 600], pos_mm: [8000, 300, 3000] }, ...Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, kind: 'pickup', tags: ['coin'], box_mm: [300, 300, 60], pos_mm: [-2000 - 400 * i, 600, 3000] }))] });

  const seedGenerations = async () => {
    const c = client((r) => reply(r.prompt.id === 'p01' ? JSON.stringify(EXAMPLE_SCENE) : r.prompt.id === 'p02' ? CLEAN : r.prompt.id === 'p03' ? '{"scene": ' : JSON.stringify(EXAMPLE_SCENE)));
    await runGenerations(config(deps(c.client), prompts.slice(0, 4)));
    // p04 is a transport failure, not a failing scene.
    rmSync(tapePath(root, { model: MODEL, prompt_id: 'p04', sample: 0, kind: 'generate' }));
    writeTape(root, {
      version: 'scene-gate-tape/1', kind: 'generate', outcome: 'transport_failure', model: MODEL, parameters: PARAMETERS, prompt_id: 'p04',
      prompt_hash: sha256Hex('prompt number 4'), system_hash: sha256Hex(SYSTEM), sample: 0, raw_output: '', timestamp: '2026-11-01T00:00:00.000Z',
      attempts: [{ attempt: 1, started: '2026-11-01T00:00:00.000Z', duration_ms: 1, http_status: 503, error: null, usage: null, cost_micro_usd: WORST }],
    });
  };
  const repairConfig = (d: RunnerDeps) => ({ model: MODEL, parameters: PARAMETERS, system: SYSTEM, template: TEMPLATE, prompts, jsonSchema: { type: 'object' }, deps: d });

  it('sends one request for each failing scene and for nothing else: not a pass, a schema_invalid or a transport failure', async () => {
    await seedGenerations();
    const c = client(() => reply('{}'), () => reply(FIXED));
    const report = await runRepairs(repairConfig(deps(c.client)));
    // p01 samples 0..2 and p04 samples 1..2 fail; p02 passes, p03 is schema_invalid, p04/0 is a transport failure.
    expect(c.repaired.map((r) => `${r.prompt.id}/${r.sample}`)).toEqual(['p01/0', 'p01/1', 'p01/2', 'p04/1', 'p04/2']);
    expect(report).toMatchObject({ phase: 'repair', status: 'complete', planned: 5, written: 5, transport_failures: 0 });
  });

  it('builds the message from the template, the prompt text, the scene and the diagnostics, with system.md as the system text', async () => {
    await seedGenerations();
    const c = client(() => reply('{}'), () => reply(FIXED));
    await runRepairs(repairConfig(deps(c.client)));
    const first = c.repaired[0]!;
    expect(first.system).toBe(SYSTEM);
    expect(first.message.startsWith('REPAIR prompt number 1\n')).toBe(true);
    expect(first.message).toContain('"id": "door_red"');
    expect(first.message).toContain('"code": "UNRESOLVED_REF"');
    expect(first.message).not.toContain('DRAFT');
    expect(first.jsonSchema).toEqual({ type: 'object' });
  });

  it('writes repair tapes that check-tapes judges, and records transport failures as refusals', async () => {
    await seedGenerations();
    const c = client(() => reply('{}'), (r) => (r.prompt.id === 'p04' ? { status: 503 } : reply(FIXED)));
    const d = deps(c.client);
    const report = await runRepairs(repairConfig(d));
    expect(report).toMatchObject({ written: 5, transport_failures: 2 });
    expect(read('p04', 1, 'repair')).toMatchObject({ kind: 'repair', outcome: 'transport_failure' });
    const checked = checkTapes(root);
    expect(checked.summary.repair).toMatchObject({ attempted: 5, accepted: 3, fully_fixed: 3, refusals: { transport_failure: 2 } });
  });

  it('does not repeat a repair that has a tape', async () => {
    await seedGenerations();
    const first = client(() => reply('{}'), () => reply(FIXED));
    await runRepairs(repairConfig(deps(first.client)));
    const second = client(() => reply('{}'), () => {
      throw new Error('must not be called');
    });
    const report = await runRepairs(repairConfig(deps(second.client)));
    expect(second.repaired).toHaveLength(0);
    expect(report).toMatchObject({ status: 'complete', written: 0, skipped: 5 });
  });

  it('stops on the spend cap and on a rejected request, as the generation loop does', async () => {
    await seedGenerations();
    const capped = await runRepairs(repairConfig(deps(client(() => reply('{}'), () => reply(FIXED)).client, new SpendLedger(10_000))));
    expect(capped).toMatchObject({ status: 'incomplete', stopped: 'spend_cap', written: 0 });
    const rejected = await runRepairs(repairConfig(deps(client(() => reply('{}'), () => ({ status: 400 })).client)));
    expect(rejected).toMatchObject({ status: 'incomplete', stopped: 'rejected', detail: 'HTTP 400' });
  });

  it('refuses to guess a prompt it was not given', async () => {
    await seedGenerations();
    const c = client(() => reply('{}'), () => reply(FIXED));
    await expect(runRepairs({ ...repairConfig(deps(c.client)), prompts: [] })).rejects.toThrow(/no prompt p01/);
  });
});
