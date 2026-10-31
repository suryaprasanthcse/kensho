import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_PROMPT } from '../scripts/smoke-repair.ts';
import { insideRepo, runE2e } from '../scripts/e2e-runner.ts';
import { GeminiClient, generationLimits, geminiBody, toModelResponse, type GeminiFetch, type GeminiFetchInit } from '../src/gemini-client.ts';
import { readTape, tapePath, type GenerationRequest, type RepairRequest } from '../src/harness.ts';
import { sceneJsonSchema } from '../src/json-schema.ts';
import { runGenerations } from '../src/runner.ts';
import { SpendLedger } from '../src/spend.ts';
import { STUDY_PARAMETERS } from '../src/study.ts';
import { ProviderConfigError, requestWithRetries } from '../src/transport.ts';
import { cleanScene } from './fixtures.ts';

// Offline only: fetch is injected, so nothing here touches the network or the real .env.
const KEY = 'AIza-test-SECRET-0123456789';
const MODEL = 'gemini-3.5-flash-lite';
const SCHEMA = sceneJsonSchema('gemini');

const request: GenerationRequest = { model: MODEL, parameters: STUDY_PARAMETERS, system: 'system text', prompt: { id: 'p1', text: 'prompt text' }, sample: 0, jsonSchema: SCHEMA };
const repairRequest: RepairRequest = { ...request, message: 'repair message' };

const body = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 1500, totalTokenCount: 3000 },
  ...extra,
});

function fakeFetch(respond: (url: string, init: GeminiFetchInit, call: number) => { status: number; json?: () => Promise<unknown> } | Error) {
  const calls: { url: string; init: GeminiFetchInit }[] = [];
  const f: GeminiFetch = async (url, init) => {
    calls.push({ url, init });
    const r = respond(url, init, calls.length);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: r.json ?? (() => Promise.resolve(body('{}'))) };
  };
  return { fetch: f, calls };
}

