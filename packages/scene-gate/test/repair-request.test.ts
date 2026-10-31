import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateValue } from '../src/check.ts';
import { REPAIR_PLACEHOLDERS, diagnosticsForModel, renderRepairMessage, sceneForModel, stripDraftHeader } from '../src/repair-request.ts';
import { SceneSchema } from '../src/schema.ts';
import { EXAMPLE_SCENE } from './fixtures.ts';

const TEMPLATE = readFileSync(join(import.meta.dirname, '..', 'prompts', 'repair.md'), 'utf8');
const scene = SceneSchema.parse(EXAMPLE_SCENE);
const diagnostics = evaluateValue(EXAMPLE_SCENE).diagnostics;
const PROMPT = 'A small arena with crates and five coins.';

describe('prompts/repair.md', () => {
  it('is marked DRAFT and has each placeholder exactly once', () => {
    expect(TEMPLATE.startsWith('<!-- DRAFT')).toBe(true);
    for (const placeholder of REPAIR_PLACEHOLDERS) expect(TEMPLATE.split(placeholder), placeholder).toHaveLength(2);
  });

  it('asks for the complete corrected scene, not a patch, and states the three objective rules', () => {
    const body = stripDraftHeader(TEMPLATE);
    expect(body).toContain('the complete JSON object, not a patch');
    expect(body).toContain('Fix every error listed above');
    expect(body).toContain('Do not remove any objective.');
    expect(body).toContain('Do not lower the `count` of any `collect` objective.');
    expect(body).toContain('Do not change the `tag` or the `type` of any objective.');
  });

  it("tells the model not to move an objective's target unless an UNRESOLVED_REF diagnostic names it, and says it where \"below\" is true", () => {
    const sentence = "Do not change an objective's target unless that target appears in an UNRESOLVED_REF diagnostic below.";
    expect(TEMPLATE.split(sentence)).toHaveLength(2);
    expect(TEMPLATE.indexOf(sentence)).toBeLessThan(TEMPLATE.indexOf('{{diagnostics}}'));
    expect(TEMPLATE.indexOf('{{scene}}')).toBeLessThan(TEMPLATE.indexOf(sentence));
  });

  it('names no check, threshold or rule of its own: those are in system.md and the findings', () => {
    expect(stripDraftHeader(TEMPLATE)).not.toMatch(/\bmm\b/);
  });
});

describe('the rendered repair message', () => {
  const message = renderRepairMessage(TEMPLATE, { prompt: PROMPT, scene, diagnostics });

  it('contains the original prompt, the scene JSON and the diagnostics, and no placeholder or draft header', () => {
    expect(message).toContain(PROMPT);
    expect(message).toContain(sceneForModel(scene));
    expect(message).toContain(diagnosticsForModel(diagnostics));
    expect(message).not.toMatch(/\{\{|\}\}/);
    expect(message).not.toContain('DRAFT');
    expect(message.startsWith('A scene you wrote')).toBe(true);
  });

  it('shows each diagnostic as code, pointer, message and evidence only', () => {
    const shown = JSON.parse(diagnosticsForModel(diagnostics)) as Record<string, unknown>[];
    expect(shown).toHaveLength(2);
    for (const d of shown) expect(Object.keys(d).sort()).toEqual(['code', 'evidence', 'message', 'pointer']);
    expect(shown.map((d) => d.pointer)).toEqual(['/entities/3/guards/0', '/objectives/0/count']);
    expect(message).toContain('"expected_kind": "any"');
  });

  it('shows the scene as indented JSON that parses back to the same scene', () => {
    expect(JSON.parse(sceneForModel(scene))).toEqual(scene);
    expect(sceneForModel(scene)).toContain('\n  "entities": [');
  });

  it('is deterministic', () => {
    expect(renderRepairMessage(TEMPLATE, { prompt: PROMPT, scene, diagnostics })).toBe(message);
  });

  it('fills placeholders in one pass, so text inside a value is never expanded', () => {
    const tricky = renderRepairMessage(TEMPLATE, { prompt: 'literal {{scene}} and {{diagnostics}} and $& and $1', scene, diagnostics });
    expect(tricky).toContain('literal {{scene}} and {{diagnostics}} and $& and $1');
    expect(tricky.split(sceneForModel(scene))).toHaveLength(2);
  });

  it('sends no severity and no fix, because the checker does not produce one', () => {
    expect(message).not.toContain('"severity"');
  });
});
