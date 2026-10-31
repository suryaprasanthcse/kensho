import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sceneJsonSchema } from '../src/json-schema.ts';
import { PROMPT, claudeRequest, claudeText, findKey, geminiRequest, geminiText, loadEnv, runSmoke, type Fetch } from '../scripts/smoke-schema.ts';

// These tests never touch the network or the real .env: fetch is injected and the .env is a temporary file.
const SECRET_A = 'sk-test-SECRET-A-0123456789';
const SECRET_B = 'AIza-test-SECRET-B-0123456789';
const env = { ANTHROPIC_API_KEY: SECRET_A, GEMINI_API_KEY: SECRET_B };

const reply = (status: number, body: unknown): Awaited<ReturnType<Fetch>> => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => (status >= 200 && status < 300 ? Promise.resolve(body) : Promise.reject(new Error(`error body must not be read: ${SECRET_A}`))),
});

const good = (url: string): Awaited<ReturnType<Fetch>> =>
  url.includes('anthropic')
    ? reply(200, { content: [{ type: 'text', text: '{"scene":"scene-gate/1"}' }] })
    : reply(200, { candidates: [{ content: { parts: [{ text: '{"scene":' }, { text: '"scene-gate/1"}' }] } }] });

describe('the schema smoke test, offline', () => {
  it('builds a Claude request with the claude profile in output_config.format and a neutral prompt', () => {
    const r = claudeRequest('m');
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.body).toEqual({
      model: 'm',
      max_tokens: 4096,
      messages: [{ role: 'user', content: PROMPT }],
      output_config: { format: { type: 'json_schema', schema: sceneJsonSchema('claude') } },
    });
    expect(Object.keys(r.headers('k')).sort()).toEqual(['anthropic-version', 'content-type', 'x-api-key']);
    expect(PROMPT).toBe('an empty room with one crate');
  });

  it('builds a Gemini request with the gemini profile as responseJsonSchema', () => {
    const r = geminiRequest('some model');
    expect(r.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/some%20model:generateContent');
    expect(r.body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: sceneJsonSchema('gemini') },
    });
    expect(Object.keys(r.headers('k')).sort()).toEqual(['content-type', 'x-goog-api-key']);
  });

  it('never puts a key in a URL or a request body', () => {
    for (const r of [claudeRequest('m'), geminiRequest('m')]) expect(JSON.stringify([r.url, r.body])).not.toMatch(/SECRET/);
  });

  it('reads the reply text from the first text block or the candidate parts', () => {
    expect(claudeText({ content: [{ type: 'thinking' }, { type: 'text', text: 'x' }] })).toBe('x');
    expect(claudeText({ content: [] })).toBeNull();
    expect(claudeText(null)).toBeNull();
    expect(geminiText({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] })).toBe('ab');
    expect(geminiText({ candidates: [] })).toBeNull();
  });

  it('sends exactly one request per provider and prints only the status and whether the reply parses', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const { lines, ok } = await runSmoke(env, async (url, init) => {
      calls.push({ url, headers: init.headers });
      return good(url);
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers['x-api-key']).toBe(SECRET_A);
    expect(calls[1]!.headers['x-goog-api-key']).toBe(SECRET_B);
    expect(lines).toEqual(['claude: HTTP 200, reply parses: yes', 'gemini: HTTP 200, reply parses: yes']);
    expect(ok).toBe(true);
  });

  it('reports a reply that is not JSON as not parsing', async () => {
    const { lines, ok } = await runSmoke(env, async () => reply(200, { content: [{ type: 'text', text: 'I cannot help.' }] }), ['claude']);
    expect(lines).toEqual(['claude: HTTP 200, reply parses: no']);
    expect(ok).toBe(false);
  });

  it('prints the status of an error and never reads or prints the error body', async () => {
    let bodiesRead = 0;
    const { lines, ok } = await runSmoke(env, async () => ({ ok: false, status: 400, json: () => (bodiesRead++, Promise.resolve({ error: SECRET_A })) }));
    expect(bodiesRead).toBe(0);
    expect(lines).toEqual(['claude: HTTP 400, reply parses: no reply read', 'gemini: HTTP 400, reply parses: no reply read']);
    expect(ok).toBe(false);
  });

  it('prints only the error class when the request itself fails, and never a key', async () => {
    const { lines } = await runSmoke(env, async () => {
      throw new TypeError(`fetch failed with ${SECRET_A} ${SECRET_B}`);
    });
    expect(lines).toEqual(['claude: request failed (TypeError)', 'gemini: request failed (TypeError)']);
    expect(lines.join('\n')).not.toMatch(/SECRET/);
  });

  it('skips a provider whose key is missing without sending anything', async () => {
    let sent = 0;
    const { lines, ok } = await runSmoke({ GEMINI_API_KEY: SECRET_B }, async (url) => (sent++, good(url)));
    expect(sent).toBe(1);
    expect(lines).toEqual(['claude: skipped, ANTHROPIC_API_KEY is not set', 'gemini: HTTP 200, reply parses: yes']);
    expect(ok).toBe(false);
  });

  it('accepts a Gemini key under an alias, preferring GEMINI_API_KEY, and names every alias when none is set', async () => {
    const headers: string[] = [];
    const take = async (url: string, init: { headers: Record<string, string> }) => (headers.push(init.headers['x-goog-api-key'] ?? ''), good(url));
    await runSmoke({ GOOGLE_API_KEY: SECRET_B }, take, ['gemini']);
    await runSmoke({ GOOGLE_API_KEY: 'other', GEMINI_API_KEY: SECRET_B }, take, ['gemini']);
    expect(headers).toEqual([SECRET_B, SECRET_B]);
    const { lines } = await runSmoke({}, take, ['gemini']);
    expect(lines).toEqual(['gemini: skipped, none of GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, GEMINI_KEY is set']);
  });

  it('matches key names case-insensitively, so a lower-case name in .env still works', async () => {
    const keys: string[] = [];
    const take = async (url: string, init: { headers: Record<string, string> }) => (keys.push(init.headers['x-goog-api-key'] ?? ''), good(url));
    await runSmoke({ gemini_api_key: SECRET_B }, take, ['gemini']);
    expect(keys).toEqual([SECRET_B]);
    expect(findKey({ Anthropic_Api_Key: SECRET_A }, ['ANTHROPIC_API_KEY'])).toBe(SECRET_A);
    expect(findKey({ gemini_api_key: 'loose', GEMINI_API_KEY: 'exact' }, ['GEMINI_API_KEY'])).toBe('exact');
    expect(findKey({ gemini_api_key: '' }, ['GEMINI_API_KEY'])).toBeUndefined();
  });

  it('parses a lower-case name with spaces around the equals sign, as written in a hand-edited .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scene-gate-env-'));
    try {
      const file = join(dir, '.env');
      writeFileSync(file, `HYPER3D_API_KEY=abc\r\ngemini_api_key = ${SECRET_B}\r\n`);
      expect(findKey(loadEnv(file, {}), ['GEMINI_API_KEY'])).toBe(SECRET_B);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours a requested provider only, and a model override', async () => {
    const urls: string[] = [];
    await runSmoke({ ...env, SMOKE_GEMINI_MODEL: 'gem-x' }, async (url) => (urls.push(url), good(url)), ['gemini']);
    expect(urls).toEqual(['https://generativelanguage.googleapis.com/v1beta/models/gem-x:generateContent']);
  });

  describe('reading keys from a .env file', () => {
    let dir: string;
    beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'scene-gate-env-'))));
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('parses the file, lets it win over the environment, and ignores empty values', () => {
      const file = join(dir, '.env');
      writeFileSync(file, `ANTHROPIC_API_KEY=${SECRET_A}\nGEMINI_API_KEY=\n# comment\n`);
      const loaded = loadEnv(file, { GEMINI_API_KEY: SECRET_B, ANTHROPIC_API_KEY: 'from-process' });
      expect(loaded.ANTHROPIC_API_KEY).toBe(SECRET_A);
      expect(loaded.GEMINI_API_KEY).toBe(SECRET_B);
    });

    it('falls back to the environment when there is no file', () => {
      expect(loadEnv(join(dir, 'missing.env'), { GEMINI_API_KEY: SECRET_B }).GEMINI_API_KEY).toBe(SECRET_B);
    });
  });
});
