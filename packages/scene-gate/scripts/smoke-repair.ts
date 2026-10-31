/**
 * Smoke test for the repair round. NOT part of the study: it sends ONE repair request per model, built exactly as the
 * study builds it (prompts/system.md as the system message, prompts/repair.md rendered as the user message, the provider's
 * schema profile for the reply), for a fixture scene with one known error that is not one of the 20 prompts. It prints
 * one line per model: the HTTP status, whether the reply parses, and what the acceptance rule decided. It writes no
 * tapes and prints no keys, response bodies or error bodies.
 *
 *   pnpm --filter @kensho/scene-gate smoke-repair gemini-3.5-flash-lite gemini-3.8-flash
 *
 * `--diagnose` also prints the short error message of a non-2xx reply, as in smoke-schema.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateValue } from '../src/check.ts';
import type { Diagnostic } from '../src/diagnostic.ts';
import { sceneJsonSchema } from '../src/json-schema.ts';
import { parseRawOutput } from '../src/parse.ts';
import { repairFromScene } from '../src/repair.ts';
import { renderRepairMessage } from '../src/repair-request.ts';
import { SceneSchema, type Scene } from '../src/schema.ts';
import { KEY_VARIABLES, errorDetail, findKey, geminiText, loadEnv, type Fetch } from './smoke-schema.ts';

const PACKAGE = resolve(import.meta.dirname, '..');

/** Not one of the 20 prompts. */
export const FIXTURE_PROMPT = 'a small room with one crate and one coin to collect';

/** A valid scene whose only error is a crate hanging 1.6 m above the floor (UNSUPPORTED_DYNAMIC at /entities/0/pos_mm). */
export const FIXTURE_SCENE: Scene = SceneSchema.parse({
  scene: 'scene-gate/1',
  bounds_mm: [-5000, 0, -5000, 5000, 3000, 5000],
  controller: { height_mm: 1800, radius_mm: 300, jump_height_mm: 1200 },
  spawn: { pos_mm: [0, 0, -3000] },
  entities: [
    { id: 'crate_1', kind: 'dynamic', box_mm: [800, 800, 800], pos_mm: [1500, 2000, 0] },
    { id: 'coin_1', kind: 'pickup', tags: ['coin'], box_mm: [300, 300, 60], pos_mm: [-1500, 600, 0] },
  ],
  rules: [],
  objectives: [{ id: 'o1', type: 'collect', tag: 'coin', count: 1 }],
});

export const fixtureDiagnostics = (): Diagnostic[] => evaluateValue(FIXTURE_SCENE).diagnostics;

export const readSystem = (): string => readFileSync(resolve(PACKAGE, 'prompts', 'system.md'), 'utf8');
export const readRepairTemplate = (): string => readFileSync(resolve(PACKAGE, 'prompts', 'repair.md'), 'utf8');

/** generateContent with the system message, the rendered repair message and the Gemini schema profile for the reply. */
export function geminiRepairRequest(model: string, system: string, message: string) {
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers: (key: string) => ({ 'content-type': 'application/json', 'x-goog-api-key': key }),
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: message }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: sceneJsonSchema('gemini'), maxOutputTokens: 8192 },
    },
  };
}

export interface RepairSmokeInput {
  readonly system: string;
  readonly template: string;
}

/** One repair request per model; returns the lines to print. */
export async function runRepairSmoke(
  env: Readonly<Record<string, string>>,
  send: Fetch,
  models: readonly string[],
  input: RepairSmokeInput,
  options: { diagnose?: boolean } = {},
): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = [];
  let ok = true;
  const key = findKey(env, KEY_VARIABLES.gemini);
  if (!key) return { lines: [`gemini repair: skipped, none of ${KEY_VARIABLES.gemini.join(', ')} is set`], ok: false };
  const message = renderRepairMessage(input.template, { prompt: FIXTURE_PROMPT, scene: FIXTURE_SCENE, diagnostics: fixtureDiagnostics() });
  for (const model of models) {
    const request = geminiRepairRequest(model, input.system, message);
    try {
      const response = await send(request.url, { method: 'POST', headers: request.headers(key), body: JSON.stringify(request.body), signal: AbortSignal.timeout(180_000) });
      if (!response.ok) {
        lines.push(`${model} repair: HTTP ${response.status}, reply parses: no reply read`);
        if (options.diagnose && response.text) lines.push(`  detail: ${errorDetail(await response.text().catch(() => ''), key)}`);
        ok = false;
        continue;
      }
      const text = geminiText(await response.json().catch(() => null));
      const reply = text === null ? null : parseRawOutput(text);
      if (!reply?.ok) {
        lines.push(`${model} repair: HTTP ${response.status}, reply parses: no`);
        ok = false;
        continue;
      }
      const result = repairFromScene(FIXTURE_SCENE, reply.value);
      const outcome = result.status === 'accepted' ? `accepted, ${result.after.length === 0 ? 'scene passes' : 'errors remain'}` : `refused (${result.reason})`;
      lines.push(`${model} repair: HTTP ${response.status}, reply parses: yes, ${outcome}, ${result.ops ?? 'no'} ops`);
      ok &&= result.status === 'accepted';
    } catch (error) {
      lines.push(`${model} repair: request failed (${error instanceof Error ? error.name : 'error'})`);
      ok = false;
    }
  }
  return { lines, ok };
}

if (import.meta.main) {
  const all = process.argv.slice(2);
  const diagnose = all.includes('--diagnose');
  const models = all.filter((a) => a !== '--diagnose');
  if (!models.length) {
    console.error('usage: smoke-repair <gemini-model-id>... [--diagnose]');
    process.exitCode = 2;
  } else {
    const { lines, ok } = await runRepairSmoke(loadEnv(), fetch as unknown as Fetch, models, { system: readSystem(), template: readRepairTemplate() }, { diagnose });
    for (const line of lines) console.log(line);
    process.exitCode = ok ? 0 : 1;
  }
}