describe('the Gemini request', () => {
  it('sends the system text, the prompt and the schema, with maxOutputTokens as the only limit', async () => {
    const f = fakeFetch(() => ({ status: 200 }));
    await new GeminiClient({ apiKey: KEY, fetch: f.fetch }).generate(request, 180_000);
    const [call] = f.calls;
    expect(call!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(call!.init.method).toBe('POST');
    expect(call!.init.headers).toEqual({ 'content-type': 'application/json', 'x-goog-api-key': KEY });
    expect(JSON.parse(call!.init.body)).toEqual({
      systemInstruction: { parts: [{ text: 'system text' }] },
      contents: [{ role: 'user', parts: [{ text: 'prompt text' }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: SCHEMA, maxOutputTokens: 16384 },
    });
  });

  it('leaves temperature, top-p, top-k, seed and thinking out, so the provider default applies', () => {
    const text = JSON.stringify(geminiBody(request, 'x'));
    for (const word of ['temperature', 'topP', 'topK', 'seed', 'thinking', 'Thinking']) expect(text, word).not.toContain(word);
    expect(Object.keys((geminiBody(request, 'x') as { generationConfig: object }).generationConfig).sort()).toEqual(['maxOutputTokens', 'responseJsonSchema', 'responseMimeType']);
  });

  it('puts the key in a header only, never in the URL or the body', async () => {
    const f = fakeFetch(() => ({ status: 200 }));
    await new GeminiClient({ apiKey: KEY, fetch: f.fetch }).generate(request, 1000);
    expect(f.calls[0]!.url).not.toContain(KEY);
    expect(f.calls[0]!.init.body).not.toContain(KEY);
  });

  it('sends the rendered message for a repair, with the same system text and schema', async () => {
    const f = fakeFetch(() => ({ status: 200 }));
    await new GeminiClient({ apiKey: KEY, fetch: f.fetch }).repair(repairRequest, 1000);
    const sent = JSON.parse(f.calls[0]!.init.body);
    expect(sent.contents[0].parts[0].text).toBe('repair message');
    expect(sent.systemInstruction.parts[0].text).toBe('system text');
    expect(sent.generationConfig.responseJsonSchema).toEqual(SCHEMA);
  });

  it('gives each attempt a signal that fires at the timeout', async () => {
    const f = fakeFetch((_u, init) => (init.signal.aborted ? new Error('already') : { status: 200 }));
    await new GeminiClient({ apiKey: KEY, fetch: f.fetch }).generate(request, 5);
    const signal = f.calls[0]!.init.signal;
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe('TimeoutError');
  });

  it('refuses a key that is empty and any parameter other than max_output_tokens', () => {
    expect(() => new GeminiClient({ apiKey: '' })).toThrow(ProviderConfigError);
    expect(generationLimits({ max_output_tokens: 16384 })).toEqual({ maxOutputTokens: 16384 });
    expect(generationLimits({})).toEqual({});
    for (const bad of [{ temperature: 0.2 }, { max_output_tokens: 0 }, { max_output_tokens: 1.5 }, { thinking_level: 'low' }]) {
      expect(() => generationLimits(bad as never), JSON.stringify(bad)).toThrow(ProviderConfigError);
    }
  });
});

describe('the Gemini reply', () => {
  it('keeps only the status of a failed attempt and never reads its body', async () => {
    let read = 0;
    const f = fakeFetch(() => ({ status: 503, json: () => (read++, Promise.resolve({ error: { message: KEY } })) }));
    const reply = await new GeminiClient({ apiKey: KEY, fetch: f.fetch }).generate(request, 1000);
    expect(reply).toEqual({ status: 503 });
    expect(read).toBe(0);
  });

  it('takes the text, the finish reason and the usage of the first candidate', () => {
    expect(toModelResponse(body('{"a":1}'))).toEqual({
      rawOutput: '{"a":1}',
      finishReason: 'STOP',
      usage: { promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 1500, totalTokenCount: 3000 },
    });
  });

  it('joins several text parts and leaves out thought parts', () => {
    const json = { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: '{"a":' }, { text: '1}' }] }, finishReason: 'STOP' }] };
    expect(toModelResponse(json).rawOutput).toBe('{"a":1}');
  });

  it('records a missing count as null and a missing usage as absent', () => {
    expect(toModelResponse({ candidates: [], usageMetadata: { promptTokenCount: 10 } }).usage).toEqual({ promptTokenCount: 10, candidatesTokenCount: null, thoughtsTokenCount: null, totalTokenCount: null });
    expect(toModelResponse(body('{}', { usageMetadata: undefined }))).not.toHaveProperty('usage');
    expect(toModelResponse({ candidates: [{ content: { parts: [{ text: '{}' }] } }], usageMetadata: { promptTokenCount: 1.5, candidatesTokenCount: -1 } }).usage).toMatchObject({ promptTokenCount: null, candidatesTokenCount: null });
  });

  it('turns a blocked prompt, which has no candidate, into an empty reply with a PROMPT_ finish reason', () => {
    expect(toModelResponse({ promptFeedback: { blockReason: 'SAFETY' } })).toMatchObject({ rawOutput: '', finishReason: 'PROMPT_SAFETY' });
    expect(toModelResponse(null)).toMatchObject({ rawOutput: '', finishReason: null });
  });

  it('treats a 200 whose body is not JSON as a reply that did not arrive, and lets other errors through', async () => {
    const broken = fakeFetch(() => ({ status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token')) }));
    expect(await new GeminiClient({ apiKey: KEY, fetch: broken.fetch }).generate(request, 1000)).toEqual({ status: 200 });
    const timedOut = fakeFetch(() => ({ status: 200, json: () => Promise.reject(Object.assign(new Error('x'), { name: 'TimeoutError' })) }));
    await expect(new GeminiClient({ apiKey: KEY, fetch: timedOut.fetch }).generate(request, 1000)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('the client under the transport policy', () => {
  let root: string;
  beforeEach(() => void (root = mkdtempSync(join(tmpdir(), 'scene-gate-client-'))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const deps = (f: GeminiFetch) => {
    const sleeps: number[] = [];
    let t = Date.parse('2026-11-01T00:00:00Z');
    return { sleeps, client: new GeminiClient({ apiKey: KEY, fetch: f }), tapeRoot: root, ledger: new SpendLedger(), sleep: async (ms: number) => void sleeps.push(ms), now: () => new Date((t += 1000)) };
  };

  it('retries a 500 and a timeout, then keeps the reply, with every attempt on the tape and the usage counted', async () => {
    const f = fakeFetch((_u, _i, n) => (n === 1 ? { status: 500 } : n === 2 ? Object.assign(new Error('slow'), { name: 'TimeoutError' }) : { status: 200, json: () => Promise.resolve(body(JSON.stringify(cleanScene()))) }));
    const d = deps(f.fetch);
    const report = await runGenerations({ model: MODEL, parameters: STUDY_PARAMETERS, system: 'system text', prompts: [{ id: 'p1', text: 'prompt text' }], samples: 1, jsonSchema: SCHEMA, deps: d });
    expect(report).toMatchObject({ status: 'complete', written: 1, transport_failures: 0 });
    const tape = readTape(tapePath(root, { model: MODEL, prompt_id: 'p1', sample: 0, kind: 'generate' }));
    expect(tape.attempts!.map((a) => [a.http_status, a.error])).toEqual([[500, null], [null, 'TimeoutError'], [200, null]]);
    expect(tape.usage).toEqual({ promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 1500, totalTokenCount: 3000 });
    expect(tape.finish_reason).toBe('STOP');
    expect(d.sleeps).toEqual([2_000, 4_000]);
    expect(JSON.stringify(tape)).not.toContain(KEY);
  });

  it('does not retry a configuration error, and sends nothing', async () => {
    const f = fakeFetch(() => ({ status: 200 }));
    const client = new GeminiClient({ apiKey: KEY, fetch: f.fetch });
    const d = deps(f.fetch);
    await expect(requestWithRetries(MODEL, (t) => client.generate({ ...request, parameters: { temperature: 1 } }, t), d)).rejects.toThrow(ProviderConfigError);
    expect(f.calls).toHaveLength(0);
    expect(d.ledger.spent).toBe(0);
  });
});

describe('the end-to-end script, offline', () => {
  let out: string;
  beforeEach(() => void (out = mkdtempSync(join(tmpdir(), 'scene-gate-e2e-'))));
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  it('refuses an output directory inside the repository', async () => {
    expect(insideRepo(resolve(import.meta.dirname, '..', 'tapes'))).toBe(true);
    expect(insideRepo(resolve(import.meta.dirname, '..', '..', '..'))).toBe(true);
    expect(insideRepo(out)).toBe(false);
    const f = fakeFetch(() => ({ status: 200 }));
    const r = await runE2e({ out: resolve(import.meta.dirname, '..', 'tapes-e2e'), model: MODEL, apiKey: KEY, fetch: f.fetch });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toContain('outside the repository');
    expect(f.calls).toHaveLength(0);
  });

  it('runs the real runner against a fetch that returns a clean scene, writes one tape, and reports that it checks', async () => {
    const f = fakeFetch(() => ({ status: 200, json: () => Promise.resolve(body(JSON.stringify(cleanScene()))) }));
    const r = await runE2e({ out, model: MODEL, apiKey: KEY, fetch: f.fetch, sleep: async () => {}, now: () => new Date('2026-11-01T00:00:00Z') });
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(f.calls[0]!.init.body).contents[0].parts[0].text).toBe(FIXTURE_PROMPT);
    expect(r.ok).toBe(true);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatch(/^e2e gemini-3\.5-flash-lite: run complete, 1 tape written, 0 transport failures, 1 attempts, \$0\.00\d+ counted against the cap$/);
    expect(r.lines[1]).toContain('tape: pass; check-tapes: reads and checks it, no errors; usage adds up (prompt 1000, candidates 500, thoughts 1500, total 3000)');
    expect(readdirSync(out)).toEqual(['gemini-3.5-flash-lite']);
    expect(r.lines.join('\n')).not.toContain(KEY);
  });

  it('reports a transport failure without calling it a pass, and a usage that does not add up as not ok', async () => {
    const down = fakeFetch(() => ({ status: 503 }));
    const failed = await runE2e({ out, model: MODEL, apiKey: KEY, fetch: down.fetch, sleep: async () => {}, now: () => new Date('2026-11-01T00:00:00Z') });
    expect(failed.ok).toBe(false);
    expect(failed.lines[0]).toContain('1 transport failures, 4 attempts');
    expect(failed.lines[1]).toContain('tape: transport_failure');

    const out2 = mkdtempSync(join(tmpdir(), 'scene-gate-e2e-'));
    try {
      const odd = fakeFetch(() => ({ status: 200, json: () => Promise.resolve(body(JSON.stringify(cleanScene()), { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 5, totalTokenCount: 99 } })) }));
      const r = await runE2e({ out: out2, model: MODEL, apiKey: KEY, fetch: odd.fetch, sleep: async () => {}, now: () => new Date('2026-11-01T00:00:00Z') });
      expect(r.ok).toBe(false);
      expect(r.lines[1]).toContain('does not add up');
    } finally {
      rmSync(out2, { recursive: true, force: true });
    }
  });
});

describe('the end-to-end script with tapes of two models in one directory', () => {
  let out: string;
  beforeEach(() => void (out = mkdtempSync(join(tmpdir(), 'scene-gate-e2e-'))));
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  it('reports the tape of the model it ran, not the first tape in the directory', async () => {
    const bad = cleanScene();
    bad.entities[0]!.pos_mm = [0, 1500, -30000];
    const fail = fakeFetch(() => ({ status: 200, json: () => Promise.resolve(body(JSON.stringify(bad))) }));
    const pass = fakeFetch(() => ({ status: 200, json: () => Promise.resolve(body(JSON.stringify(cleanScene()))) }));
    const opts = { out, apiKey: KEY, sleep: async () => {}, now: () => new Date('2026-11-01T00:00:00Z') };

    // gemini-3.5-flash-lite sorts first and fails; gemini-3.8-flash is run second, into the same directory, and passes.
    const first = await runE2e({ ...opts, model: 'gemini-3.5-flash-lite', fetch: fail.fetch });
    expect(first.lines[1]).toContain('tape: fail (OUT_OF_BOUNDS)');
    const second = await runE2e({ ...opts, model: 'gemini-3.8-flash', fetch: pass.fetch });
    expect(second.lines[1]).toContain('tape: pass;');
    expect(second.lines[1]).not.toContain('OUT_OF_BOUNDS');
    expect(second.ok).toBe(true);
  });
});
