import { describe, expect, it } from 'vitest';
import { evaluateValue } from '../src/check.ts';
import { loadPrompts } from '../src/harness.ts';
import { join } from 'node:path';
import {
  FIXTURE_PROMPT,
  FIXTURE_SCENE,
  fixtureDiagnostics,
  geminiRepairRequest,
  readRepairTemplate,
  readSystem,
  runRepairSmoke,
} from '../scripts/smoke-repair.ts';
import type { Fetch } from '../scripts/smoke-schema.ts';
import { sceneJsonSchema } from '../src/json-schema.ts';

// Offline only: fetch is injected, so nothing here touches the network or the real .env.
const SECRET = 'AIza-test-SECRET-0123456789';
const env = { gemini_api_key: SECRET };
const input = { system: readSystem(), template: readRepairTemplate() };

const replyWith = (scene: unknown): Awaited<ReturnType<Fetch>> => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: JSON.stringify(scene) }] } }] }),
});

describe('the repair smoke fixture', () => {
  it('is a valid scene with exactly one known error, and is not one of the 20 prompts', () => {
    const e = evaluateValue(FIXTURE_SCENE);
    expect(e.kind).toBe('checked');
    expect(fixtureDiagnostics().map((d) => `${d.code} ${d.pointer}`)).toEqual(['UNSUPPORTED_DYNAMIC /entities/0/pos_mm']);
    const texts = loadPrompts(join(import.meta.dirname, '..', 'prompts', 'prompts.json')).prompts.map((p) => p.text.toLowerCase());
    expect(texts).not.toContain(FIXTURE_PROMPT);
  });
});

describe('the repair smoke request, offline', () => {
  it('sends system.md as the system message, the rendered repair message, and the Gemini profile for the reply', () => {
    const message = 'user message';
    const r = geminiRepairRequest('some-model', 'system text', message);
    expect(r.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/some-model:generateContent');
    expect(r.body).toEqual({
      systemInstruction: { parts: [{ text: 'system text' }] },
      contents: [{ role: 'user', parts: [{ text: message }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: sceneJsonSchema('gemini'), maxOutputTokens: 16384 },
    });
    expect(Object.keys(r.headers('k')).sort()).toEqual(['content-type', 'x-goog-api-key']);
  });

  it('sends one request per model, with the repair message and the real system prompt, and never a key in a body', async () => {
    const bodies: string[] = [];
    const urls: string[] = [];
    const { lines, ok } = await runRepairSmoke(
      env,
      async (url, init) => {
        urls.push(url);
        bodies.push(init.body);
        return replyWith({ ...FIXTURE_SCENE, entities: [{ ...FIXTURE_SCENE.entities[0], pos_mm: [1500, 400, 0] }, FIXTURE_SCENE.entities[1]] });
      },
      ['model-a', 'model-b'],
      input,
    );
    expect(urls).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models/model-a:generateContent',
      'https://generativelanguage.googleapis.com/v1beta/models/model-b:generateContent',
    ]);
    const body = JSON.parse(bodies[0]!);
    expect(body.systemInstruction.parts[0].text).toBe(input.system);
    const user = body.contents[0].parts[0].text as string;
    expect(user).toContain(FIXTURE_PROMPT);
    expect(user).toContain('"code": "UNSUPPORTED_DYNAMIC"');
    expect(user).toContain('/entities/0/pos_mm');
    expect(bodies.join()).not.toContain(SECRET);
    expect(lines).toEqual(['model-a repair: HTTP 200, reply parses: yes, accepted, scene passes, 1 ops', 'model-b repair: HTTP 200, reply parses: yes, accepted, scene passes, 1 ops']);
    expect(ok).toBe(true);
  });

  it('reports a refused repair with its reason and operation count', async () => {
    const { lines, ok } = await runRepairSmoke(env, async () => replyWith({ ...FIXTURE_SCENE, objectives: [] }), ['m'], input);
    expect(lines).toEqual(['m repair: HTTP 200, reply parses: yes, refused (objective_removed), 1 ops']);
    expect(ok).toBe(false);
  });

  it('reports a reply that is not JSON as not parsing', async () => {
    const { lines } = await runRepairSmoke(env, async () => ({ ok: true, status: 200, json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: 'sorry' }] } }] }) }), ['m'], input);
    expect(lines).toEqual(['m repair: HTTP 200, reply parses: no']);
  });

  it('prints only the status of an error and reads the body only with --diagnose, never printing the key', async () => {
    let read = 0;
    const failing: Fetch = async () => ({
      ok: false,
      status: 400,
      json: () => Promise.reject(new Error('unused')),
      text: () => (read++, Promise.resolve(JSON.stringify({ error: { message: `bad request for ${SECRET}` } }))),
    });
    expect((await runRepairSmoke(env, failing, ['m'], input)).lines).toEqual(['m repair: HTTP 400, reply parses: no reply read']);
    expect(read).toBe(0);
    const diagnosed = await runRepairSmoke(env, failing, ['m'], input, { diagnose: true });
    expect(diagnosed.lines).toEqual(['m repair: HTTP 400, reply parses: no reply read', '  detail: bad request for <key>']);
    expect(diagnosed.lines.join()).not.toContain(SECRET);
  });

  it('prints only the error class when the request fails, and skips when there is no key', async () => {
    const throwing: Fetch = async () => {
      throw new TypeError(`fetch failed ${SECRET}`);
    };
    expect((await runRepairSmoke(env, throwing, ['m'], input)).lines).toEqual(['m repair: request failed (TypeError)']);
    const none = await runRepairSmoke({}, throwing, ['m'], input);
    expect(none.lines[0]).toContain('skipped');
    expect(none.ok).toBe(false);
  });
});
