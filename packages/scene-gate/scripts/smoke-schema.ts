/**
 * Smoke test for the structured-output schema profiles. NOT part of the study: it sends ONE request per provider,
 * with that provider's schema profile and a neutral prompt, and prints only the HTTP status and whether the reply
 * parses as JSON. It writes no tapes and prints no keys, response bodies or error bodies.
 *
 *   pnpm --filter @kensho/scene-gate smoke-schema            # both providers
 *   pnpm --filter @kensho/scene-gate smoke-schema claude     # one provider
 *
 * Keys are read from the repository's .env (or the environment): ANTHROPIC_API_KEY and GEMINI_API_KEY. Models can be
 * overridden with SMOKE_CLAUDE_MODEL and SMOKE_GEMINI_MODEL.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { sceneJsonSchema } from '../src/json-schema.ts';
import { parseRawOutput } from '../src/parse.ts';

export const PROMPT = 'an empty room with one crate';

export type Provider = 'claude' | 'gemini';
export const PROVIDERS: readonly Provider[] = ['claude', 'gemini'];

export const KEY_VARIABLE: Readonly<Record<Provider, string>> = { claude: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };

const DEFAULT_MODEL: Readonly<Record<Provider, string>> = { claude: 'claude-haiku-5-5', gemini: 'gemini-3.5-flash-lite' };
const MODEL_VARIABLE: Readonly<Record<Provider, string>> = { claude: 'SMOKE_CLAUDE_MODEL', gemini: 'SMOKE_GEMINI_MODEL' };

export const REPO_ENV = resolve(import.meta.dirname, '..', '..', '..', '.env');

/** Values from the .env file (if it exists), with the process environment as the fallback. Nothing is printed. */
export function loadEnv(path: string = REPO_ENV, base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const fromFile = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) merged[k] = v;
  return { ...merged, ...Object.fromEntries(Object.entries(fromFile).filter(([, v]) => v !== undefined && v !== '')) } as Record<string, string>;
}

export interface SmokeRequest {
  readonly url: string;
  readonly headers: (key: string) => Record<string, string>;
  readonly body: unknown;
}

/** https://platform.claude.com/docs/en/build-with-claude/structured-outputs: the schema goes in output_config.format. */
export function claudeRequest(model: string): SmokeRequest {
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({ 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    body: {
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: PROMPT }],
      output_config: { format: { type: 'json_schema', schema: sceneJsonSchema('claude') } },
    },
  };
}

/** generateContent with responseJsonSchema, the field whose supported keywords the Gemini profile was built from. */
export function geminiRequest(model: string): SmokeRequest {
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers: (key) => ({ 'content-type': 'application/json', 'x-goog-api-key': key }),
    body: {
      contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: sceneJsonSchema('gemini'), maxOutputTokens: 4096 },
    },
  };
}

const REQUEST: Readonly<Record<Provider, (model: string) => SmokeRequest>> = { claude: claudeRequest, gemini: geminiRequest };

type Json = Record<string, any>;

/** The text of the first `text` content block. */
export const claudeText = (reply: Json | null): string | null =>
  (Array.isArray(reply?.content) ? (reply!.content as Json[]).find((b) => b?.type === 'text')?.text : null) ?? null;

/** The concatenated text parts of the first candidate. */
export const geminiText = (reply: Json | null): string | null => {
  const parts = reply?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? (parts as Json[]).map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : null;
};

const TEXT: Readonly<Record<Provider, (reply: Json | null) => string | null>> = { claude: claudeText, gemini: geminiText };

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/**
 * Sends one request to each requested provider and returns the lines to print. A line holds the provider, the HTTP
 * status and whether the reply parses, and nothing else: error bodies are not read.
 */
export async function runSmoke(env: Readonly<Record<string, string>>, send: Fetch, only: readonly Provider[] = PROVIDERS): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = [];
  let ok = true;
  for (const provider of only) {
    const key = env[KEY_VARIABLE[provider]];
    if (!key) {
      lines.push(`${provider}: skipped, ${KEY_VARIABLE[provider]} is not set`);
      ok = false;
      continue;
    }
    const request = REQUEST[provider](env[MODEL_VARIABLE[provider]] || DEFAULT_MODEL[provider]);
    try {
      const response = await send(request.url, { method: 'POST', headers: request.headers(key), body: JSON.stringify(request.body), signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        lines.push(`${provider}: HTTP ${response.status}, reply parses: no reply read`);
        ok = false;
        continue;
      }
      const text = TEXT[provider](await response.json().catch(() => null));
      const parses = text !== null && parseRawOutput(text).ok;
      lines.push(`${provider}: HTTP ${response.status}, reply parses: ${parses ? 'yes' : 'no'}`);
      ok &&= parses;
    } catch (error) {
      lines.push(`${provider}: request failed (${error instanceof Error ? error.name : 'error'})`);
      ok = false;
    }
  }
  return { lines, ok };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const only = args.length ? args.filter((a): a is Provider => (PROVIDERS as readonly string[]).includes(a)) : PROVIDERS;
  if (args.length && only.length !== args.length) {
    console.error('usage: smoke-schema [claude] [gemini]');
    process.exitCode = 2;
  } else {
    const { lines, ok } = await runSmoke(loadEnv(), fetch as unknown as Fetch, only);
    for (const line of lines) console.log(line);
    process.exitCode = ok ? 0 : 1;
  }
}
