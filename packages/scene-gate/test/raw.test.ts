import { describe, expect, it } from 'vitest';
import { evaluateRaw } from '../src/check.ts';
import { parseRawOutput } from '../src/parse.ts';
import { verdictOf } from '../src/verdict.ts';
import { cleanScene } from './fixtures.ts';

const text = JSON.stringify(cleanScene());

describe('raw model output', () => {
  it('parses one JSON document and runs the checks', () => {
    const e = evaluateRaw(text);
    expect(e.kind).toBe('checked');
    expect(verdictOf(e)).toBe('pass');
  });

  it('reports a truncated scene as schema_invalid / truncated', () => {
    const e = evaluateRaw(text.slice(0, 400));
    expect(e).toMatchObject({ kind: 'schema_invalid', reason: 'truncated' });
    expect(verdictOf(e)).toBe('schema_invalid');
    expect(e.diagnostics.map((d) => [d.code, d.pointer])).toEqual([['SCHEMA_INVALID', '']]);
  });

  it('reports a cut inside a string as truncated too', () => {
    expect(evaluateRaw('{"scene":"scene-ga')).toMatchObject({ reason: 'truncated' });
  });

  it('reports prose with no object as a refusal', () => {
    const e = evaluateRaw("I'm sorry, but I can't help with that request.");
    expect(e).toMatchObject({ kind: 'schema_invalid', reason: 'refusal' });
  });

  it('trusts the provider stop reason only when the text does not parse', () => {
    expect(evaluateRaw('{"scene": ', {}, 'refusal')).toMatchObject({ reason: 'refusal' });
    expect(evaluateRaw('{"scene": ', {}, 'length')).toMatchObject({ reason: 'truncated' });
    expect(evaluateRaw(text, {}, 'refusal').kind).toBe('checked');
  });

  it('reports unparseable text that is complete as unparseable', () => {
    expect(evaluateRaw('{"scene": scene-gate/1}')).toMatchObject({ reason: 'unparseable' });
  });

  it('does not strip code fences or surrounding prose', () => {
    expect(evaluateRaw('```json\n' + text + '\n```')).toMatchObject({ reason: 'unparseable' });
    expect(evaluateRaw('Here is your scene: ' + text)).toMatchObject({ reason: 'unparseable' });
  });

  it('reports empty output', () => {
    expect(evaluateRaw('  \n')).toMatchObject({ kind: 'schema_invalid', reason: 'empty' });
  });

  it('reports valid JSON that is not a scene as a schema problem with pointers', () => {
    const e = evaluateRaw('{"scene":"scene-gate/1","entities":[{"id":"a","kind":"static","box_mm":[1,1,1]}]}');
    expect(e).toMatchObject({ kind: 'schema_invalid', reason: 'schema' });
    expect(e.diagnostics.every((d) => d.code === 'SCHEMA_INVALID')).toBe(true);
    expect(e.diagnostics.map((d) => d.pointer)).toContain('/entities/0/pos_mm');
    expect(e.diagnostics.map((d) => d.pointer)).toContain('/bounds_mm');
  });

  it('keeps SCHEMA_INVALID apart from the semantic codes', () => {
    const semantic = evaluateRaw(JSON.stringify({ ...cleanScene(), objectives: [{ id: 'o', type: 'collect', tag: 'coin', count: 9 }] }));
    expect(semantic.diagnostics.map((d) => d.code)).toEqual(['OBJECTIVE_COUNT']);
    expect(verdictOf(semantic)).toBe('fail');
  });

  it('parseRawOutput accepts any JSON value; the schema decides what is a scene', () => {
    expect(parseRawOutput('42')).toEqual({ ok: true, value: 42 });
    expect(evaluateRaw('42')).toMatchObject({ reason: 'schema' });
  });
});
