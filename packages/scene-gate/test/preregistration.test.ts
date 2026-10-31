import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPrompts } from '../src/harness.ts';
import { OVERLAP_TOLERANCE_MM, SUPPORT_TOLERANCE_MM } from '../src/thresholds.ts';
import { TRANSPORT_POLICY, retryDelayMs } from '../src/transport.ts';
import { recordedHashes } from '../src/study-run.ts';
import { sha256Hex } from '../src/verdict.ts';

const PACKAGE = join(import.meta.dirname, '..');
const text = readFileSync(join(PACKAGE, 'PREREGISTRATION.md'), 'utf8');
const prompts = loadPrompts(join(PACKAGE, 'prompts', 'prompts.json'));

describe('the preregistration', () => {
  it('is frozen, names the tag of the frozen commit, and has no open slot left', () => {
    expect(text).toContain('**Status: FROZEN.**');
    expect(text).not.toMatch(/Status: DRAFT/);
    expect(text).not.toMatch(/\bTBD\b/);
    expect(text.split('`scene-gate-prereg-v2`').length - 1).toBeGreaterThanOrEqual(3);
    expect(text).toContain('| Commit | the commit tagged `scene-gate-prereg-v2` |');
    expect(text).toContain('**Status: FROZEN.** This preregistration is frozen at the commit that carries the git tag `scene-gate-prereg-v2`');
  });

  it('records the models page, the date it was read, and no 1.5 model', () => {
    expect(text).toContain('https://ai.google.dev/gemini-api/docs/models');
    expect(text).toContain('2026-11-01');
    expect(text).not.toMatch(/gemini-1\.5/);
    for (const id of text.match(/`gemini-[a-z0-9.-]+`/g) ?? []) expect(id).not.toMatch(/gemini-1\./);
  });

  it('records both models and the frozen commit, and the hash of each prompt file', () => {
    expect(text).toMatch(/\| 1 \| `gemini-3\.5-flash-lite` \|/);
    expect(text).toMatch(/\| 2 \| `gemini-3\.8-flash` \|/);
    for (const slot of ['Commit', 'SHA-256 of `prompts.json`', 'SHA-256 of `system.md`', 'SHA-256 of `repair.md`']) expect(text, slot).toContain(slot);
  });

  it('omits temperature, thinking, top-p, top-k and seed, logs usage per tape, and caps spend at $10', () => {
    expect(text).toContain('**temperature, top-p, top-k, seed and thinking are all omitted**');
    expect(text).toContain('**Usage is logged per tape.**');
    expect(text).toContain('**Spend cap: $10, a hard stop.**');
    expect(text).toContain('https://ai.google.dev/gemini-api/docs/pricing');
  });

  it('states that there is no human labelling, as a limit', () => {
    expect(text).toContain('**No human labelling.**');
  });

  it('describes repair as a full corrected scene whose patch is computed with compare, and records its size', () => {
    expect(text).toContain("computed in code with fast-json-patch's `compare`");
    expect(text).toContain('The model never writes a patch.');
    expect(text).toContain('M6');
    expect(text).toContain('`prompts/repair.md`');
  });

  it('states 20 prompts x 3 runs and matches the prompts file', () => {
    expect(prompts.prompts).toHaveLength(20);
    expect(text).toContain('20 prompts x 3 runs per model = 60 scene generations per model');
    expect(text).toContain('10 ordinary');
    expect(text).toContain('10 structured');
  });

  it('records the SHA-256 of prompts.json, system.md and repair.md, and they are the files as they are now', () => {
    for (const [label, file] of [['prompts.json', 'prompts.json'], ['system.md', 'system.md'], ['repair.md', 'repair.md']] as const) {
      const row = new RegExp(`\\| SHA-256 of \`${label.replace('.', '\\.')}\` \\| \`([0-9a-f]{64})\` \\|`).exec(text);
      expect(row, label).not.toBeNull();
      expect(row![1], `${label}: edit the file or the recorded hash on purpose, not by accident`).toBe(sha256Hex(readFileSync(join(PACKAGE, 'prompts', file), 'utf8')));
    }
  });

  it('states the transport policy the code implements', () => {
    expect(text).toContain(`**Timeout:** ${TRANSPORT_POLICY.timeoutMs / 1000} s per attempt.`);
    expect(text).toContain(`up to ${TRANSPORT_POLICY.maxRetries} retries, so at most ${TRANSPORT_POLICY.maxRetries + 1} attempts`);
    expect(text).toContain([0, 1, 2].map((n) => `${retryDelayMs(n) / 1000} s`).join(', ').replace(/, (\d+ s)$/, ' and $1'));
    expect(text).toContain('**only** after HTTP 429, 500, 502, 503 or 504, a timeout, or a network error');
    expect(text).toContain('**Never retried:** any 4xx other than 429, and any reply that arrived.');
    expect(text).toContain('**Every attempt is logged on the tape**');
    expect(text).toContain('`outcome: transport_failure`');
    expect(text).toContain('**reported separately from `SCHEMA_INVALID`**');
    expect(text).toContain('**kept in every denominator**');
    expect(text).toContain('**never regenerated**');
    expect(text).toContain('exceed 10% of its 60 planned generations (7 or more)');
    expect(text).toContain('reported **incomplete**');
  });

  it('counts every attempt toward the cap, at the worst case when no usage came back', () => {
    expect(text).toContain('**every attempt counted**');
    expect(text).toContain('counts at the worst case');
    expect(text).toContain('$0.04276');
    expect(text).toContain('$0.06594');
  });

  it('quotes the thresholds the code uses and keeps the optional check off', () => {
    expect(text).toContain(`${OVERLAP_TOLERANCE_MM} mm overlap, ${SUPPORT_TOLERANCE_MM} mm support`);
    expect(text).toContain('is **off**');
  });

  it('defines every metric and says it has a single repair round', () => {
    for (const m of ['M1', 'M2', 'M3', 'M4', 'M5']) expect(text).toContain(m);
    expect(text).toContain('exactly one repair round');
    expect(text).toContain('no early stopping');
  });

  it('carries the disclosure verbatim', () => {
    expect(text).toContain('I wrote the specification and set the thresholds; Claude Code wrote the code and tests under my direction.');
  });
});

