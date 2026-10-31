import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { priceFor } from '../src/spend.ts';
import { SAMPLES_PER_PROMPT, STUDY_MAX_OUTPUT_TOKENS, STUDY_MODELS, STUDY_PARAMETERS } from '../src/study.ts';

const text = readFileSync(join(import.meta.dirname, '..', 'PREREGISTRATION.md'), 'utf8');

describe('the study constants match the preregistration', () => {
  it('names the two models, each with a recorded price', () => {
    expect(STUDY_MODELS).toEqual(['gemini-3.5-flash-lite', 'gemini-3.8-flash']);
    STUDY_MODELS.forEach((m, i) => {
      expect(text).toContain(`| ${i + 1} | \`${m}\` |`);
      expect(() => priceFor(m, new Date('2026-11-01T00:00:00Z'))).not.toThrow();
    });
  });

  it('sets only maxOutputTokens, to 16384, and omits temperature, top-p, top-k, seed and thinking', () => {
    expect(STUDY_MAX_OUTPUT_TOKENS).toBe(16_384);
    expect(Object.keys(STUDY_PARAMETERS)).toEqual(['max_output_tokens']);
    expect(text).toContain(`| \`maxOutputTokens\` | ${STUDY_MAX_OUTPUT_TOKENS} |`);
    expect(text).toContain('Thinking tokens **count against it**');
    expect(text).toContain('https://ai.google.dev/gemini-api/docs/thinking');
    expect(text).toContain('including thought tokens');
  });

  it('runs 3 samples of each of 20 prompts', () => {
    expect(SAMPLES_PER_PROMPT).toBe(3);
    expect(text).toContain(`20 prompts x ${SAMPLES_PER_PROMPT} runs per model = ${20 * SAMPLES_PER_PROMPT} scene generations per model`);
  });
});
