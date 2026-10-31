/**
 * Smoke test for the structured-output schema profiles. NOT part of the study: it sends ONE request per provider,
 * with that provider's schema profile and a neutral prompt, and prints only the HTTP status and whether the reply
 * parses as JSON. It writes no tapes and prints no keys or response bodies.
 *
 *   pnpm --filter @kensho/scene-gate smoke-schema                       # claude and gemini
 *   pnpm --filter @kensho/scene-gate smoke-schema gemini                # one provider
 *   pnpm --filter @kensho/scene-gate smoke-schema gemini-interactions   # Gemini's /v1beta/interactions endpoint
 *   pnpm --filter @kensho/scene-gate smoke-schema gemini --diagnose     # on a non-2xx, also print the error message
 *
 * `--diagnose` is the only way an error body is read: it prints Google's or Anthropic's short `error.message`, cut to
 * 300 characters, with any key text removed. Nothing else from a body is printed.
 *
 * Keys are read from the repository's .env (or the environment): ANTHROPIC_API_KEY, and GEMINI_API_KEY or one of its
 * aliases (see KEY_VARIABLES), matched case-insensitively. Models can be overridden with SMOKE_CLAUDE_MODEL and
 * SMOKE_GEMINI_MODEL.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { sceneJsonSchema } from '../src/json-schema.ts';
import { parseRawOutput } from '../src/parse.ts';

export const PROMPT = 'an empty room with one crate';

export type Provider = 'claude' | 'gemini' | 'gemini-interactions';
/** What runs by default. The interactions endpoint is opt-in. */
export const PROVIDERS: readonly Provider[] = ['claude', 'gemini'];
const ALL_PROVIDERS: readonly Provider[] = ['claude', 'gemini', 'gemini-interactions'];

/** Accepted names for each key, first match wins. Gemini's own docs use GEMINI_API_KEY; its SDKs also read GOOGLE_API_KEY. */
export const KEY_VARIABLES: Readonly<Record<Provider, readonly string[]>> = {
  claude: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_KEY'],
  'gemini-interactions': ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_KEY'],
};

const DEFAULT_MODEL: Readonly<Record<Provider, string>> = { claude: 'claude-haiku-5-5', gemini: 'gemini-3.5-flash-lite', 'gemini-interactions': 'gemini-3.5-flash-lite' };
const MODEL_VARIABLE: Readonly<Record<Provider, string>> = { claude: 'SMOKE_CLAUDE_MODEL', gemini: 'SMOKE_GEMINI_MODEL', 'gemini-interactions': 'SMOKE_GEMINI_MODEL' };

export const REPO_ENV = resolve(import.meta.dirname, '..', '..', '..', '.env');

/** Values from the .env file (if it exists), with the process environment as the fallback. Nothing is printed. */
export function loadEnv(path: string = REPO_ENV, base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const fromFile = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) merged[k] = v;
  return { ...merged, ...Object.fromEntries(Object.entries(fromFile).filter(([, v]) => v !== undefined && v !== '')) } as Record<string, string>;
}

/** The value of the first accepted name that is set, matching names case-insensitively (an exact match wins). */
export function findKey(env: Readonly<Record<string, string>>, names: readonly string[]): string | undefined {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of names) {
    const exact = env[name];
    if (exact) return exact;
    const loose = lower.get(name.toLowerCase());
    if (loose) return loose;
  }
  return undefined;
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

/**
 * https://ai.google.dev/gemini-api/docs/structured-output documents structured output on the Interactions API: POST
 * /v1beta/interactions with `response_format: {type: 'text', mime_type: 'application/json', schema}`.
 */
export function interactionsRequest(model: string): SmokeRequest {
  return {
    url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
    headers: (key) => ({ 'content-type': 'application/json', 'x-goog-api-key': key }),
    body: { model, input: PROMPT, response_format: { type: 'text', mime_type: 'application/json', schema: sceneJsonSchema('gemini') } },
  };
}