describe('the preregistration of the study driver', () => {
  it('records the command, the tape path and the three conditions the command refuses without', () => {
    expect(text).toContain('pnpm --filter @kensho/scene-gate study --tapes packages/scene-gate/tapes');
    expect(text).toContain('packages/scene-gate/tapes/<model>/<prompt_id>/<sample>.{generate,repair}.json');
    expect(text).toContain('equal the three recorded in section 3');
    expect(text).toContain('the working tree is clean (the tapes directory aside');
    expect(text).toContain('HEAD is the commit tagged `scene-gate-prereg-v2`');
    expect(text).toContain('Every tape records the git commit it was made from.');
  });

  it('records the fixed order and the one shared ledger', () => {
    expect(text).toContain('against **one** spend ledger for both models');
    expect(text).toContain('generation for `gemini-3.5-flash-lite`, then for `gemini-3.8-flash`');
    expect(text).toContain('then one repair round for each model in the same order');
    expect(text).toContain('a request that already has a tape is skipped'.replace('a request', 'A request'));
  });

  it('records that v1 was tagged locally, superseded before publication and before any generation, and why', () => {
    expect(text).toContain('`scene-gate-prereg-v1` was tagged locally on 1 November 2026 and superseded before publication and before any study generation');
    expect(text).toContain('It had no study driver');
    expect(text).toContain('The three SHA-256 in section 3 are unchanged from `scene-gate-prereg-v1`');
  });

  it('keeps the three prompt hashes exactly as they were in v1', () => {
    expect(recordedHashes(text)).toEqual({
      'prompts.json': 'd63407a796f967b402985665fb77f0f9c096916e147c34ae7ff288a3cedee26f',
      'system.md': '09ff30a17d6e4590df4f1b91eaa224174eb4da94bf871e7e0a1031eb72bf415a',
      'repair.md': '1e9b2f37737e9a7a3a880a114b2a55cff7c4800d1ee46905db59293142a3fd9e',
    });
  });

  it('states as a limit that the two models differ in default thinking', () => {
    expect(text).toContain('**The two models differ in default thinking**');
    expect(text).toContain('`gemini-3.5-flash-lite` defaults to minimal thinking and `gemini-3.8-flash` to thinking on');
  });
});