const REQUEST: Readonly<Record<Provider, (model: string) => SmokeRequest>> = { claude: claudeRequest, gemini: geminiRequest, 'gemini-interactions': interactionsRequest };

type Json = Record<string, any>;

/** The text of the first `text` content block. */
export const claudeText = (reply: Json | null): string | null =>
  (Array.isArray(reply?.content) ? (reply!.content as Json[]).find((b) => b?.type === 'text')?.text : null) ?? null;

/** The concatenated text parts of the first candidate. */
export const geminiText = (reply: Json | null): string | null => {
  const parts = reply?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? (parts as Json[]).map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : null;
};

/**
 * The raw reply envelope of the Interactions API is not shown in its docs, so this takes the first string found under a
 * `text` or `output_text` key anywhere in the reply that parses as JSON, else the first such string.
 */
export function interactionsText(reply: Json | null): string | null {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === 'object' && node !== null) {
      for (const [k, v] of Object.entries(node)) {
        if ((k === 'text' || k === 'output_text') && typeof v === 'string') found.push(v);
        else walk(v);
      }
    }
  };
  walk(reply);
  return found.find((t) => parseRawOutput(t).ok) ?? found[0] ?? null;
}

const TEXT: Readonly<Record<Provider, (reply: Json | null) => string | null>> = { claude: claudeText, gemini: geminiText, 'gemini-interactions': interactionsText };

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'json'> & { text?: () => Promise<string> }>;

export interface SmokeOptions {
  /** On a non-2xx reply, also print the short error message from the body. */
  readonly diagnose?: boolean;
}

/** The `error.message` of an API error body, or its first 300 characters, with the key removed and whitespace collapsed. */
export function errorDetail(body: string, key: string): string {
  let message = body;
  try {
    const parsed = JSON.parse(body) as Json;
    const m = parsed?.error?.message ?? parsed?.message;
    if (typeof m === 'string') message = m;
  } catch {
    // not JSON: use the text as it is
  }
  return message.split(key).join('<key>').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Sends one request to each requested provider and returns the lines to print. A line holds the provider, the HTTP
 * status and whether the reply parses, and nothing else: error bodies are not read.
 */
export async function runSmoke(env: Readonly<Record<string, string>>, send: Fetch, only: readonly Provider[] = PROVIDERS, options: SmokeOptions = {}): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = [];
  let ok = true;
  for (const provider of only) {
    const names = KEY_VARIABLES[provider];
    const key = findKey(env, names);
    if (!key) {
      lines.push(`${provider}: skipped, ${names.length === 1 ? `${names[0]} is not set` : `none of ${names.join(', ')} is set`}`);
      ok = false;
      continue;
    }
    const request = REQUEST[provider](env[MODEL_VARIABLE[provider]] || DEFAULT_MODEL[provider]);
    try {
      const response = await send(request.url, { method: 'POST', headers: request.headers(key), body: JSON.stringify(request.body), signal: AbortSignal.timeout(180_000) });
      if (!response.ok) {
        lines.push(`${provider}: HTTP ${response.status}, reply parses: no reply read`);
        if (options.diagnose && response.text) lines.push(`  detail: ${errorDetail(await response.text().catch(() => ''), key)}`);
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
  const all = process.argv.slice(2);
  const diagnose = all.includes('--diagnose');
  const args = all.filter((a) => a !== '--diagnose');
  const only = args.length ? args.filter((a): a is Provider => (ALL_PROVIDERS as readonly string[]).includes(a)) : PROVIDERS;
  if (args.length && only.length !== args.length) {
    console.error('usage: smoke-schema [claude] [gemini] [gemini-interactions] [--diagnose]');
    process.exitCode = 2;
  } else {
    const { lines, ok } = await runSmoke(loadEnv(), fetch as unknown as Fetch, only, { diagnose });
    for (const line of lines) console.log(line);
    process.exitCode = ok ? 0 : 1;
  }
}
